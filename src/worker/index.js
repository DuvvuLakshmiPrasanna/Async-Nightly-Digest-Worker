'use strict';

require('dotenv').config();

const { Worker } = require('bullmq');
const IORedis = require('ioredis');
const { processDigestJob } = require('./processor');

const QUEUE_NAME = process.env.QUEUE_NAME || 'digest_queue';
const CONCURRENCY = parseInt(process.env.WORKER_CONCURRENCY || '5', 10);

const connection = new IORedis(
  process.env.REDIS_URL ||
    `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`,
  { maxRetriesPerRequest: null }
);

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    await processDigestJob(job);
  },
  { connection, concurrency: CONCURRENCY }
);

worker.on('ready', () => {
  console.log(`[worker] Listening on queue "${QUEUE_NAME}" (concurrency=${CONCURRENCY})`);
});

worker.on('completed', (job) => {
  console.log(`[worker] BullMQ job ${job.id} (digest job ${job.data.jobId}) completed`);
});

worker.on('error', (err) => {
  console.error('[worker] Worker error:', err);
});

// This process runs completely independently from the API's HTTP
// request/response cycle - it is a separate container/process that
// only talks to Redis and Postgres.
process.on('SIGTERM', async () => {
  console.log('[worker] SIGTERM received, closing gracefully...');
  await worker.close();
  process.exit(0);
});

console.log('[worker] Nightly Digest worker process starting...');
