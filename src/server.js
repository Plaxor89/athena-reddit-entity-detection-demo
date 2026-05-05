const express = require('express');
const { detectionHttpHandler } = require('./http/detectionHttpHandler');

const app = express();

// Let the existing handler manage its own body parsing logic.
// Use a raw body parser so req.body is available when possible.
app.use(express.raw({ type: '*/*', limit: '10mb' }));

app.all('*', async (req, res) => {
  try {
    await detectionHttpHandler(req, res);
  } catch (err) {
    console.error('Unhandled server error:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

const port = Number(process.env.PORT) || 8080;
app.listen(port, () => {
  console.log(`Detector service listening on port ${port}`);
});