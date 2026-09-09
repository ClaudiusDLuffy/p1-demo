import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

// Same isolated platform stand-ins used by the existing lifecycle harness.
export async function initializeWarrantyDatabase(db) {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create function auth.role() returns text language sql stable as $$select coalesce(current_setting('request.jwt.claim.role',true),'')$$;
    create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('request.jwt.claims',true),'')::jsonb,'{}'::jsonb)$$;
    grant usage on schema auth,public,storage to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,owner uuid,metadata jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
    alter table storage.objects enable row level security;
    create publication supabase_realtime;
    alter default privileges in schema public grant all on tables to authenticated,service_role;
    alter default privileges in schema public grant all on sequences to authenticated,service_role;
  `);
}

// Dollar-quote-aware splitting permits the repository's transactional enum
// migrations to execute exactly as the established synthetic harness does.
export function migrationStatements(sql) {
  const parts = []; let start = 0, quote = '', dollar = '', block = 0, line = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i], n = sql[i + 1];
    if (line) { if (c === '\n') line = false; continue; }
    if (block) { if (c === '/' && n === '*') { block++; i++; } else if (c === '*' && n === '/') { block--; i++; } continue; }
    if (dollar) { if (sql.startsWith(dollar, i)) { i += dollar.length - 1; dollar = ''; } continue; }
    if (quote) { if (c === quote) { if (n === quote) i++; else quote = ''; } continue; }
    if (c === '-' && n === '-') { line = true; i++; continue; }
    if (c === '/' && n === '*') { block = 1; i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '$') { const tag = sql.slice(i).match(/^\$(?:[A-Za-z_][\w]*)?\$/)?.[0]; if (tag) { dollar = tag; i += tag.length - 1; continue; } }
    if (c === ';') { parts.push(sql.slice(start, i + 1)); start = i + 1; }
  }
  if (sql.slice(start).trim()) parts.push(sql.slice(start));
  return parts;
}

export const WARRANTY_MIGRATION_NAME = '0122_allow_zero_rate_staff_warranty_lines.sql';
const HISTORICAL_DUPLICATE_0029 = ['0029_add_p5_priority.sql', '0029_invoice_type.sql'];

export function assertWarrantyMigrationOrder(names) {
  const versions = new Map();
  for (const name of names) {
    assert.match(name, /^\d{4}_.*\.sql$/, 'Unexpected migration filename');
    const version = Number.parseInt(name, 10);
    const matches = versions.get(version) ?? [];
    matches.push(name);
    versions.set(version, matches);
  }
  for (const [version, matches] of versions) {
    if (matches.length === 1) continue;
    // This exact duplicate pair predates the hotfix in committed dev. It is
    // preserved, not certified as a deployable clean Supabase migration ledger.
    assert.deepEqual(matches.slice().sort(), HISTORICAL_DUPLICATE_0029,
      `Unexpected duplicate migration version ${version}; do not merge fixture histories into a release sequence`);
  }
  assert.deepEqual([...versions.keys()].sort((a, b) => a - b),
    Array.from({ length: 122 }, (_, index) => index + 1),
    'Expected current dev through 0121 and the sequential 0122 Warranty migration only');
  assert.deepEqual(versions.get(122), [WARRANTY_MIGRATION_NAME],
    'The next dev migration must uniquely be the Warranty change');
}

export function warrantyMigrationSources(repo, stabilizationRef) {
  const sources = new Map(readdirSync(`${repo}/supabase/migrations`)
    .filter(name => /^\d+.*\.sql$/.test(name))
    .map(name => [name, readFileSync(`${repo}/supabase/migrations/${name}`, 'utf8')]));
  assertWarrantyMigrationOrder([...sources.keys()]);
  const base = [...sources].filter(([name]) => Number.parseInt(name, 10) <= 121)
    .sort(([a], [b]) => a.localeCompare(b));
  const warranty = [WARRANTY_MIGRATION_NAME, sources.get(WARRANTY_MIGRATION_NAME)];
  const stabilization = [];
  if (stabilizationRef) {
    assert.match(stabilizationRef, /^[a-f0-9]{7,40}$/, 'Only an immutable local commit ID is accepted');
    const tree = `${stabilizationRef}^3`;
    const names = execFileSync('git', ['ls-tree', '-r', '--name-only', tree, '--', 'supabase/migrations'], {
      cwd: repo, encoding: 'utf8',
    }).trim().split('\n').filter(path => /\/01(?:2[2-9]|3[0-2])_.*\.sql$/.test(path));
    names.sort();
    assert.deepEqual(names.map(path => Number.parseInt(path.split('/').at(-1), 10)),
      Array.from({ length: 11 }, (_, index) => index + 122),
      'Expected exactly the preserved, uniquely numbered stabilization migrations 0122 through 0132');
    for (const path of names) {
      const name = path.split('/').at(-1);
      const content = execFileSync('git', ['show', `${tree}:${path}`], { cwd: repo, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
      stabilization.push([name, content]);
    }
  }
  // These are distinct histories. Never combine/sort Warranty 0122 alongside
  // stabilization 0122 and call that a valid migration/ledger installation.
  // The optional fixture checks definitions through old 0132, then applies the
  // Warranty SQL body in isolation. A future real merge needs resequencing of
  // unapplied stabilization files and a post-financial-expansion forward bridge.
  return { base, warranty, stabilization };
}

export async function applyWarrantyFixtureMigration(db, name, source) {
  if (name.startsWith('0105_')) {
    const emails = [...new Set(source.match(/[a-z0-9.]+@[a-z0-9.]+\.[a-z]+/g))];
    await db.exec("insert into public.organizations(id,name,slug,active) values ('10000000-0000-4000-8000-000000000001','Fixture Company','fixture-company',true)");
    for (const [i, email] of emails.entries()) {
      const id = `20000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
      await db.query('insert into auth.users(id,email) values ($1,$2)', [id, email]);
      await db.query("update public.profiles set contractor_organization_id='10000000-0000-4000-8000-000000000001',contractor_access_level='report_only',name=$2 where id=$1", [id, `Fixture ${i + 1}`]);
      if (i === 0) await db.query("update public.organizations set canonical_contractor_id=$1 where id='10000000-0000-4000-8000-000000000001'", [id]);
    }
  }
  if (name.startsWith('0108_')) {
    const email = source.match(/[a-z0-9.]+@[a-z0-9.]+\.[a-z]+/)[0];
    await db.query('insert into auth.users(id,email) values ($1,$2)', ['30000000-0000-4000-8000-000000000001', email]);
    await db.exec("update public.profiles set role='back_office',name='Accounting Fixture' where id='30000000-0000-4000-8000-000000000001'");
  }
  for (const statement of migrationStatements(source)) await db.exec(statement);
}

export const asWarrantyActor = db => (role, actor, run) => db.transaction(async tx => {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await tx.exec(`set local role ${role}`);
  await tx.query("select set_config('request.jwt.claim.role',$1,true),set_config('request.jwt.claim.sub',$2,true)", [role, actor || '']);
  return run(tx);
});
