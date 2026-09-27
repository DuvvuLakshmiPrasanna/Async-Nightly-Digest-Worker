'use strict';

const express = require('express');
const { getJobById, getJobLogs } = require('../../models/jobs');
const { triggerDigestJob } = require('../../services/triggerService');

const router = express.Router();

/**
 * POST /api/jobs/trigger
 *
 * Writes the initial `pending` record and enqueues the job, then
 * returns IMMEDIATELY (202 Accepted) without waiting for the worker.
 * This is the crux of the "async" requirement: the HTTP request
 * thread never touches the actual digest-generation logic.
 */
router.post('/trigger', async (req, res, next) => {
  try {
    const body = req.body || {};
    const type = typeof body.type === 'string' && body.type.trim() ? body.type.trim() : 'nightly_digest';
    const simulateFailure = body.simulate_failure === true || body.simulate_failure === 'true';

    const job = await triggerDigestJob({
      simulate_failure: simulateFailure,
      type,
      source: 'manual',
    });

    return res.status(202).json({
      job_id: job.id,
      message: 'Job accepted for processing',
    });
  } catch (err) {
    return next(err);
  }
});

/**
 * GET /api/jobs/:job_id/logs
 *
 * Returns the complete, chronologically-ordered activity log for a
 * job so clients/evaluators can trace the exact lifecycle:
 * pending -> started -> success, or pending -> started -> failed -> dead_letter.
 */
router.get('/:job_id/logs', async (req, res, next) => {
  try {
    const { job_id: jobId } = req.params;

    const job = await getJobById(jobId);
    if (!job) {
      return res.status(404).json({ error: `Job ${jobId} not found` });
    }

    const logs = await getJobLogs(jobId);

    return res.status(200).json({
      job_id: job.id,
      current_state: job.current_state,
      logs: logs.map((l) => ({
        state: l.state,
        message: l.message,
        created_at: l.created_at,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
