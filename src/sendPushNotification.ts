import { Client, Functions, ID } from 'appwrite';
import fetch from 'node-fetch';

export default async ({ req, res, log, error }) => {
  const client = new Client()
    .setEndpoint('https://cloud.appwrite.io/v1')
    .setProject(process.env.APPWRITE_PROJECT_ID)
    .setKey(process.env.APPWRITE_API_KEY);

  const functions = new Functions(client);

  try {
    const payload = JSON.parse(req.body);
    const { userIds, title, body, postId, type } = payload;

    if (!userIds || !title || !body || !postId || !type) {
      throw new Error('Missing required fields: userIds, title, body, postId, type');
    }

    log(`Sending ${type} notification to users: ${userIds.join(', ')}`);

    // Get push targets for users
    const targets = await Promise.all(
      userIds.map(async (userId: string) => {
        try {
          const response = await client.call('GET', `/account/targets?queries[]=userId("${userId}")`);
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
      badge: 1, // Increment badge count
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

    return res.json({ ok: true, messageId: result.data[0]?.id });
  } catch (e) {
    error(`Failed to send notification: ${e.message}`);
    return res.json({ ok: false, error: e.message }, 500);
  }
};
