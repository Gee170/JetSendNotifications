const { Client, Databases, Messaging } = require('appwrite');
const fetch = require('node-fetch');

module.exports = async ({ req, res, log, error }) => {
  const client = new Client();
  client
    .setEndpoint('https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_PROJECT_ID)
    [(Client.prototype as any).setKey](process.env.APPWRITE_API_KEY);

  log(`Client initialized with project ID: ${process.env.APPWRITE_PROJECT_ID}`);

  const databases = new Databases(client);
  const messaging = new Messaging(client);

  try {
    log(`Environment variables: ${JSON.stringify({
      APPWRITE_PROJECT_ID: process.env.APPWRITE_PROJECT_ID,
      APPWRITE_DATABASE_ID: process.env.APPWRITE_DATABASE_ID,
      POSTS_COLLECTION_ID: process.env.POSTS_COLLECTION_ID,
      USERS_COLLECTION_ID: process.env.USERS_COLLECTION_ID,
      EXPO_ACCESS_TOKEN: !!process.env.EXPO_ACCESS_TOKEN
    })}`);

    const webhookPayload = JSON.parse(req.body);
    log(`Received webhook payload: ${JSON.stringify(webhookPayload)}`);

    if (webhookPayload.events && webhookPayload.events.length > 0) {
      return await handleWebhookEvent(webhookPayload, databases, messaging, client, log, error, res);
    } else {
      return await handleDirectCall(webhookPayload, messaging, client, log, error, res);
    }
  } catch (e) {
    error(`Failed to process request: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
};

async function handleWebhookEvent(payload, databases, messaging, client, log, error, res) {
  const eventType = payload.events[0];
  log(`Event type received: ${eventType}`);
  const document = payload;

  if (eventType.includes('6896fbb2003568eb4840') && eventType.includes('create')) {
    return await handleNewPost(document, databases, messaging, client, log, error, res);
  } else if (eventType.includes('68970496002d7aff12cb') && eventType.includes('create')) {
    return await handleNewComment(document, databases, messaging, client, log, error, res);
  } else {
    log(`Unhandled event type: ${eventType}`);
    return res.json({ ok: false, error: 'Unhandled event type' }, 400);
  }
}

async function handleNewPost(postDocument, databases, messaging, client, log, error, res) {
  try {
    log(`Post document: ${JSON.stringify(postDocument)}`);
    const databaseId = process.env.APPWRITE_DATABASE_ID || 'default';
    const usersCollectionId = process.env.USERS_COLLECTION_ID || 'users_collection';

    const users = await databases.listDocuments(databaseId, usersCollectionId, [], 100);
    const userIds = users.documents
      .map(user => user.$id)
      .filter(userId => userId !== postDocument.authorId);

    if (userIds.length === 0) {
      log('No users to notify for new post');
      return res.json({ ok: true, message: 'No users to notify' });
    }

    const notificationData = {
      userIds,
      title: 'New Post',
      body: `New post by ${postDocument.authorName || 'Someone'}: ${postDocument.title || postDocument.content?.slice(0, 50) + '...'}`,
      postId: postDocument.$id,
      type: 'new_post'
    };

    return await sendPushNotifications(notificationData, messaging, client, log, error, res);
  } catch (e) {
    error(`Error handling new post: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
}

async function handleNewComment(commentDocument, databases, messaging, client, log, error, res) {
  try {
    log(`Comment document: ${JSON.stringify(commentDocument)}`);
    const databaseId = process.env.APPWRITE_DATABASE_ID || 'default';
    const postsCollectionId = process.env.POSTS_COLLECTION_ID || '6896fbb2003568eb4840';

    const post = await databases.getDocument(databaseId, postsCollectionId, commentDocument.postId);
    
    if (post.authorId === commentDocument.userId) {
      log('Comment author is the same as post author, no notification needed');
      return res.json({ ok: true, message: 'No notification needed - same user' });
    }

    const userIds = [post.authorId];

    const notificationData = {
      userIds,
      title: 'New Comment',
      body: `${commentDocument.authorName || 'Someone'} commented on your post: "${post.title || post.content?.slice(0, 50) + '...'}"`,
      postId: commentDocument.postId,
      type: 'new_comment'
    };

    return await sendPushNotifications(notificationData, messaging, client, log, error, res);
  } catch (e) {
    error(`Error handling new comment: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
}

async function handleDirectCall(payload, messaging, client, log, error, res) {
  const { userIds, title, body, postId, type } = payload;

  if (!userIds || !title || !body || !postId || !type) {
    throw new Error('Missing required fields: userIds, title, body, postId, type');
  }

  return await sendPushNotifications({ userIds, title, body, postId, type }, messaging, client, log, error, res);
}

async function sendPushNotifications(notificationData, messaging, client, log, error, res) {
  const { userIds, title, body, postId, type } = notificationData;

  log(`Sending ${type} notification to users: ${userIds.join(', ')}`);

  const targets = await Promise.all(
    userIds.map(async (userId) => {
      try {
        const response = await messaging.listTargets([`userId(${userId})`, `providerType(push)`]);
        return response.targets;
      } catch (e) {
        error(`Failed to get targets for user ${userId}: ${e.message}`);
        return [];
      }
    })
  ).then(results => results.flat());

  if (!targets.length) {
    error('No valid push targets found');
    return res.json({ ok: false, error: 'No valid push targets found' }, 400);
  }

  const expoPayload = {
    to: targets.map(target => target.identifier),
    title,
    body,
    data: { postId, type },
    badge: 1,
  };

  log(`Expo payload: ${JSON.stringify(expoPayload)}`);

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
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
  
  return res.json({ ok: true, messageId: result.data?.[0]?.id, sentTo: targets.length });
}
