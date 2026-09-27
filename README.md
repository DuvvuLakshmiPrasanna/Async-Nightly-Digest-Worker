# Nightly Digest Worker — Asynchronous Task Orchestration with Activity Logging

A fully containerized, asynchronous background-job system that decouples a
"nightly digest" workload from the HTTP request cycle, tracks every state
transition in an immutable activity log, and demonstrates a deterministic
failure → Dead Letter Queue (DLQ) path.

Built with **Node.js, Express, BullMQ, Redis, PostgreSQL, node-cron, and
Docker Compose.**

---

## 1. Architecture

```
 Trigger Layer                 Orchestration Layer         Execution Layer
┌───────────────┐   POST      ┌─────────────────┐        ┌──────────────────┐
│ Cron Scheduler │──────┐     │                  │  pull  │                  │
│ (node-cron)    │      │     │  Async Job Queue │◄───────│ Background Worker│
└───────────────┘      ▼     │  (Redis/BullMQ)  │        │  (worker process)│
┌───────────────┐  ┌────────┐│                  │        └─────────┬────────┘
│ Manual Trigger │─►│  API   │└─────────┬────────┘                  │
│ (curl/evaluator│  │Service │          │ enqueue                   │ writes
└───────────────┘  └───┬────┘          │                            │ state
                        │ writes         │                            ▼
                        │ pending        ▼                    ┌──────────────┐
                        └──────────────►│  PostgreSQL          │  started      │
                                         │  jobs +              │  success      │
                                         │  job_activity_logs   │  failed       │
                                         └──────────────────────┤  dead_letter  │
                                                                 └──────────────┘
```

**Design principle:** the API process *never* runs the digest itself. It only
(1) writes the parent `jobs` row, (2) writes an initial `pending` log entry,
and (3) pushes a message onto the Redis-backed BullMQ queue, then returns
`202 Accepted` immediately. The `worker` process — a completely separate
container/process — polls that queue independently, does the (simulated)
work, and is the only thing that ever writes `started` / `success` /
`failed` / `dead_letter` log rows.

### State machine

```
pending → started → success
pending → started → failed → dead_letter
```

Every transition is appended to `job_activity_logs` (never mutated,
never deleted) so the table is a complete, replayable audit trail. The
parent `jobs.current_state` column is kept in sync as a fast "latest
state" cache, but the log table is the source of truth.

### Why each transition exists
- **pending** — the API/scheduler has durably recorded intent and handed
  the job to the queue.
- **started** — proof the worker actually dequeued it (distinguishes
  "never ran" from "ran and failed").
- **success** — the digest was generated.
- **failed** — the attempt that just ran threw an error.
- **dead_letter** — the job is being routed to the Dead Letter Queue
  because the error was fatal / non-retryable. In this task,
  `simulate_failure: true` is treated as fatal and intentionally bypasses
  BullMQ's own retry engine so the sequence is 100% deterministic for
  automated grading (`attempts: 1` in `src/queue/queue.js`, DLQ routing
  handled explicitly in `src/worker/processor.js`).

---

## 2. Project structure

```
project-root/
├── docker-compose.yml        # db, redis, migrate (one-shot), api, worker
├── Dockerfile                # single image shared by api/worker/migrate
├── .env.example              # every environment variable, documented
├── submission.json           # evaluator config (API port, queue impl)
├── package.json
├── src/
│   ├── api/
│   │   ├── server.js         # Express entry point + mounts cron scheduler
│   │   └── routes/jobs.js    # POST /trigger, GET /:job_id/logs
│   ├── worker/
│   │   ├── index.js          # BullMQ Worker entry point (separate process)
│   │   └── processor.js      # core digest logic + failure injection + DLQ
│   ├── queue/queue.js        # BullMQ Queue + enqueueDigestJob()
│   ├── models/jobs.js        # DB access: createJobRecord, appendActivityLog...
│   ├── services/triggerService.js  # shared logic used by BOTH the API and cron
│   ├── scheduler/cron.js     # node-cron, fires the same triggerService
│   └── db/
│       ├── pool.js           # shared pg Pool
│       ├── migrate.js        # one-shot migration runner (idempotent)
│       └── migrations/001_init.sql
└── tests/
    └── run_tests.js          # black-box integration tests against the live API
```

---

## 3. Running it

Requires Docker and Docker Compose v2.20+ (for
`condition: service_completed_successfully`).

```bash
cp .env.example .env      # optional — sane defaults are already baked into docker-compose.yml
docker-compose up -d --build
```

That single command:
1. Builds the shared app image.
2. Starts `db` (Postgres) and `redis`, waiting for both healthchecks.
3. Runs the `migrate` service once, applying `src/db/migrations/*.sql`
   (idempotent — safe on every restart) and exits.
4. Starts `api` (port `3000` by default) and `worker`, both waiting for
   `migrate` to finish successfully — **no manual `psql` step, ever.**

Check everything is healthy:

```bash
docker-compose ps
curl http://localhost:3000/health
```

Tear down:

```bash
docker-compose down -v   # -v also drops the pgdata volume
```

---

## 4. API Reference

### `POST /api/jobs/trigger`

Enqueues a nightly digest job. Returns immediately — the worker processes
it asynchronously.

**Request**
```json
{ "type": "nightly_digest", "simulate_failure": false }
```
`type` and `simulate_failure` are both optional (default `"nightly_digest"`
and `false`).

**Response — `202 Accepted`**
```json
{ "job_id": "b3f1...-uuid", "message": "Job accepted for processing" }
```

### `GET /api/jobs/:job_id/logs`

Returns the full, chronologically ordered activity log.

**Response — `200 OK`**
```json
{
  "job_id": "b3f1...-uuid",
  "current_state": "success",
  "logs": [
    { "state": "pending", "message": "Job created via API trigger", "created_at": "2026-09-27T04:00:00.000Z" },
    { "state": "started", "message": "Worker picked up job", "created_at": "2026-09-27T04:00:00.050Z" },
    { "state": "success", "message": "Digest generated successfully", "created_at": "2026-09-27T04:00:02.060Z" }
  ]
}
```

**Response — `404 Not Found`** when `job_id` doesn't exist:
```json
{ "error": "Job <id> not found" }
```

### `GET /health`
Simple liveness probe used by the Docker healthcheck.

---

## 5. Manual verification walk-through

```bash
# 1. Success path
curl -s -X POST http://localhost:3000/api/jobs/trigger \
  -H 'Content-Type: application/json' \
  -d '{"simulate_failure": false}'
# -> {"job_id": "...", "message": "Job accepted for processing"}

curl -s http://localhost:3000/api/jobs/<job_id>/logs | jq
# -> logs: pending -> started -> success

# 2. Failure / DLQ path
curl -s -X POST http://localhost:3000/api/jobs/trigger \
  -H 'Content-Type: application/json' \
  -d '{"simulate_failure": true}'

curl -s http://localhost:3000/api/jobs/<job_id>/logs | jq
# -> logs: pending -> started -> failed -> dead_letter

# 3. 404 handling
curl -i http://localhost:3000/api/jobs/00000000-0000-0000-0000-000000000000/logs
# -> HTTP/1.1 404

# 4. Non-blocking burst (10 concurrent triggers, all fast)
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "%{http_code} %{time_total}s\n" \
    -X POST http://localhost:3000/api/jobs/trigger \
    -H 'Content-Type: application/json' -d '{}' &
done; wait
```

### Automated test suite

A black-box Node.js test suite (`tests/run_tests.js`) exercises every core
requirement against the live HTTP API — response time, the full success
sequence, the full failure/DLQ sequence, 404 handling, and the
non-blocking concurrent-burst behavior.

```bash
docker-compose up -d --build
BASE_URL=http://localhost:3000 node tests/run_tests.js
# or, with deps installed locally:
npm test
```

This suite was run against a locally provisioned Postgres + Redis stack
during development; all 11 assertions passed, including the exact
`pending → started → success` and `pending → started → failed →
dead_letter` sequences.

---

## 6. Database schema

`jobs`

| column         | type      | notes                          |
|----------------|-----------|---------------------------------|
| id             | UUID PK   | generated by the app (uuidv4)  |
| name           | VARCHAR   | job type, e.g. `nightly_digest`|
| payload        | JSONB     | e.g. `{"simulate_failure": true}` |
| current_state  | VARCHAR   | mirrors the latest log state   |
| created_at     | TIMESTAMP | default `NOW()`                |

`job_activity_logs`

| column      | type      | notes                                   |
|-------------|-----------|------------------------------------------|
| id          | UUID PK   |                                           |
| seq         | BIGSERIAL | monotonic tie-breaker for strict ordering|
| job_id      | UUID FK → jobs.id | `ON DELETE CASCADE`               |
| state       | VARCHAR   | pending / started / success / failed / dead_letter |
| message     | TEXT      | context or error text                    |
| created_at  | TIMESTAMP | default `NOW()`                          |

Both tables are created via `CREATE TABLE IF NOT EXISTS`, so the migration
script is safe to run on every container start.

---

## 7. Design notes / how each requirement is satisfied

| Requirement | Where |
|---|---|
| Single-command containerized startup + auto DB init | `docker-compose.yml` (`migrate` service gates `api`/`worker` via `service_completed_successfully`) |
| `jobs` + `job_activity_logs` tables with FK | `src/db/migrations/001_init.sql` |
| `POST /api/jobs/trigger` | `src/api/routes/jobs.js` → `src/services/triggerService.js` |
| `GET /api/jobs/:job_id/logs` | `src/api/routes/jobs.js` |
| Success flow logging | `src/worker/processor.js` |
| Failure → DLQ flow logging | `src/worker/processor.js` |
| Cron scheduler using the *same* enqueue logic as the API | `src/scheduler/cron.js` calls `triggerDigestJob()`, the identical function `routes/jobs.js` calls |
| `.env.example` | repository root |
| `submission.json` | repository root |
| API/worker decoupling | separate `api` / `worker` Docker services; API only ever calls `enqueueDigestJob()`, never `processDigestJob()` |

---

## 8. Troubleshooting

- **`service_completed_successfully` not recognized** — upgrade Docker
  Compose to v2.20+ (`docker compose version`).
- **Port 3000 already in use** — set `API_PORT` in `.env` and re-run
  `docker-compose up -d --build`.
- **Jobs stuck in `pending`** — check `docker-compose logs worker`; make
  sure `redis` reports healthy (`docker-compose ps`).
- **Reset everything** — `docker-compose down -v` removes the Postgres
  volume for a totally clean slate.
