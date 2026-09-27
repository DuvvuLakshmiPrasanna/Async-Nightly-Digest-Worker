'use strict';

const { v4: uuidv4 } = require('uuid');
const pool = require('../db/pool');

/**
 * Valid states in the job lifecycle state machine:
 *   pending -> started -> success
 *   pending -> started -> failed -> dead_letter
 * Kept as a constant so both the API layer and the worker reference
 * the exact same vocabulary (no typo drift between "success" and "successful", etc).
 */
const STATES = Object.freeze({
  PENDING: 'pending',
  STARTED: 'started',
  SUCCESS: 'success',
  FAILED: 'failed',
  RETRYING: 'retrying',
  DEAD_LETTER: 'dead_letter',
});

/**
 * Creates the parent `jobs` record.
 * @param {string} name - job type identifier, e.g. 'nightly_digest'
 * @param {object} payload - arbitrary JSON payload (e.g. { simulate_failure: true })
 * @returns {Promise<{id: string, name: string, payload: object, current_state: string, created_at: Date}>}
 */
async function createJobRecord(name, payload) {
  const id = uuidv4();
  const { rows } = await pool.query(
    `INSERT INTO jobs (id, name, payload, current_state)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, payload, current_state, created_at`,
    [id, name, payload ? JSON.stringify(payload) : null, STATES.PENDING]
  );
  return rows[0];
}

/**
 * Appends an immutable entry to job_activity_logs AND mirrors the
 * latest state onto jobs.current_state for fast look-ups.
 * This is the single choke point every state transition must go
 * through, guaranteeing "no job silently disappears".
 * @param {string} jobId
 * @param {string} state - one of STATES
 * @param {string} [message] - human readable context / error text
 */
async function appendActivityLog(jobId, state, message) {
  const id = uuidv4();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO job_activity_logs (id, job_id, state, message)
       VALUES ($1, $2, $3, $4)
       RETURNING id, job_id, state, message, created_at`,
      [id, jobId, state, message || null]
    );
    await client.query(
      `UPDATE jobs SET current_state = $1 WHERE id = $2`,
      [state, jobId]
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * @param {string} jobId
 * @returns {Promise<object|null>} the job row, or null if it does not exist
 */
async function getJobById(jobId) {
  const { rows } = await pool.query(
    `SELECT id, name, payload, current_state, created_at FROM jobs WHERE id = $1`,
    [jobId]
  );
  return rows[0] || null;
}

/**
 * Returns the full, chronologically ordered activity log for a job.
 * Ordered by created_at then by the monotonic `seq` column as a
 * tie-breaker, so two log rows written within the same millisecond
 * (e.g. failed -> dead_letter written back-to-back) are never reordered.
 * @param {string} jobId
 */
async function getJobLogs(jobId) {
  const { rows } = await pool.query(
    `SELECT state, message, created_at
     FROM job_activity_logs
     WHERE job_id = $1
     ORDER BY created_at ASC, seq ASC`,
    [jobId]
  );
  return rows;
}

module.exports = {
  STATES,
  createJobRecord,
  appendActivityLog,
  getJobById,
  getJobLogs,
};
