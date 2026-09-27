'use strict';

/**
 * Standalone migration runner.
 *
 * Run as its own short-lived docker-compose service ("migrate") that
 * must complete successfully before the `api` and `worker` services
 * are allowed to start (see `depends_on.condition: service_completed_successfully`
 * in docker-compose.yml). This is what makes database initialization
 * fully automatic: `docker-compose up` alone is enough, no manual
 * `psql` step is ever required.
 *
 * All SQL files in ./migrations are idempotent (CREATE TABLE IF NOT
 * EXISTS / CREATE INDEX IF NOT EXISTS), so re-running this script on
 * every container restart is always safe.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MAX_RETRIES = 20;
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildConnectionString() {
  return (
    process.env.DATABASE_URL ||
    `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${
      process.env.POSTGRES_PASSWORD || 'postgres'
    }@${process.env.POSTGRES_HOST || 'localhost'}:${
      process.env.POSTGRES_PORT || 5432
    }/${process.env.POSTGRES_DB || 'digest_db'}`
  );
}

async function connectWithRetry() {
  const connectionString = buildConnectionString();
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    const client = new Client({ connectionString });
    try {
      await client.connect();
      return client;
    } catch (err) {
      lastError = err;
      // eslint-disable-next-line no-console
      console.log(
        `[migrate] Postgres not ready yet (attempt ${attempt}/${MAX_RETRIES}): ${err.message}`
      );
      await sleep(RETRY_DELAY_MS);
    }
  }

  throw new Error(
    `[migrate] Could not connect to Postgres after ${MAX_RETRIES} attempts: ${lastError.message}`
  );
}

async function runMigrations() {
  const client = await connectWithRetry();

  try {
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort(); // lexicographic order -> 001_, 002_, ... run in sequence

    if (files.length === 0) {
      console.log('[migrate] No migration files found. Nothing to do.');
      return;
    }

    for (const file of files) {
      const fullPath = path.join(MIGRATIONS_DIR, file);
      const sql = fs.readFileSync(fullPath, 'utf8');
      console.log(`[migrate] Applying ${file} ...`);
      await client.query(sql);
      console.log(`[migrate] Applied ${file} successfully.`);
    }

    console.log('[migrate] All migrations applied. Database is ready.');
  } finally {
    await client.end();
  }
}

runMigrations()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('[migrate] Migration failed:', err);
    process.exit(1);
  });
