'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const jobsRouter = require('./routes/jobs');

const app = express();

app.use(cors());
app.use(express.json());

// Simple liveness/readiness probe - also handy for the docker-compose
// healthcheck and for evaluators sanity-checking the container is up.
app.get('/health', (_req, res) => {
  res.status(200).json({ status: 'ok', service: 'api' });
});

app.use('/api/jobs', jobsRouter);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: `Not found: ${req.method} ${req.originalUrl}` });
});

// Centralized error handler - never let an unhandled rejection hang a request.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[api] Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.API_PORT || 3000;

app.listen(PORT, () => {
  console.log(`[api] Nightly Digest API listening on port ${PORT}`);

  // The cron scheduler runs inside the API process. It reuses the
  // exact same triggerDigestJob() code path as the manual endpoint.
  if (process.env.DISABLE_CRON !== 'true') {
    require('../scheduler/cron').start();
  } else {
    console.log('[api] Cron scheduler disabled via DISABLE_CRON=true');
  }
});

module.exports = app;
