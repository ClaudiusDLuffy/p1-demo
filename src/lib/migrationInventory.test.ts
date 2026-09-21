import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { HISTORICAL_0029, validateMigrationInventory } from '../../scripts/migration-inventory.mjs';

const folder = fileURLToPath(new URL('../../supabase/migrations/', import.meta.url));
const sources = () => new Map(readdirSync(folder).filter(name => name.endsWith('.sql'))
  .map(name => [name, readFileSync(`${folder}/${name}`)]));

test('final migration inventory permits only the exact byte-pinned historical pair in deterministic order', () => {
  const input = sources();
  const names = validateMigrationInventory(input);
  assert.deepEqual(names, [...input.keys()].sort());
  assert.deepEqual(names.filter(name => name.startsWith('0029_')), Object.keys(HISTORICAL_0029));
  assert.equal(names.length, 163);
  assert.equal(names.at(-1), '0162_enforce_field_event_time_order.sql');
  for (const [name, hash] of Object.entries(HISTORICAL_0029)) {
    assert.equal(createHash('sha256').update(input.get(name)!).digest('hex'), hash);
  }
});

test('any byte change or missing member of the historical pair fails closed', () => {
  for (const name of Object.keys(HISTORICAL_0029)) {
    const changed = sources();
    changed.set(name, Buffer.concat([changed.get(name)!, Buffer.from('\n')]));
    assert.throws(() => validateMigrationInventory(changed), /Historical migration hash changed/);
    changed.delete(name);
    assert.throws(() => validateMigrationInventory(changed), /exact historical 0029 pair/);
  }
});

test('a third 0029, every other duplicate and every sequence gap fails closed', () => {
  for (const [name, message] of [
    ['0029_third.sql', /Unapproved historical 0029/],
    ['0122_collision.sql', /duplicate migration version 122/],
    ['0148_collision.sql', /duplicate migration version 148/],
    ['0149_collision.sql', /duplicate migration version 149/],
  ] as const) {
    const changed = sources();
    changed.set(name, Buffer.from('select 1;'));
    assert.throws(() => validateMigrationInventory(changed), message);
  }
  const gap = sources();
  gap.delete('0122_allow_zero_rate_staff_warranty_lines.sql');
  assert.throws(() => validateMigrationInventory(gap), /contiguous/);
});
