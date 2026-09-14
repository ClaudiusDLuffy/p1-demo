import assert from 'node:assert/strict';
import { validateMigrationInventory } from './migration-inventory.mjs';
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
export const WARRANTY_BRIDGE_NAME = '0148_bridge_authoritative_staff_warranty_lines.sql';

// Validate the entire merged filename/hash inventory before selecting either
// the canonical upstream hotfix characterization or final bridge acceptance.
export function assertWarrantyMigrationOrder(sources) {
  return validateMigrationInventory(sources);
}

export function warrantyMigrationSources(repo, canonicalUpstream = false) {
  const sources = new Map(readdirSync(`${repo}/supabase/migrations`)
    .filter(name => name.endsWith('.sql'))
    .map(name => [name, readFileSync(`${repo}/supabase/migrations/${name}`, 'utf8')]));
  const ordered = assertWarrantyMigrationOrder(sources);
  const target = canonicalUpstream ? WARRANTY_MIGRATION_NAME : WARRANTY_BRIDGE_NAME;
  const maximum = canonicalUpstream ? 121 : 147;
  const base = ordered.filter(name => Number.parseInt(name, 10) <= maximum).map(name => [name, sources.get(name)]);
  return { base, warranty: [target, sources.get(target)], sources, canonicalUpstream };
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
