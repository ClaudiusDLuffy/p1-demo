// Runs only in the attested, egress-denied disposable REST network namespace.
// Tokens arrive over private stdin and are never logged or returned.
// @ts-check
import assert from 'node:assert/strict';
import { createInterface } from 'node:readline';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  try {
    assert.ok(Buffer.byteLength(line) <= 1048576);
    /** @type {unknown} */
    const raw = JSON.parse(line);
    assert.ok(raw && typeof raw === 'object' && !Array.isArray(raw));
    const input = Object.fromEntries(Object.entries(raw));
    assert.equal(typeof input.service, 'string');
    assert.ok(['rest', 'storage'].includes(input.service));
    assert.ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(input.method));
    assert.equal(typeof input.path, 'string');
    assert.match(input.path, /^\/[a-zA-Z0-9_/%?=&.,()+:-]*$/);
    assert.ok(!decodeURIComponent(input.path).includes('..') && !input.path.includes('//') && !input.path.includes(':'));
    assert.ok(input.service === 'rest' || input.path.startsWith('/object/'));
    assert.ok(input.token === null || typeof input.token === 'string');
    const origin = input.service === 'rest' ? 'http://127.0.0.1:3000' : 'http://storage:5000';
    const url = new URL(input.path, origin); assert.equal(url.origin, origin);
    const headers = new Headers();
    if (input.token) headers.set('Authorization', `Bearer ${input.token}`);
    let body;
    if (input.bytes !== undefined) { assert.equal(typeof input.bytes, 'string'); body = Buffer.from(input.bytes, 'base64'); headers.set('Content-Type', 'image/png'); }
    else if (input.body !== undefined) { body = JSON.stringify(input.body); headers.set('Content-Type', 'application/json'); }
    const start = performance.now();
    const response = await fetch(url, { method: input.method, headers, body, redirect: 'error', signal: AbortSignal.timeout(10000) });
    const bytes = Buffer.from(await response.arrayBuffer()); assert.ok(bytes.length <= 16777216);
    /** @type {unknown} */
    let data = null;
    if (response.headers.get('content-type')?.includes('json')) data = JSON.parse(bytes.toString('utf8'));
    // All response rows are synthetic. Only the host harness decides what
    // metadata/hashes are persisted; credentials are never part of responses.
    process.stdout.write(JSON.stringify({ ok: true, status: response.status, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'), elapsedMs: performance.now() - start, data }) + '\n');
  } catch { process.stdout.write(JSON.stringify({ ok: false, error: 'LOCAL_GATEWAY_HARNESS_FAILURE' }) + '\n'); }
}
