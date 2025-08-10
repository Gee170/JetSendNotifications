// index.js — required by Appwrite as the entrypoint file
const fn = require('./dist/sendPushNotification');
module.exports = fn.default || fn;
