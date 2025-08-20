const { Client, Databases, Models, Query, Messaging, ID } = require('node-appwrite');

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

interface NotificationData {
  userIds: string[];
  title: string;
  body: string;
  postId: string;
  type: 'new_post' | 'new_comment';
  authorName?: string;
  authorImage?: string | null;
  postImage?: string | null;
  postTitle?: string;
  commentContent?: string;
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
      const documentData = webhookPayload.document || webhookPayload;
      return await handleNewPost(documentData as PostDocument, databases, messaging, log, error, res);
    } else if (webhookPayload.$collectionId === process.env.COMMENTS_COLLECTION_ID) {
      const documentData = webhookPayload.document || webhookPayload;
      return await handleNewComment(documentData as CommentDocument, databases, messaging, log, error, res);
    } else {
      // Handle direct function calls
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
    const databaseId = process.env.APPWRITE_DATABASE_ID || '6896f984003d36dd03a0';
    const usersCollectionId = process.env.USERS_COLLECTION_ID || '6896fb860037b66180f3';

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

    // Create notification content
    const title = '📝 New Post';
    let body = `${authorName} shared a new post`;
    
    if (postDocument.title) {
      body += `: "${postDocument.title}"`;
    } else if (postDocument.content) {
      const preview = postDocument.content.length > 60 
        ? postDocument.content.slice(0, 60) + '...' 
        : postDocument.content;
      body += `: "${preview}"`;
    }

    const notificationData: NotificationData = {
      userIds,
      title,
      body,
      postId: postDocument.$id,
      type: 'new_post',
      authorName,
      authorImage,
      postImage: postDocument.image,
      postTitle: postDocument.title
    };

    return await sendAppwriteNotifications(notificationData, messaging, log, error, res);
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
    const databaseId = process.env.APPWRITE_DATABASE_ID || '6896f984003d36dd03a0';
    const postsCollectionId = process.env.POSTS_COLLECTION_ID || '6896fbb2003568eb4840';
    const usersCollectionId = process.env.USERS_COLLECTION_ID || '6896fb860037b66180f3';

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

    // Create notification content
    const title = '💬 New Comment';
    let body = `${commenterName} commented on your post`;
    
    if (post.title) {
      body += `: "${post.title}"`;
    } else if (post.content) {
      const preview = post.content.length > 40 
        ? post.content.slice(0, 40) + '...' 
        : post.content;
      body += `: "${preview}"`;
    }

    const notificationData: NotificationData = {
      userIds,
      title,
      body,
      postId: commentDocument.postId,
      type: 'new_comment',
      authorName: commenterName,
      authorImage: commenterImage,
      postImage: post.image,
      postTitle: post.title,
      commentContent: commentDocument.content
    };

    return await sendAppwriteNotifications(notificationData, messaging, log, error, res);
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

  return await sendAppwriteNotifications({ userIds, title, body, postId, type }, messaging, log, error, res);
}

async function sendAppwriteNotifications(
  notificationData: NotificationData,
  messaging: Messaging,
  log: (msg: string) => void,
  error: (msg: string) => void,
  res: { json: (data: any, status?: number) => void }
) {
  const { userIds, title, body, postId, type, authorName, authorImage, postImage, postTitle, commentContent } = notificationData;

  log(`Sending ${type} notification via Appwrite Messaging to users: ${userIds.join(', ')}`);

  try {
    // Create notification data with rich content
    const messageData = {
      postId,
      type,
      authorName,
      authorImage,
      postImage,
      postTitle,
      commentContent,
      screen: 'PostDetails',
      params: { postId },
      timestamp: Date.now(),
    };

    // Create push notification using Appwrite Messaging
    const pushNotification = await messaging.createPush(
      ID.unique(), // messageId
      title,
      body,
      [], // topics
      userIds, // users
      [], // targets (empty since we're using users)
      JSON.stringify(messageData), // data
      null, // action
      null, // icon
      null, // sound
      null, // color
      null, // tag
      1, // badge count
      null // draft
    );

    log(`Successfully created Appwrite push notification: ${JSON.stringify(pushNotification)}`);

    return res.json({
      ok: true,
      messageId: pushNotification.$id,
      sentTo: userIds.length,
      notificationData: {
        title,
        body,
        authorName,
        hasAuthorImage: !!authorImage,
        hasPostImage: !!postImage,
      },
      appwriteResponse: pushNotification,
    }, 200);
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Error sending Appwrite push notification: ${errorMsg}`);
    
    if (e instanceof Error && e.message.includes('Provider not found')) {
      error(`Appwrite Messaging provider not configured. Please set up FCM provider in Appwrite Console.`);
      return res.json({ 
        ok: false, 
        error: 'Messaging provider not configured. Please set up FCM in Appwrite Console.',
        details: errorMsg 
      }, 500);
    }
    
    return res.json({ ok: false, error: errorMsg }, 500);
  }
}
