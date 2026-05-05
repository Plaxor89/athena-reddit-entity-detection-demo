// detectionHttpHandler.js
//
// HTTP / Cloud Functions entry: runs the full pipeline and returns the packaged
// downstream contract as JSON.
// Single-item request -> single per-post object.
// Batch request -> batch envelope.
// No extra business logic or consumer-specific shaping.

const { runDetectionPipeline } = require('../runDetectionPipeline');

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Express / Cloud Functions style handler.
 * Request payload (same shape as runDetectionPipeline): one item object or an array of items.
 *
 * Body modes (first match wins):
 * 1. `req.body` already parsed — object or array
 * 2. `req.body` a UTF-8 JSON string — parsed with JSON.parse after trim
 * 3. `req.body` a Buffer from express.raw(...) — decode UTF-8, then parse JSON after trim
 * 4. Otherwise read raw stream (`data` / `end`) and parse JSON after trim
 *
 * @param {import('http').IncomingMessage} req
 * @param {import('http').ServerResponse} res
 */
async function detectionHttpHandler(req, res) {
  let payload;
  try {
    const b = req.body;
    if (b !== undefined && b !== null) {
      if (Buffer.isBuffer(b)) {
        const trimmed = b.toString('utf8').trim();
        if (!trimmed) {
          sendJson(res, 400, { error: 'Empty body; expected JSON request item or array' });
          return;
        }
        try {
          payload = JSON.parse(trimmed);
        } catch (e) {
          sendJson(res, 400, { error: 'Invalid JSON body', detail: e?.message ?? String(e) });
          return;
        }
      } else if (typeof b === 'string') {
        const trimmed = b.trim();
        if (!trimmed) {
          sendJson(res, 400, { error: 'Empty body; expected JSON request item or array' });
          return;
        }
        try {
          payload = JSON.parse(trimmed);
        } catch (e) {
          sendJson(res, 400, { error: 'Invalid JSON body', detail: e?.message ?? String(e) });
          return;
        }
      } else if (Array.isArray(b) || (typeof b === 'object' && b !== null)) {
        payload = b;
      } else {
        sendJson(res, 400, { error: 'Invalid body type; expected JSON object, array, or string' });
        return;
      }
    } else {
      const raw = await readRawBody(req);
      if (!raw || !String(raw).trim()) {
        sendJson(res, 400, { error: 'Empty body; expected JSON request item or array' });
        return;
      }
      try {
        payload = JSON.parse(String(raw).trim());
      } catch (e) {
        sendJson(res, 400, { error: 'Invalid JSON body', detail: e?.message ?? String(e) });
        return;
      }
    }
  } catch (e) {
    sendJson(res, 400, { error: 'Invalid JSON body', detail: e?.message ?? String(e) });
    return;
  }

  try {
    const result = await runDetectionPipeline(payload);
    const packaged = result?.downstreamHandoff?.downstreamContract;
    if (!packaged || typeof packaged !== 'object') {
      sendJson(res, 500, { error: 'Pipeline did not produce downstreamContract' });
      return;
    }
    sendJson(res, 200, packaged);
  } catch (e) {
    sendJson(res, 500, { error: 'Pipeline failed', detail: e?.message ?? String(e) });
  }
}

module.exports = {
  detectionHttpHandler,
};