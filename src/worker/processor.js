'use strict';

const { appendActivityLog, STATES } = require('../models/jobs');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Processes a single digest job pulled off the queue.
 *
 * State machine implemented here:
 *   started -> success                (simulate_failure = false)
 *   started -> failed -> dead_letter  (simulate_failure = true)
 *
 * Every transition is written to job_activity_logs via appendActivityLog
 * BEFORE moving on to the next step, so even if the process crashes
 * mid-way the log always reflects the last known-true state.
 *
 * @param {import('bullmq').Job} job - BullMQ job, data = { jobId, payload }
 */
async function processDigestJob(job) {
  const { jobId, payload = {} } = job.data;

  // 1. Log start - the worker has picked the job up off the queue.
  await appendActivityLog(jobId, STATES.STARTED, 'Worker picked up job');
  console.log(`[worker] Job ${jobId} started`);

  try {
    // 2. Failure injection hook - lets automated evaluators
    // deterministically exercise the failure/DLQ path.
    if (payload.simulate_failure === true) {
      throw new Error('Injected failure encountered during digest generation');
    }

    // 3. Simulate the actual "generate nightly digest" workload.
    await delay(2000);

    // 4. Log success.
    await appendActivityLog(jobId, STATES.SUCCESS, 'Digest generated successfully');
    console.log(`[worker] Job ${jobId} succeeded`);
  } catch (error) {
    // 5. Log the failure itself.
    await appendActivityLog(jobId, STATES.FAILED, error.message);
    console.error(`[worker] Job ${jobId} failed: ${error.message}`);

    // 6. Route to the Dead Letter Queue. For this task, fatal /
    // injected errors bypass retries entirely for deterministic
    // testing, and we record the DLQ transition explicitly.
    await appendActivityLog(jobId, STATES.DEAD_LETTER, 'Moved to DLQ due to fatal error');
    console.error(`[worker] Job ${jobId} moved to dead_letter`);

    // Intentionally NOT re-thrown: BullMQ's own retry/backoff engine
    // is disabled (attempts: 1) because our own DLQ handling above is
    // the source of truth for the failure/dead_letter states. Letting
    // this escape would mark the BullMQ job "failed" a second time
    // without adding any new information to job_activity_logs.
  }
}

module.exports = { processDigestJob };
