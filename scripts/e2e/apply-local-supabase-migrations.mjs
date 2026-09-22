import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsDirectory = join(repositoryRoot, "supabase/migrations");
const container = "supabase_db_p1-demo-e2e";
const project = "p1-demo-e2e";

function runDocker(arguments_, options = {}) {
  const result = spawnSync("docker", arguments_, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `Docker command failed (${arguments_.join(" ")}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function assertDisposableTarget() {
  const actualProject = runDocker([
    "inspect",
    container,
    "--format",
    "{{index .Config.Labels \"com.supabase.cli.project\"}}",
  ]);
  assert.equal(
    actualProject,
    project,
    `Refusing to touch Docker project ${actualProject || "<unknown>"}`,
  );
}

function runPsql(sql, label) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      container,
      "psql",
      "--username",
      "postgres",
      "--dbname",
      "postgres",
      "--set",
      "ON_ERROR_STOP=1",
      "--quiet",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      input: sql,
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${result.stderr || result.stdout}`);
  }
}

function sqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function sourceEmails(source) {
  return [...new Set(source.match(/[a-z0-9.]+@[a-z0-9.]+\.[a-z]+/g) ?? [])];
}

function install0105CompatibilityFixture(source) {
  const emails = sourceEmails(source);
  assert.equal(emails.length, 5, "0105 compatibility email inventory changed");
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const statements = [
    "begin;",
    `insert into public.organizations(id,name,slug,active) values (`
      + `${sqlLiteral(organizationId)}::uuid,'Synthetic migration fixture','synthetic-migration-fixture',true);`,
  ];
  for (const [index, email] of emails.entries()) {
    const id = `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    const fixtureName = `Synthetic Fixture ${index + 1}`;
    statements.push(
      `insert into auth.users (`
        + `id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at`
        + `) values (`
        + `${sqlLiteral(id)}::uuid,'authenticated','authenticated',${sqlLiteral(email)},now(),`
        + `'${JSON.stringify({ provider: "email", providers: ["email"] })}'::jsonb,`
        + `'${JSON.stringify({ name: fixtureName, role: "contractor" })}'::jsonb,now(),now());`,
      `update public.profiles set contractor_organization_id=${sqlLiteral(organizationId)}::uuid,`
        + ` contractor_access_level='report_only', name=${sqlLiteral(fixtureName)}`
        + ` where id=${sqlLiteral(id)}::uuid;`,
    );
  }
  statements.push(
    `update public.organizations set canonical_contractor_id=`
      + `'20000000-0000-4000-8000-000000000001'::uuid`
      + ` where id=${sqlLiteral(organizationId)}::uuid;`,
    "commit;",
  );
  runPsql(statements.join("\n"), "0105 compatibility fixture");
}

function install0108CompatibilityFixture(source) {
  const emails = sourceEmails(source);
  assert.equal(emails.length, 1, "0108 compatibility email inventory changed");
  const id = "30000000-0000-4000-8000-000000000001";
  const metadata = JSON.stringify({ name: "Synthetic Accounting Fixture", role: "back_office" });
  runPsql(`
    begin;
    insert into auth.users (
      id,aud,role,email,email_confirmed_at,raw_app_meta_data,raw_user_meta_data,created_at,updated_at
    ) values (
      ${sqlLiteral(id)}::uuid,'authenticated','authenticated',${sqlLiteral(emails[0])},now(),
      '{"provider":"email","providers":["email"]}'::jsonb,
      ${sqlLiteral(metadata)}::jsonb,now(),now()
    );
    update public.profiles
      set role='back_office', name='Synthetic Accounting Fixture'
      where id=${sqlLiteral(id)}::uuid;
    commit;
  `, "0108 compatibility fixture");
}

function removeHistoricalCompatibilityFixtures() {
  const contractorIds = Array.from(
    { length: 5 },
    (_, index) => `20000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  );
  const accountingId = "30000000-0000-4000-8000-000000000001";
  const organizationId = "10000000-0000-4000-8000-000000000001";
  const ids = [...contractorIds, accountingId].map(id => `${sqlLiteral(id)}::uuid`).join(",");
  const contractorIdList = contractorIds.map(id => `${sqlLiteral(id)}::uuid`).join(",");
  runPsql(`
    begin;
    delete from public.contractor_technicians
      where contractor_id in (${contractorIdList}) or profile_id in (${contractorIdList});
    update public.organizations set canonical_contractor_id=null
      where id=${sqlLiteral(organizationId)}::uuid;
    update public.profiles
      set contractor_organization_id=null, contractor_access_level=null
      where id in (${contractorIdList});
    delete from public.organizations where id=${sqlLiteral(organizationId)}::uuid;
    delete from auth.users where id in (${ids});
    commit;
  `, "historical compatibility fixture cleanup");

  const remaining = runDocker([
    "exec",
    container,
    "psql",
    "--username",
    "postgres",
    "--dbname",
    "postgres",
    "--tuples-only",
    "--no-align",
    "--command",
    `select count(*) from auth.users where id in (${ids});`,
  ]);
  assert.equal(remaining, "0", "Historical compatibility identities were not removed");
}

assertDisposableTarget();

const migrationNames = readdirSync(migrationsDirectory)
  .filter(name => /^\d+.*\.sql$/.test(name))
  .sort();
assert.equal(migrationNames.length, 165, "Migration inventory changed; review the local installer");

for (const [index, name] of migrationNames.entries()) {
  const source = readFileSync(join(migrationsDirectory, name), "utf8");
  if (name.startsWith("0105_")) install0105CompatibilityFixture(source);
  if (name.startsWith("0108_")) install0108CompatibilityFixture(source);
  process.stdout.write(`Applying ${String(index + 1).padStart(3, "0")}/${migrationNames.length} ${name}\n`);
  runPsql(source, name);
}

removeHistoricalCompatibilityFixtures();
process.stdout.write(`Applied ${migrationNames.length} migrations to ${project}; compatibility fixtures removed.\n`);
