'use strict';

/**
 * Integration test suite for the Nightly Digest Worker.
 *
 * Assumes the full stack (db, redis, api, worker) is already running,
 * e.g. via `docker-compose up -d`. Exercises every core requirement
 * end-to-end through the public HTTP API only (black-box, exactly
 * how the automated evaluator will interact with the system).
 *
 * Usage:
 *   BASE_URL=http://localhost:3000 node tests/run_tests.js
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${message}`);
  } else {
    failed += 1;
    console.error(`  \u2717 ${message}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function triggerJob(simulateFailure) {
  const res = await fetch(`${BASE_URL}/api/jobs/trigger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'nightly_digest', simulate_failure: simulateFailure }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

async function getLogs(jobId) {
  const res = await fetch(`${BASE_URL}/api/jobs/${jobId}/logs`);
  const body = res.status === 204 ? null : await res.json();
  return { status: res.status, body };
}

async function pollUntilTerminal(jobId, timeoutMs = 15000) {
  const start = Date.now();
  const terminal = new Set(['success', 'dead_letter']);
  let last;
  while (Date.now() - start < timeoutMs) {
    const { body } = await getLogs(jobId);
    last = body;
    const states = (body.logs || []).map((l) => l.state);
    if (states.some((s) => terminal.has(s))) {
      return last;
    }
    await sleep(500);
  }
  return last;
}

async function testSuccessFlow() {
  console.log('\n[Test] Success flow (simulate_failure: false)');
  const { status, body } = await triggerJob(false);
  ok(status === 202, `POST /api/jobs/trigger returns 202 (got ${status})`);
  ok(!!body.job_id, 'response contains job_id');

  const result = await pollUntilTerminal(body.job_id);
  const states = (result.logs || []).map((l) => l.state);
  console.log('  states observed:', states.join(' -> '));

  ok(
    states.length >= 3 &&
      states[0] === 'pending' &&
      states[1] === 'started' &&
      states[states.length - 1] === 'success',
    'log sequence is pending -> started -> ... -> success'
  );
  ok(result.current_state === 'success', 'current_state resolves to success');
}

async function testFailureFlow() {
  console.log('\n[Test] Failure flow (simulate_failure: true)');
  const { status, body } = await triggerJob(true);
  ok(status === 202, `POST /api/jobs/trigger returns 202 (got ${status})`);

  const result = await pollUntilTerminal(body.job_id);
  const states = (result.logs || []).map((l) => l.state);
  console.log('  states observed:', states.join(' -> '));

  ok(
    states.length === 4 &&
      states[0] === 'pending' &&
      states[1] === 'started' &&
      states[2] === 'failed' &&
      states[3] === 'dead_letter',
    'log sequence is exactly pending -> started -> failed -> dead_letter'
  );
  ok(result.current_state === 'dead_letter', 'current_state resolves to dead_letter');
}

async function testNotFound() {
  console.log('\n[Test] 404 for unknown job');
  const { status } = await getLogs('00000000-0000-0000-0000-000000000000');
  ok(status === 404, `GET /api/jobs/:id/logs returns 404 for unknown id (got ${status})`);
}

async function testNonBlockingBurst() {
  console.log('\n[Test] API stays non-blocking under a burst of 10 concurrent triggers');
  const start = Date.now();
  const results = await Promise.all(Array.from({ length: 10 }, () => triggerJob(false)));
  const elapsed = Date.now() - start;
  const allAccepted = results.every((r) => r.status === 202);
  console.log(`  10 requests completed in ${elapsed}ms`);
  ok(allAccepted, 'all 10 requests returned 202');
  ok(elapsed < 1500, `burst completed in under 1.5s (took ${elapsed}ms)`);
}

async function testResponseTime() {
  console.log('\n[Test] Trigger response time proves non-blocking behavior');
  const start = Date.now();
  await triggerJob(false);
  const elapsed = Date.now() - start;
  console.log(`  single trigger responded in ${elapsed}ms`);
  ok(elapsed < 500, `trigger responds in under 500ms (took ${elapsed}ms)`);
}

async function main() {
  console.log(`Running integration tests against ${BASE_URL}`);
  try {
    await testResponseTime();
    await testSuccessFlow();
    await testFailureFlow();
    await testNotFound();
    await testNonBlockingBurst();
  } catch (err) {
    console.error('Test run crashed:', err);
    failed += 1;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
