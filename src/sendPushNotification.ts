import { Client, Databases, ID } from 'appwrite';
import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint('https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const databases = new Databases(client);

  try {
    const webhookPayload = JSON.parse(req.body);
    log(`Received webhook payload: ${JSON.stringify(webhookPayload)}`);

    // Check if this is a webhook event
    if (webhookPayload.events && webhookPayload.events.length > 0) {
      return await handleWebhookEvent(webhookPayload, databases, client, log, error, res);
    } else {
      // Handle direct function call (manual trigger)
      return await handleDirectCall(webhookPayload, client, log, error, res);
    }

  } catch (e) {
    error(`Failed to process request: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
};

async function handleWebhookEvent(payload, databases, client, log, error, res) {
  const eventType = payload.events[0];
  const document = payload;

  if (eventType.includes('posts_collection') && eventType.includes('create')) {
    return await handleNewPost(document, databases, client, log, error, res);
  } else if (eventType.includes('comments_collection') && eventType.includes('create')) {
    return await handleNewComment(document, databases, client, log, error, res);
  } else {
    log(`Unhandled event type: ${eventType}`);
    return res.json({ ok: false, error: 'Unhandled event type' }, 400);
  }
}

async function handleNewPost(postDocument, databases, client, log, error, res) {
  try {
    const databaseId = process.env.APPWRITE_DATABASE_ID || 'default';
    const usersCollectionId = process.env.USERS_COLLECTION_ID || 'users_collection';

    // Get all users to notify (you might want to add filtering logic here)
    const users = await databases.listDocuments(databaseId, usersCollectionId, [], 100);
    const userIds = users.documents
      .map(user => user.$id)
      .filter(userId => userId !== postDocument.authorId); // Don't notify the author

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

    return await sendPushNotifications(notificationData, client, log, error, res);

  } catch (e) {
    error(`Error handling new post: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
}

async function handleNewComment(commentDocument, databases, client, log, error, res) {
  try {
    const databaseId = process.env.APPWRITE_DATABASE_ID || 'default';
    const postsCollectionId = process.env.POSTS_COLLECTION_ID || 'posts_collection';

    // Get the post that was commented on
    const post = await databases.getDocument(databaseId, postsCollectionId, commentDocument.postId);
    
    // Only notify the post author if they didn't write the comment
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

    return await sendPushNotifications(notificationData, client, log, error, res);

  } catch (e) {
    error(`Error handling new comment: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
}

async function handleDirectCall(payload, client, log, error, res) {
  const { userIds, title, body, postId, type } = payload;

  if (!userIds || !title || !body || !postId || !type) {
    throw new Error('Missing required fields: userIds, title, body, postId, type');
  }

  return await sendPushNotifications({ userIds, title, body, postId, type }, client, log, error, res);
}

async function sendPushNotifications(notificationData, client, log, error, res) {
  const { userIds, title, body, postId, type } = notificationData;

  log(`Sending ${type} notification to users: ${userIds.join(', ')}`);

  // Get push targets for users
  const targets = await Promise.all(
    userIds.map(async (userId: string) => {
      try {
        const response = await client.call('GET', `/messaging/targets?queries[]=userId("${userId}")&queries[]=providerType("push")`);
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

  // Send push notifications via Expo API
  const expoPayload = {
    to: targets.map(target => target.identifier),
    title,
    body,
    data: { postId, type },
    badge: 1,
  };

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
    throw new Error(`Expo API error: ${errorText}`);
  }

  const result = await response.json();
  log(`Successfully sent notifications: ${JSON.stringify(result)}`);
  
  return res.json({ ok: true, messageId: result.data?.[0]?.id, sentTo: targets.length });
}
