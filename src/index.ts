const { Client, Users, ID } = require('node-appwrite');

module.exports = async ({ req, res, log, error }) => {
  // Add detailed request logging
  log('=== FUNCTION START ===');
  log(`Request method: ${req.method}`);
  log(`Request headers: ${JSON.stringify(req.headers, null, 2)}`);
  
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

  const users = new Users(client);

  log(`Received request to register push token`);

  try {
    let payload;
    try {
      payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      log(`Parsed payload: ${JSON.stringify(payload)}`);
    } catch (err) {
      error(`Invalid JSON body: ${err.message}`);
      return res.json({ ok: false, error: `Invalid JSON body: ${err.message}` }, 400);
    }

    const { userId, token, platform, deviceId } = payload;

    if (!userId || !token || !platform) {
      error('Missing required fields: userId, token, platform');
      return res.json({ 
        ok: false, 
        error: 'Missing required fields: userId, token, platform',
        received: { userId: !!userId, token: !!token, platform: !!platform }
      }, 400);
    }

    log(`Attempting to create push target for user: ${userId}`);
    log(`Platform: ${platform}, DeviceId: ${deviceId || 'null'}`);
    log(`Token: ${token.substring(0, 20)}...`); // Log partial token for debugging

    // Create push notification target using Users service
    const target = await users.createTarget(
      userId,           // userId
      ID.unique(),      // targetId
      'push',           // providerType - 'push' for push notifications
      token,            // identifier - the FCM/APNs token
      undefined,        // providerId - optional, can be undefined for push
      deviceId || undefined  // name - optional device identifier
    );

    log(`Successfully created push target: ${JSON.stringify(target)}`);

    return res.json({
      ok: true,
      targetId: target.$id,
      message: 'Push token registered successfully',
      target: target
    }, 200);
  } catch (e) {
    const errorMsg = e instanceof Error ? e.message : String(e);
    error(`Failed to register push token: ${errorMsg}`);
    
    // Add stack trace for debugging
    if (e instanceof Error && e.stack) {
      error(`Stack trace: ${e.stack}`);
    }
    
    return res.json({ ok: false, error: errorMsg }, 500);
  }
};
