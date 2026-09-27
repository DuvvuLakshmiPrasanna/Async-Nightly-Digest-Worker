'use strict';

const cron = require('node-cron');
const { triggerDigestJob } = require('../services/triggerService');

// Default: every day at midnight. Overridable via CRON_SCHEDULE for
// testing (e.g. '*/1 * * * *' to fire every minute).
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || '0 0 * * *';

function start() {
  if (!cron.validate(CRON_SCHEDULE)) {
    console.error(`[scheduler] Invalid CRON_SCHEDULE "${CRON_SCHEDULE}" - scheduler NOT started.`);
    return null;
  }

  const task = cron.schedule(CRON_SCHEDULE, async () => {
    console.log(`[scheduler] Firing scheduled nightly_digest trigger (${new Date().toISOString()})`);
    try {
      const job = await triggerDigestJob({ simulate_failure: false, source: 'scheduler' });
      console.log(`[scheduler] Enqueued job ${job.id} via cron`);
    } catch (err) {
      console.error('[scheduler] Failed to enqueue scheduled job:', err);
    }
  });

  console.log(`[scheduler] Cron scheduler active with schedule "${CRON_SCHEDULE}"`);
  return task;
}

module.exports = { start, CRON_SCHEDULE };
