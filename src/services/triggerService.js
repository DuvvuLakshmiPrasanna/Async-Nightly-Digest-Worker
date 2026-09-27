'use strict';

const { createJobRecord, appendActivityLog, STATES } = require('../models/jobs');
const { enqueueDigestJob } = require('../queue/queue');

const JOB_NAME = 'nightly_digest';

/**
 * Creates a job record, writes the initial `pending` log entry, and
 * enqueues the job onto the async queue.
 *
 * This is intentionally the ONLY code path that is allowed to create
 * a nightly_digest job. Both:
 *   - POST /api/jobs/trigger (manual / evaluator-driven)
 *   - the node-cron scheduled trigger (automatic, nightly)
 * call this exact function, so the two entry points are provably
 * equivalent - the API never does anything the scheduler couldn't
 * also do, and vice versa.
 *
 * @param {object} [options]
 * @param {boolean} [options.simulate_failure=false]
 * @param {string} [options.type='nightly_digest']
 * @param {string} [options.source='manual'] - 'manual' | 'scheduler', for logging only
 * @returns {Promise<{id: string, name: string, payload: object, current_state: string, created_at: Date}>}
 */
async function triggerDigestJob({ simulate_failure = false, type = JOB_NAME, source = 'manual' } = {}) {
  const payload = { simulate_failure: Boolean(simulate_failure) };

  const job = await createJobRecord(type, payload);

  await appendActivityLog(
    job.id,
    STATES.PENDING,
    source === 'scheduler'
      ? 'Job created via cron scheduler'
      : 'Job created via API trigger'
  );

  await enqueueDigestJob(job.id, payload);

  return job;
}

module.exports = { triggerDigestJob, JOB_NAME };
