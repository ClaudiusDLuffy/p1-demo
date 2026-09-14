// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// The owner grandfathered these exact two paths AND hashes, not prefix 0029.
export const HISTORICAL_0029 = Object.freeze({
  '0029_add_p5_priority.sql': 'a91a76841c42b5ea729a005647d359d55ab842000f5ba1e4b661e7485d5f51a3',
  '0029_invoice_type.sql': '6cfdd9f7be1fdc72808bb794fcebfd3eeba4422d936a0becdaf5a0e83415d726',
});

/** @param {ReadonlyMap<string, string | Buffer>} sources */
export function validateMigrationInventory(sources) {
  const names = [...sources.keys()].sort();
  /** @type {Map<number, string[]>} */
  const versions = new Map();
  for (const name of names) {
    assert.match(name, /^\d{4}_[a-z0-9_]+\.sql$/, 'Unexpected migration filename');
    const version = Number(name.slice(0, 4));
    assert.ok(version > 0, 'Migration version must be positive');
    const peers = versions.get(version) ?? [];
    peers.push(name);
    versions.set(version, peers);
    if (version === 29) {
      assert.ok(Object.hasOwn(HISTORICAL_0029, name), 'Unapproved historical 0029 migration');
      const expected = HISTORICAL_0029[/** @type {keyof typeof HISTORICAL_0029} */ (name)];
      const content = sources.get(name);
      assert.ok(content !== undefined, 'Missing migration source');
      assert.equal(createHash('sha256').update(content).digest('hex'), expected,
        `Historical migration hash changed: ${name}`);
    }
  }
  for (const [version, peers] of versions) {
    if (version === 29) {
      assert.deepEqual(peers, Object.keys(HISTORICAL_0029).sort(), 'The exact historical 0029 pair must be present');
    } else {
      assert.equal(peers.length, 1, `Unexpected duplicate migration version ${version}`);
    }
  }
  const maximum = Math.max(0, ...versions.keys());
  assert.ok(maximum >= 29, 'Complete migration inventory must include the historical 0029 pair');
  assert.deepEqual([...versions.keys()], Array.from({ length: maximum }, (_, index) => index + 1),
    'Migration sequence must be contiguous from 0001');
  return names;
}

/** Validate the whole inventory before selecting a clean/upgrade stage.
 * @param {string} repo */
export function readMigrationInventory(repo) {
  const folder = resolve(repo, 'supabase/migrations');
  const sources = new Map(readdirSync(folder).filter(name => name.endsWith('.sql'))
    .map(name => [name, readFileSync(resolve(folder, name))]));
  return validateMigrationInventory(sources);
}
