// Backfill response_breach_at and resolution_breach_at on every existing
// work order. Run AFTER applying supabase/migrations/0004_sla_two_breaches.sql.
//
//   npx tsx scripts/backfill-sla-breaches.ts
//
// Idempotent — only fills rows where response_breach_at IS NULL. The migration
// already set sla_started_at = created_at for legacy rows; this script reads
// that field plus the priority and computes both deadlines.

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { resolve } from "path";
import { computeSlaBreaches, type Priority } from "../src/lib/slaConfig";

config({ path: resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
if (!SUPABASE_URL || !SECRET) {
  console.error("Missing env vars in .env.local — need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SECRET, { auth: { autoRefreshToken: false, persistSession: false } });

async function main() {
  const { data: rows, error } = await sb.from("work_orders")
    .select("id, priority, sla_started_at, created_at, response_breach_at, resolution_breach_at")
    .is("response_breach_at", null);
  if (error) { console.error(error); process.exit(1); }
  if (!rows || rows.length === 0) {
    console.log("Nothing to backfill — all rows already have breach times.");
    return;
  }
  console.log(`Backfilling ${rows.length} work order${rows.length === 1 ? "" : "s"}…`);
  let updated = 0;
  let skipped = 0;
  for (const row of rows) {
    const startedIso = row.sla_started_at || row.created_at;
    if (!startedIso) { skipped++; continue; }
    const breaches = computeSlaBreaches(row.priority as Priority, new Date(startedIso));
    const { error: upErr } = await sb.from("work_orders").update({
      sla_started_at: startedIso,
      response_breach_at: breaches.responseBreachAt.toISOString(),
      resolution_breach_at: breaches.resolutionBreachAt.toISOString(),
    }).eq("id", row.id);
    if (upErr) { console.error(`  ${row.id}: ${upErr.message}`); skipped++; continue; }
    updated++;
  }
  console.log(`Done — updated ${updated}, skipped ${skipped}.`);
}

main().catch(err => { console.error(err); process.exit(1); });
