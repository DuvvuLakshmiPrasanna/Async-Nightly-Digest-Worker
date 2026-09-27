'use strict';

const { Pool } = require('pg');

// A single shared connection pool. Every module that needs the
// database (API routes, worker processor, migration script, cron
// scheduler) imports this same pool instead of opening its own
// connections, so we don't exhaust Postgres' max_connections under load.
const connectionString =
  process.env.DATABASE_URL ||
  `postgresql://${process.env.POSTGRES_USER || 'postgres'}:${
    process.env.POSTGRES_PASSWORD || 'postgres'
  }@${process.env.POSTGRES_HOST || 'localhost'}:${
    process.env.POSTGRES_PORT || 5432
  }/${process.env.POSTGRES_DB || 'digest_db'}`;

const pool = new Pool({
  connectionString,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  // Unexpected errors on idle clients should not crash the process;
  // log them so they show up in `docker-compose logs`.
  // eslint-disable-next-line no-console
  console.error('[db] Unexpected error on idle Postgres client', err);
});

module.exports = pool;
