import { Client, Databases, Models, Query, Messaging, ID } from 'node-appwrite';
import nodeFetch from 'node-fetch';

// Define interfaces
interface WebhookPayload {
  events: string[];
  document: Models.Document;
  $collectionId?: string;
  [key: string]: any;
}

interface PostDocument extends Models.Document {
  authorId: string;
  authorName?: string;
  title?: string;
  content?: string;
  image?: string | null;
}

interface CommentDocument extends Models.Document {
  userId: string;
  authorName?: string;
  postId: string;
  content?: string;
}

interface EnhancedNotificationData extends NotificationData {
  authorName?: string;
  authorImage?: string | null;
  postImage?: string | null;
  postTitle?: string;
  commentContent?: string;
}

interface NotificationData {
  userIds: string[];
  title: string;
  body: string;
  postId: string;
  type: 'new_post' | 'new_comment';
}

interface FunctionContext {
  req: {
    body: string;
    headers: Record<string, string>;
    method: string;
    path: string;
  };
  res: {
    json: (data: any, status?: number) => void;
  };
  log: (msg: string) => void;
  error: (msg: string) => void;
}

module.exports = async ({ req, res, log, error }: FunctionContext) => {
  if (!process.env.APPWRITE_PROJECT_ID) {
    error('APPWRITE_PROJECT_ID is not defined');
    return res.json({ ok: false, error: 'APPWRITE_PROJECT_ID is not defined' }, 500);
  }

  if (!process.env.APPWRITE_API_KEY) {
    error('APPWRITE_API_KEY is not defined');
    return res.json({ ok: false, error: 'APPWRITE_API_KEY is not defined' }, 500);
  }

  const client = new Client()
    .setEndpoint('https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  log(`Client initialized with project ID: ${process.env.APPWRITE_PROJECT_ID}`);

  const databases = new Databases(client);
  const messaging = new Messaging(client);

  try {
    log(`Raw req.body: ${req.body} (type: ${typeof req.body})`);

    let webhookPayload: WebhookPayload;
    try {
      if (typeof req.body === 'string') {
        const cleanedBody = req.body.replace(/^"|"$/g, '').replace(/\\"/g, '"');
        log(`Cleaned req.body: ${cleanedBody}`);
        try {
          webhookPayload = JSON.parse(cleanedBody);
        } catch (err) {
          log(`Failed to parse req.body as JSON, constructing payload manually`);
          webhookPayload = {
            userIds: ["6899b68b00337f047f35"],
            title: "Test Notification",
            body: cleanedBody,
            postId: "6897373f0013ebd5a0c6",
            type: "new_post",
            events: [],
            document: {} as Models.Document
          };
        }
      } else if (typeof req.body === 'object' && req.body !== null) {
        webhookPayload = req.body;
      } else {
        throw new Error('Invalid request body format');
      }
    } catch (err) {
      throw new Error(`Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`);
    }

    log(`Parsed webhook payload: ${JSON.stringify(webhookPayload)}`);

    // Handle webhook events based on collection ID
    if (webhookPayload.$collectionId === process.env.POSTS_COLLECTION_ID) {
      // For webhook events, the document data is directly in the payload
      const documentData = webhookPayload.document || webhookPayload;
      return await handleNewPost(documentData as PostDocument, databases, messaging, log, error, res);
    } else if (webhookPayload.$collectionId === process.env.COMMENTS_COLLECTION_ID) {
      // For webhook events, the document data is directly in the payload
      const documentData = webhookPayload.document || webhookPayload;
      return await handleNewComment(documentData as CommentDocument, databases, messaging, log, error, res);
    } else {
      // Handle direct function calls (not webhook events)
      return await handleDirectCall(webhookPayload, messaging, log, error, res);
    }
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Failed to process request: ${errorMsg}`);
    return res.json({ ok: false, error: errorMsg }, 500);
  }
};

async function handleNewPost(
  postDocument: PostDocument,
  databases: Databases,
  messaging: Messaging,
  log: (msg: string) => void,
  error: (msg: string) => void,
  res: { json: (data: any, status?: number) => void }
) {
  try {
    log(`Post document: ${JSON.stringify(postDocument)}`);
    const databaseId = process.env.APPWRITE_DATABASE_ID || 'default';
    const usersCollectionId = process.env.USERS_COLLECTION_ID || 'users_collection';

    // Get author information
    const author = await databases.getDocument(databaseId, usersCollectionId, postDocument.authorId);
    const authorName = author.name || 'Someone';
    const authorImage = author.image || null;

    // Get all users except the post author
    const users = await databases.listDocuments(databaseId, usersCollectionId, [Query.limit(100)]);
    const userIds = users.documents
      .map((user: Models.Document) => user.$id)
      .filter((userId: string) => userId !== postDocument.authorId);

    if (userIds.length === 0) {
      log('No users to notify for new post');
      return res.json({ ok: true, message: 'No users to notify' }, 200);
    }

    // Create rich notification content
    const title = 'New Post'; // Removed 📝 emoji
    let body = `${authorName} shared a new post`;
    
    if (postDocument.title) {
      body += `: "${postDocument.title}"`;
    } else if (postDocument.content) {
      const preview = postDocument.content.length > 60 
        ? postDocument.content.slice(0, 60) + '...' 
        : postDocument.content;
      body += `: "${preview}"`;
    }

    const notificationData: EnhancedNotificationData = {
      userIds,
      title,
      body,
      postId: postDocument.$id,
      type: 'new_post',
      authorName,
      authorImage, // Cloudinary URL for user profile image
      postImage: postDocument.image, // Cloudinary URL for post image
      postTitle: postDocument.title
    };

    return await sendPushNotifications(notificationData, messaging, log, error, res);
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Error handling new post: ${errorMsg}`);
    return res.json({ ok: false, error: errorMsg }, 500);
  }
}

async function handleNewComment(
  commentDocument: CommentDocument,
  databases: Databases,
  messaging: Messaging,
  log: (msg: string) => void,
  error: (msg: string) => void,
  res: { json: (data: any, status?: number) => void }
) {
  try {
    log(`Comment document: ${JSON.stringify(commentDocument)}`);
    const databaseId = process.env.APPWRITE_DATABASE_ID || 'default';
    const postsCollectionId = process.env.POSTS_COLLECTION_ID || '6896fbb2003568eb4840';
    const usersCollectionId = process.env.USERS_COLLECTION_ID || 'users_collection';

    // Get the post and commenter information
    const [post, commenter] = await Promise.all([
      databases.getDocument(databaseId, postsCollectionId, commentDocument.postId),
      databases.getDocument(databaseId, usersCollectionId, commentDocument.userId)
    ]);
    
    if (post.authorId === commentDocument.userId) {
      log('Comment author is the same as post author, no notification needed');
      return res.json({ ok: true, message: 'No notification needed - same user' }, 200);
    }

    const userIds = [post.authorId];
    const commenterName = commenter.name || 'Someone';
    const commenterImage = commenter.image || null;

    // Create rich notification content
    const title = 'New Comment'; // Removed 💬 emoji
    let body = `${commenterName} commented on your post`;
    
    if (post.title) {
      body += `: "${post.title}"`;
    } else if (post.content) {
      const preview = post.content.length > 40 
        ? post.content.slice(0, 40) + '...' 
        : post.content;
      body += `: "${preview}"`;
    }

    const notificationData: EnhancedNotificationData = {
      userIds,
      title,
      body,
      postId: commentDocument.postId,
      type: 'new_comment',
      authorName: commenterName,
      authorImage: commenterImage, // Cloudinary URL for commenter profile image
      postImage: post.image, // Cloudinary URL for post image
      postTitle: post.title,
      commentContent: commentDocument.content
    };

    return await sendPushNotifications(notificationData, messaging, log, error, res);
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Error handling new comment: ${errorMsg}`);
    return res.json({ ok: false, error: errorMsg }, 500);
  }
}

async function handleDirectCall(
  payload: WebhookPayload,
  messaging: Messaging,
  log: (msg: string) => void,
  error: (msg: string) => void,
  res: { json: (data: any, status?: number) => void }
) {
  const { userIds, title, body, postId, type } = payload;

  if (!userIds || !title || !body || !postId || !type) {
    throw new Error('Missing required fields: userIds, title, body, postId, type');
  }

  return await sendPushNotifications({ userIds, title, body, postId, type }, messaging, log, error, res);
}

async function sendPushNotifications(
  notificationData: EnhancedNotificationData,
  messaging: Messaging,
  log: (msg: string) => void,
  error: (msg: string) => void,
  res: { json: (data: any, status?: number) => void }
) {
  const { userIds, title, body, postId, type, authorName, authorImage, postImage, postTitle, commentContent } = notificationData;

  log(`Sending ${type} notification to users: ${userIds.join(', ')}`);

  try {
    // Get push tokens for the users from database
    const pushTokens = await getUserPushTokens(userIds, log, error);
    
    if (pushTokens.length === 0) {
      log('No push tokens found for the specified users');
      return res.json({ ok: true, message: 'No push tokens found', sentTo: 0 }, 200);
    }

    log(`Found ${pushTokens.length} push tokens for ${userIds.length} users`);

    // Enhanced Expo Push Notification payload
    const expoPayload = {
      to: pushTokens,
      title,
      body,
      data: { 
        postId, 
        type,
        authorName,
        authorImage, // Include user profile image URL
        postImage, // Include post image URL
        postTitle,
        commentContent,
        screen: type === 'new_post' ? 'PostDetails' : 'PostDetails',
        params: { postId }
      },
      badge: 1,
      sound: 'default',
      priority: 'high',
      // Include both images in attachments for Android
      attachments: [
        ...(authorImage ? [{ url: authorImage, type: 'image' }] : []),
        ...(postImage ? [{ url: postImage, type: 'image' }] : [])
      ]
    };

    log(`Enhanced Expo payload: ${JSON.stringify(expoPayload)}`);

    const response = await nodeFetch(new URL('https://exp.host/--/api/v2/push/send'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.EXPO_ACCESS_TOKEN}`,
      },
      body: JSON.stringify(expoPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      error(`Expo API error: ${errorText}`);
      return res.json({ ok: false, error: errorText }, 500);
    }

    const result = await response.json();
    log(`Successfully sent enhanced notifications: ${JSON.stringify(result)}`);
    
    return res.json({ 
      ok: true, 
      messageId: result.data?.[0]?.id, 
      sentTo: pushTokens.length,
      tokensUsed: pushTokens.length,
      notificationData: {
        title,
        body,
        authorName,
        hasAuthorImage: !!authorImage,
        hasPostImage: !!postImage
      }
    }, 200);
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Error sending push notification: ${errorMsg}`);
    return res.json({ ok: false, error: errorMsg }, 500);
  }
}

async function getUserPushTokens(
  userIds: string[],
  log: (msg: string) => void,
  error: (msg: string) => void
): Promise<string[]> {
  try {
    // Initialize client and database for getting push tokens
    const client = new Client()
      .setEndpoint('https://cloud.appwrite.io/v1')
      .setProject(process.env.APPWRITE_PROJECT_ID!)
      .setKey(process.env.APPWRITE_API_KEY!);

    const databases = new Databases(client);
    const databaseId = process.env.APPWRITE_DATABASE_ID || 'default';
    
    // You can either store push tokens in:
    // Option 1: A separate pushTokens collection
    // Option 2: As a field in your users collection
    
    // Option 1: Using a separate pushTokens collection (recommended)
    const pushTokensCollectionId = process.env.PUSH_TOKENS_COLLECTION_ID || 'push_tokens';
    
    try {
      const pushTokenDocs = await databases.listDocuments(
        databaseId, 
        pushTokensCollectionId, 
        [
          Query.contains('userId', userIds),
          Query.limit(100)
        ]
      );

      const tokens = pushTokenDocs.documents
        .map((doc: any) => doc.pushToken)
        .filter((token: string) => token && token.trim() !== '');

      log(`Found ${tokens.length} push tokens from pushTokens collection`);
      return tokens;
    } catch (pushTokenError) {
      log(`PushTokens collection not found, trying users collection...`);
      
      // Option 2: Fallback to users collection with pushToken field
      const usersCollectionId = process.env.USERS_COLLECTION_ID || 'users_collection';
      
      const userDocs = await databases.listDocuments(
        databaseId,
        usersCollectionId,
        [
          Query.contains('$id', userIds),
          Query.limit(100)
        ]
      );

      const tokens = userDocs.documents
        .map((user: any) => user.pushToken || user.expoPushToken)
        .filter((token: string) => token && token.trim() !== '');

      log(`Found ${tokens.length} push tokens from users collection`);
      return tokens;
    }
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Error fetching push tokens: ${errorMsg}`);
    return [];
  }
}
