// Verification subprocess only. This module is never imported by application
// code or enabled in a deployment. Keep .env content and real provider I/O out
// of a synthetic production build, including its child Node processes.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { threadId } from 'node:worker_threads';

const proofDirectory = process.env.P1_SYNTHETIC_BUILD_PROOF_DIR;
if (!proofDirectory || !/^\/private\/tmp\/p1-phase-5d-build-[A-Za-z0-9]+\/guards$/.test(proofDirectory)) {
  throw new Error('Synthetic build proof directory is required');
}
const writeProof = fs.writeFileSync.bind(fs);
const proof = { pid: process.pid, threadId, selfTest: process.env.P1_SYNTHETIC_BUILD_SELF_TEST === '1', environmentProbesBlocked: 0, environmentReadsBlocked: 0, networkBlocked: 0, fontRequests: 0, localPipeRequests: 0, blockedKinds: [] };
const persist = () => writeProof(path.join(proofDirectory, `${process.pid}-${threadId}.json`), JSON.stringify(proof));
const count = key => { proof[key]++; persist(); };
// Next terminates compiler workers on a build failure. Persist before I/O,
// not only on exit, so a killed worker cannot lose its guard receipt.
persist();
const environmentFile = value => {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  return typeof value === 'string' && /^\.env(?:\.|$)/.test(path.basename(value));
};
const missing = () => Object.assign(new Error('Environment files are excluded from synthetic verification'), { code: 'ENOENT' });
for (const name of ['statSync', 'lstatSync', 'readFileSync', 'openSync', 'createReadStream']) {
  const original = fs[name].bind(fs);
  fs[name] = (...args) => {
    if (environmentFile(args[0])) {
      count(name.includes('stat') ? 'environmentProbesBlocked' : 'environmentReadsBlocked');
      throw missing();
    }
    return original(...args);
  };
}
const exists = fs.existsSync.bind(fs);
fs.existsSync = value => {
  if (environmentFile(value)) { count('environmentProbesBlocked'); return false; }
  return exists(value);
};
for (const name of ['stat', 'lstat', 'readFile', 'open']) {
  const original = fs[name].bind(fs);
  fs[name] = (...args) => {
    if (environmentFile(args[0])) {
      count(name.includes('stat') ? 'environmentProbesBlocked' : 'environmentReadsBlocked');
      const callback = args.at(-1);
      if (typeof callback === 'function') { queueMicrotask(() => callback(missing())); return; }
      throw missing();
    }
    return original(...args);
  };
  const promised = fs.promises[name].bind(fs.promises);
  fs.promises[name] = async (...args) => {
    if (environmentFile(args[0])) {
      count(name.includes('stat') ? 'environmentProbesBlocked' : 'environmentReadsBlocked');
      throw missing();
    }
    return promised(...args);
  };
}

const fontHosts = new Set(['fonts.googleapis.com', 'fonts.gstatic.com']);
const hostname = value => {
  if (value instanceof URL) return value.hostname;
  if (typeof value === 'string') {
    if (/^https?:\/\//.test(value)) { try { return new URL(value).hostname; } catch { return ''; } }
    return value;
  }
  if (value && typeof value === 'object') {
    if (typeof value.url === 'string') return hostname(value.url);
    return value.servername ?? value.hostname ?? value.host ?? '';
  }
  return '';
};
const allowFont = (value, transport) => {
  const host = hostname(value);
  if (!fontHosts.has(host)) {
    const category = host.startsWith('/') ? 'local_path' : host === 'localhost' || host === '127.0.0.1' ? 'loopback' : !host ? 'unspecified' : 'other';
    proof.blockedKinds.push(`${transport}:${category}`);
    count('networkBlocked');
    throw new Error('SYNTHETIC_BUILD_NETWORK_DISABLED');
  }
  count('fontRequests');
};
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, init) => { allowFont(input, 'fetch'); return fetchOriginal(input, init); };
for (const transport of [http, https]) for (const name of ['request', 'get']) {
  const original = transport[name].bind(transport);
  transport[name] = (...args) => { allowFont(args[0], 'http'); return original(...args); };
}
const networkTarget = args => typeof args[0] === 'object' ? args[0] : typeof args[1] === 'object' ? args[1] : args[1];
for (const name of ['connect', 'createConnection']) {
  const original = net[name].bind(net);
  net[name] = (...args) => {
    const target = args[0];
    const localPipe = typeof target === 'string' && target.startsWith('/')
      || target && typeof target === 'object' && typeof target.path === 'string' && target.path.startsWith('/');
    if (!localPipe) allowFont(networkTarget(args), 'net');
    else count('localPipeRequests');
    return original(...args);
  };
}
const socketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  // Node also uses this form for IPC pipes; allow only an explicit local path,
  // never an address/port as a substitute for a provider connection.
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const localPipe = typeof options === 'string' && options.startsWith('/')
    || options && typeof options === 'object' && typeof options.path === 'string' && options.path.startsWith('/');
  if (!localPipe) allowFont(options, 'socket');
  else count('localPipeRequests');
  return socketConnect.apply(this, args);
};
const tlsConnect = tls.connect.bind(tls);
tls.connect = (...args) => { allowFont(networkTarget(args), 'tls'); return tlsConnect(...args); };
const lookup = dns.lookup.bind(dns);
dns.lookup = (...args) => { allowFont(args[0], 'dns'); return lookup(...args); };
const lookupPromise = dns.promises.lookup.bind(dns.promises);
dns.promises.lookup = async (...args) => { allowFont(args[0], 'dns'); return lookupPromise(...args); };
syncBuiltinESMExports();
process.once('exit', persist);
