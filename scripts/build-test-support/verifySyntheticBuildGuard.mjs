import assert from 'node:assert/strict';
import fs from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import dns from 'node:dns';
import { fork } from 'node:child_process';
import { Worker, isMainThread } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';

// Only synthetic paths/hosts: never open an actual environment file or socket.
const excluded = '/private/tmp/.env.synthetic-build-self-test';
assert.equal(fs.existsSync(excluded), false);
assert.throws(() => fs.readFileSync(excluded), { code: 'ENOENT' });
await assert.rejects(fs.promises.readFile(excluded), { code: 'ENOENT' });
await new Promise(resolve => fs.readFile(excluded, error => { assert.equal(error.code, 'ENOENT'); resolve(); }));
for (const send of [() => fetch('https://graph.example.invalid/blocked'),
  () => https.request('https://twilio.example.invalid/blocked'),
  () => net.connect({ host: 'synthetic.example.invalid', port: 443 }),
  () => dns.lookup('synthetic.example.invalid', () => {})]) {
  assert.throws(send, /SYNTHETIC_BUILD_NETWORK_DISABLED/);
}
if (isMainThread && !process.argv.includes('--child')) {
  const child = fork(fileURLToPath(import.meta.url), ['--child'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => {
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Fork guard self-test failed')));
  });
  const worker = new Worker(new URL(import.meta.url));
  await new Promise((resolve, reject) => {
    worker.once('error', reject); worker.once('exit', code => code === 0 ? resolve() : reject(new Error('Thread guard self-test failed')));
  });
  console.log('Synthetic guard: parent, fork and worker thread blocked environment reads and four network transports.');
}
