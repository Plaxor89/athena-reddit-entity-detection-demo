// index.js
//
// Deploy entry for HTTP-triggered cloud runtimes (e.g. GCP Cloud Functions).
// Point the function target at `detectionHttpHandler`.

const { detectionHttpHandler } = require('./http/detectionHttpHandler');

module.exports = {
  detectionHttpHandler,
};
