// index.js — required by Appwrite as the entrypoint file
const fn = require('./dist/index');
module.exports = fn.default || fn;
