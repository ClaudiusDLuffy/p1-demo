import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export async function initializeSupabaseFixtureDatabase(db) {
  // SQL-only platform stand-ins: no Auth gateway, Storage API or remote data.
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage; create schema extensions;
    create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.role() returns text language sql stable as $$ select coalesce(current_setting('request.jwt.claim.role', true), '') $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb) $$;
    grant usage on schema auth, public, storage to anon, authenticated, service_role;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz default now(), updated_at timestamptz default now());
    alter table storage.objects enable row level security;
    create publication supabase_realtime;
    alter default privileges in schema public grant all on tables to authenticated, service_role;
    alter default privileges in schema public grant all on sequences to authenticated, service_role;
  `);
}

export async function applyFixtureMigration({ db, repo, name, statements }) {
  const source = readFileSync(`${repo}/supabase/migrations/${name}`, 'utf8');
  if (name.startsWith('0105_')) {
    // Empty identities required by committed historical repair migrations.
    // These are extracted only from versioned source, never external records.
    const emails = [...new Set(source.match(/[a-z0-9.]+@[a-z0-9.]+\.[a-z]+/g))];
    await db.exec("insert into public.organizations(id,name,slug,active) values ('10000000-0000-4000-8000-000000000001','Fixture Company','fixture-company',true)");
    for (const [index, email] of emails.entries()) {
      const id = `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      await db.query('insert into auth.users(id,email) values ($1,$2)', [id, email]);
      await db.query("update public.profiles set contractor_organization_id='10000000-0000-4000-8000-000000000001', contractor_access_level='report_only', name=$2 where id=$1", [id, `Fixture ${index + 1}`]);
      if (index === 0) await db.query("update public.organizations set canonical_contractor_id=$1 where id='10000000-0000-4000-8000-000000000001'", [id]);
    }
  }
  if (name.startsWith('0108_')) {
    const email = source.match(/[a-z0-9.]+@[a-z0-9.]+\.[a-z]+/)[0];
    await db.query('insert into auth.users(id,email) values ($1,$2)', ['30000000-0000-4000-8000-000000000001', email]);
    await db.exec("update public.profiles set role='back_office',name='Accounting Fixture' where id='30000000-0000-4000-8000-000000000001'");
  }
  for (const statement of statements(source)) await db.exec(statement);
}

export async function initializeLifecycleActors(db) {
  const actors = {
    mgr: '40000000-0000-4000-8000-000000000001',
    controller: '40000000-0000-4000-8000-000000000002',
    inactive: '40000000-0000-4000-8000-000000000003',
    contractor: '40000000-0000-4000-8000-000000000004',
    outsider: '40000000-0000-4000-8000-000000000005',
  };
  for (const [id, role, active] of [
    [actors.mgr, 'manager', true], [actors.controller, 'back_office', true],
    [actors.inactive, 'dispatcher', false], [actors.contractor, 'contractor', true],
    [actors.outsider, 'contractor', true],
  ]) {
    await db.query('insert into auth.users(id,email) values ($1,$2)', [id, `${id}@example.invalid`]);
    await db.query('update public.profiles set role=$2,active=$3,is_assignable=true where id=$1', [id, role, active]);
  }
  await db.query("insert into public.staff_permission_grants(profile_id,permission) values ($1,'invoice_controller')", [actors.controller]);
  return actors;
}

export const actorTransactions = db => (role, id, fn) => db.transaction(async tx => {
  assert.ok(['anon', 'authenticated', 'service_role'].includes(role));
  await tx.exec(`set local role ${role}`);
  await tx.query("select set_config('request.jwt.claim.role',$1,true), set_config('request.jwt.claim.sub',$2,true)", [role, id || '']);
  return fn(tx);
});
