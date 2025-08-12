import { Client, Databases, Models, Query } from 'node-appwrite';
import nodeFetch from 'node-fetch';

// Define interfaces
interface WebhookPayload {
  events: string[];
  document: Models.Document;
  [key: string]: any;
}

interface PostDocument extends Models.Document {
  authorId: string;
  authorName?: string;
  title?: string;
  content?: string;
}

interface CommentDocument extends Models.Document {
  userId: string;
  authorName?: string;
  postId: string;
}

interface NotificationData {
  userIds: string[];
  title: string;
  body: string;
  postId: string;
  type: 'new_post' | 'new_comment';
}

interface Target {
  $id: string;
  userId: string;
  providerType: string;
  identifier: string;
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
    .setKey(process.env.APPWRITE_API_KEY); // Use setKey instead of setJWT

  log(`Client initialized with project ID: ${process.env.APPWRITE_PROJECT_ID}`);

  const databases = new Databases(client);

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

    if (webhookPayload.events && webhookPayload.events.length > 0) {
      return await handleWebhookEvent(webhookPayload, databases, client, log, error, res);
    } else {
      return await handleDirectCall(webhookPayload, client, log, error, res);
    }
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Failed to process request: ${errorMsg}`);
    return res.json({ ok: false, error: errorMsg }, 500);
  }
};

async function handleWebhookEvent(
  payload: WebhookPayload,
  databases: Databases,
  client: Client,
  log: (msg: string) => void,
  error: (msg: string) => void,
  res: { json: (data: any, status?: number) => void }
) {
  const eventType = payload.events[0];
  log(`Event type received: ${eventType}`);
  const document = payload.document;

  if (eventType.includes('6896fbb2003568eb4840') && eventType.includes('create')) {
    return await handleNewPost(document as PostDocument, databases, client, log, error, res);
  } else if (eventType.includes('68970496002d7aff12cb') && eventType.includes('create')) {
    return await handleNewComment(document as CommentDocument, databases, client, log, error, res);
  } else {
    log(`Unhandled event type: ${eventType}`);
    return res.json({ ok: false, error: 'Unhandled event type' }, 400);
  }
}

async function handleNewPost(
  postDocument: PostDocument,
  databases: Databases,
  client: Client,
  log: (msg: string) => void,
  error: (msg: string) => void,
  res: { json: (data: any, status?: number) => void }
) {
  try {
    log(`Post document: ${JSON.stringify(postDocument)}`);
    const databaseId = process.env.APPWRITE_DATABASE_ID || 'default';
    const usersCollectionId = process.env.USERS_COLLECTION_ID || 'users_collection';

    const users = await databases.listDocuments(databaseId, usersCollectionId, [Query.limit(100)]);
    const userIds = users.documents
      .map((user: Models.Document) => user.$id)
      .filter((userId: string) => userId !== postDocument.authorId);

    if (userIds.length === 0) {
      log('No users to notify for new post');
      return res.json({ ok: true, message: 'No users to notify' }, 200);
    }

    const notificationData: NotificationData = {
      userIds,
      title: 'New Post',
      body: `New post by ${postDocument.authorName || 'Someone'}: ${postDocument.title || postDocument.content?.slice(0, 50) + '...'}`,
      postId: postDocument.$id,
      type: 'new_post'
    };

    return await sendPushNotifications(notificationData, client, log, error, res);
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Error handling new post: ${errorMsg}`);
    return res.json({ ok: false, error: errorMsg }, 500);
  }
}

async function handleNewComment(
  commentDocument: CommentDocument,
  databases: Databases,
  client: Client,
  log: (msg: string) => void,
  error: (msg: string) => void,
  res: { json: (data: any, status?: number) => void }
) {
  try {
    log(`Comment document: ${JSON.stringify(commentDocument)}`);
    const databaseId = process.env.APPWRITE_DATABASE_ID || 'default';
    const postsCollectionId = process.env.POSTS_COLLECTION_ID || '6896fbb2003568eb4840';

    const post = await databases.getDocument(databaseId, postsCollectionId, commentDocument.postId);
    
    if (post.authorId === commentDocument.userId) {
      log('Comment author is the same as post author, no notification needed');
      return res.json({ ok: true, message: 'No notification needed - same user' }, 200);
    }

    const userIds = [post.authorId];

    const notificationData: NotificationData = {
      userIds,
      title: 'New Comment',
      body: `${commentDocument.authorName || 'Someone'} commented on your post: "${post.title || post.content?.slice(0, 50) + '...'}"`,
      postId: commentDocument.postId,
      type: 'new_comment'
    };

    return await sendPushNotifications(notificationData, client, log, error, res);
  } catch (e: unknown) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Error handling new comment: ${errorMsg}`);
    return res.json({ ok: false, error: errorMsg }, 500);
  }
}

async function handleDirectCall(
  payload: WebhookPayload,
  client: Client,
  log: (msg: string) => void,
  error: (msg: string) => void,
  res: { json: (data: any, status?: number) => void }
) {
  const { userIds, title, body, postId, type } = payload;

  if (!userIds || !title || !body || !postId || !type) {
    throw new Error('Missing required fields: userIds, title, body, postId, type');
  }

  return await sendPushNotifications({ userIds, title, body, postId, type }, client, log, error, res);
}

async function sendPushNotifications(
  notificationData: NotificationData,
  client: Client,
  log: (msg: string) => void,
  error: (msg: string) => void,
  res: { json: (data: any, status?: number) => void }
) {
  const { userIds, title, body, postId, type } = notificationData;

  log(`Sending ${type} notification to users: ${userIds.join(', ')}`);

  // const targets: Target[] = await Promise.all(
  //   userIds.map(async (userId: string) => {
  //     try {
  //       const response = await client.call('GET', new URL(`/messaging/targets?queries[]=userId("${userId}")&queries[]=providerType("push")`, client.config.endpoint));
  //       return response.targets as Target[];
  //     } catch (e: unknown) {
  //       const errorMsg = e instanceof Error ? e.message : String(e);
  //       error(`Failed to get targets for user ${userId}: ${errorMsg}`);
  //       return [];
  //     }
  //   })
  // ).then(results => results.flat());

  // if (!targets.length) {
  //   error('No valid push targets found');
  //   return res.json({ ok: false, error: 'No valid push targets found' }, 400);
  // }

  const expoPushToken = "ExponentPushToken[2urmJODmArO240nQ1D6fZX]";

  const expoPayload = {
    to: [expoPushToken],
    title,
    body,
    data: { postId, type },
    badge: 1,
  };

  log(`Expo payload: ${JSON.stringify(expoPayload)}`);

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
  log(`Successfully sent notifications: ${JSON.stringify(result)}`);
  
  return res.json({ ok: true, messageId: result.data?.[0]?.id, sentTo: targets.length }, 200);
}
