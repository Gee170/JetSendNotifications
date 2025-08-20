const { Client, Messaging, ID } = require('node-appwrite');

module.exports = async ({ req, res, log, error }) => {
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

  const messaging = new Messaging(client);

  log(`Received request to register push token`);

  try {
    let payload;
    try {
      payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      log(`Parsed payload: ${JSON.stringify(payload)}`);
    } catch (err) {
      throw new Error(`Invalid JSON body: ${err.message}`);
    }

    const { userId, token, platform, deviceId } = payload;

    if (!userId || !token || !platform) {
      throw new Error('Missing required fields: userId, token, platform');
    }

    // Register the push token with Appwrite Messaging
    const pushTarget = await messaging.createPushTarget(
      ID.unique(),
      userId,
      token,
      platform, // 'fcm' or 'apns'
      deviceId || null // Optional device identifier
    );

    log(`Successfully registered push target: ${JSON.stringify(pushTarget)}`);

    return res.json({
      ok: true,
      targetId: pushTarget.$id,
      message: 'Push token registered successfully',
    }, 200);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Failed to register push token: ${errorMsg}`);
    return res.json({ ok: false, error: errorMsg }, 500);
  }
};
