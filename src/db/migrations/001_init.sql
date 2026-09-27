-- ============================================================
-- Migration 001: Initial schema for the Nightly Digest Worker
-- Creates the `jobs` table (one row per enqueued job) and the
-- `job_activity_logs` table (immutable, append-only audit trail
-- of every state transition a job goes through).
-- Idempotent: safe to run multiple times / on every container boot.
-- ============================================================

CREATE TABLE IF NOT EXISTS jobs (
    id             UUID PRIMARY KEY,
    name           VARCHAR(255) NOT NULL,
    payload        JSONB,
    current_state  VARCHAR(50) NOT NULL DEFAULT 'pending',
    created_at     TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_activity_logs (
    id          UUID PRIMARY KEY,
    seq         BIGSERIAL,
    job_id      UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    state       VARCHAR(50) NOT NULL,
    message     TEXT,
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Speeds up "logs for a given job, in order" lookups (the hot path
-- for GET /api/jobs/:job_id/logs and for the evaluator's polling loop).
CREATE INDEX IF NOT EXISTS idx_job_activity_logs_job_id
    ON job_activity_logs (job_id, seq);

-- Speeds up look-ups / dashboards filtering by job state.
CREATE INDEX IF NOT EXISTS idx_jobs_current_state
    ON jobs (current_state);
