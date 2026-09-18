import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { localSupabaseRuntime, syntheticPassword } from "./local-supabase-runtime.mjs";

const accounts = [
  ["manager_id", "e2e.manager@p1.invalid", "Synthetic Manager", "manager"],
  ["dispatcher_id", "e2e.dispatcher@p1.invalid", "Synthetic Dispatcher", "dispatcher"],
  ["backoffice_id", "e2e.backoffice@p1.invalid", "Synthetic Back Office", "back_office"],
  ["controller_id", "e2e.controller@p1.invalid", "Synthetic Controller", "back_office"],
  ["accounting_id", "e2e.accounting@p1.invalid", "Synthetic Accounting", "back_office"],
  ["direct_id", "e2e.direct@p1.invalid", "Synthetic Direct Contractor", "contractor"],
  ["company_admin_id", "e2e.company.admin@p1.invalid", "Synthetic Company Admin", "contractor"],
  ["company_admin_2_id", "e2e.company.admin2@p1.invalid", "Synthetic Company Admin Two", "contractor"],
  ["invoice_tech_id", "e2e.invoice.tech@p1.invalid", "Synthetic Invoice Technician", "contractor"],
  ["revocation_tech_id", "e2e.revocation.tech@p1.invalid", "Synthetic Revocation Technician", "contractor"],
  ["report_tech_id", "e2e.report.tech@p1.invalid", "Synthetic Report Technician", "contractor"],
  ["team_lead_id", "e2e.team.lead@p1.invalid", "Synthetic Team Lead", "contractor"],
  ["team_member_id", "e2e.team.member@p1.invalid", "Synthetic Team Member", "contractor"],
];

function headers(secret) {
  return { apikey: secret, Authorization: `Bearer ${secret}`, "Content-Type": "application/json" };
}

async function adminRequest(runtime, path, init = {}) {
  const response = await fetch(new URL(path, runtime.NEXT_PUBLIC_SUPABASE_URL), {
    ...init,
    headers: { ...headers(runtime.SUPABASE_SECRET_KEY), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Local auth fixture request failed (${response.status}).`);
  return body;
}

async function ensureUsers(runtime) {
  const listed = await adminRequest(runtime, "/auth/v1/admin/users?page=1&per_page=100");
  const existing = new Map((listed.users || []).map(user => [user.email?.toLowerCase(), user]));
  const ids = {};
  for (const [variable, email, name, role] of accounts) {
    const found = existing.get(email);
    const payload = {
      email,
      password: runtime.P1_E2E_PASSWORD || syntheticPassword,
      email_confirm: true,
      // A revocation scenario deliberately bans one disposable account. Every
      // seed is a full synthetic reset, so restore login eligibility as well
      // as the profile/link rows before the next run.
      ban_duration: "none",
      user_metadata: { name, role, synthetic_e2e: true },
    };
    const user = found
      ? await adminRequest(runtime, `/auth/v1/admin/users/${found.id}`, { method: "PUT", body: JSON.stringify(payload) })
      : await adminRequest(runtime, "/auth/v1/admin/users", { method: "POST", body: JSON.stringify(payload) });
    ids[variable] = user.id;
  }
  return ids;
}

async function main() {
  const runtime = localSupabaseRuntime();
  const ids = await ensureUsers(runtime);
  const sql = readFileSync(resolve(process.cwd(), "scripts/e2e/seed-local-synthetic.sql"), "utf8");
  const variables = Object.entries(ids).flatMap(([name, value]) => ["--set", `${name}=${value}`]);
  execFileSync(
    "docker",
    ["exec", "-i", "supabase_db_p1-demo-e2e", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres", ...variables],
    { input: sql, stdio: ["pipe", "pipe", "inherit"], maxBuffer: 4 * 1024 * 1024 },
  );
  console.log(JSON.stringify({ seeded: true, accounts: accounts.length, workOrders: 46, productionDataUsed: false }, null, 2));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : "Synthetic E2E seed failed.");
  process.exitCode = 1;
});
