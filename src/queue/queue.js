'use strict';

const { Queue } = require('bullmq');
const IORedis = require('ioredis');

const QUEUE_NAME = process.env.QUEUE_NAME || 'digest_queue';

// BullMQ requires `maxRetriesPerRequest: null` on the ioredis connection
// it manages internally for blocking commands.
const connection = new IORedis(
  process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`,
  { maxRetriesPerRequest: null }
);

const digestQueue = new Queue(QUEUE_NAME, { connection });

/**
 * Enqueues a nightly digest job onto the async queue (the Orchestration
 * Layer). This is the ONE function used by both the manual API trigger
 * and the cron scheduler, so both entry points are provably wired to
 * the same execution path.
 * @param {string} jobId - the UUID of the row already created in `jobs`
 * @param {object} payload - e.g. { simulate_failure: boolean }
 */
async function enqueueDigestJob(jobId, payload) {
  return digestQueue.add(
    'process-digest',
    { jobId, payload },
    {
      attempts: 1, // Retries are handled explicitly in-app (failed -> dead_letter),
      // not by BullMQ's own retry engine, to keep the state machine deterministic
      // for automated evaluation.
      removeOnComplete: 100,
      removeOnFail: 100,
    }
  );
}

module.exports = {
  QUEUE_NAME,
  connection,
  digestQueue,
  enqueueDigestJob,
};
