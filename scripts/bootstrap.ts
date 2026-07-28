// Run AFTER applying supabase/migrations/0001_initial_schema.sql in the SQL Editor.
//
//   npx tsx scripts/bootstrap.ts
//
// What it does:
//   1. Creates auth users for the 9 P1 team members + 8 contractor leads (one-time)
//   2. Inserts AFMs, stores, work orders, invoices + lines, activities
//   3. Idempotent — safe to re-run; existing users are skipped
//
// Default password for every user: `p1demo2026!`  (change after testing)

import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";
import { readFileSync } from "fs";
import { resolve } from "path";

config({ path: resolve(process.cwd(), ".env.local") });

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SECRET = process.env.SUPABASE_SECRET_KEY!;
if (!SUPABASE_URL || !SECRET) {
  console.error("Missing env vars in .env.local — need NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SECRET, { auth: { autoRefreshToken: false, persistSession: false } });
const DEFAULT_PASSWORD = "p1demo2026!";

type Seed = {
  email: string;
  name: string;
  initials: string;
  role: "manager" | "dispatcher" | "back_office" | "contractor";
  title?: string;
  company?: string;
  phone?: string;
  territory?: string;
  trades?: string[];
  color: string;
};

const USERS: Seed[] = [
  // P1 internal — owners
  { email: "claytonetchison@gmail.com", name: "Clay Etchison", initials: "CE", role: "manager", title: "Owner", color: "#1F1E1C" },
  { email: "gustavo@myamzteam.com", name: "Jeremy Barry", initials: "JB", role: "manager", title: "Owner", color: "#C15F3C" },
  { email: "eddie@phospitality.com", name: "Eddie Pozzuoli", initials: "EP", role: "manager", title: "Owner", color: "#5B4B8A" },
  // Dispatcher
  { email: "landryd@phospitality.com", name: "Landry Dillinger", initials: "LD", role: "dispatcher", title: "Dispatcher", color: "#A67C00" },
  // Back office
  { email: "lynzy@p1pros.com", name: "Lynzy Barry", initials: "LB", role: "back_office", title: "Back office", color: "#4A7C59" },
  { email: "mandy@p1pros.com", name: "Mandy Lee", initials: "ML", role: "back_office", title: "Back office", color: "#7C3AED" },
  { email: "lynette@p1pros.com", name: "Lynette", initials: "LY", role: "back_office", title: "Back office", color: "#0891B2" },
  { email: "kim@p1pros.com", name: "Kim", initials: "KM", role: "back_office", title: "Back office", color: "#EC4899" },
  { email: "emilyb@phospitality.com", name: "Emily Barnhart", initials: "EB", role: "back_office", title: "Back office", color: "#10B981" },
  // Contractors
  { email: "scrcdallastexas@gmail.com", name: "Derek Starnes", initials: "DS", role: "contractor", company: "Starnes Commercial Refrigeration", territory: "Dallas, TX", trades: ["hvac", "refrigeration", "beverage", "ice"], color: "#0891B2" },
  { email: "service@archerref.com", name: "Archer Refrigeration", initials: "AR", role: "contractor", company: "Archer Refrigeration, LLC", territory: "Houston, TX", trades: ["hvac", "refrigeration", "ice"], color: "#8B5CF6" },
  { email: "pro.ops.inc@gmail.com", name: "Pro-Ops", initials: "PO", role: "contractor", phone: "757-256-8511", company: "Pro-Ops, Inc", territory: "Virginia Beach, VA", trades: ["hvac", "refrigeration", "ice"], color: "#F59E0B" },
  // Same Day Repair + Shecan already existed under a contact-person name —
  // company strings normalized to Jeremy's rate table (NOT new rows).
  { email: "vpdmitry@gmail.com", name: "Demytro Bichukov", initials: "DB", role: "contractor", phone: "323-557-8452", company: "Same Day Repair, Inc", territory: "Tampa, FL", trades: ["beverage", "ice"], color: "#10B981" },
  { email: "shecanfacilitymaintenance@gmail.com", name: "Dave Lecerda", initials: "DL", role: "contractor", company: "Shecan Facility Maintenance LLC", territory: "Dallas, TX", trades: ["hotfood"], color: "#EC4899" },
  { email: "ctanksolutions@gmail.com", name: "Coleman", initials: "CO", role: "contractor", phone: "813-687-4990", company: "Coleman Tank Solutions, Inc.", territory: "Tampa, FL", trades: ["septic", "grease"], color: "#A67C00" },
  { email: "buriakmw@gmail.com", name: "Mykola Buriak", initials: "MB", role: "contractor", phone: "941-412-5494", company: "Talneglobaltrans LLC", territory: "Tampa, FL", trades: ["slurpee", "beverage"], color: "#5B4B8A" },
  { email: "plumbingdayornight@gmail.com", name: "Anytime Plumbing", initials: "AP", role: "contractor", phone: "813-792-2264", company: "Anytime Plumbing of Central Florida, Inc", territory: "Tampa, FL", trades: ["plumbing"], color: "#C15F3C" },
  { email: "matt@beardsrefrigeration.com", name: "Matt Beard", initials: "MB", role: "contractor", company: "Beards Refrigeration, LLC", territory: "Dallas, TX", trades: ["slurpee"], color: "#DC2626" },
  { email: "AMGservice01@outlook.com", name: "Anderson Mechanical", initials: "AM", role: "contractor", company: "Anderson Mechanical", territory: "Dallas, TX", trades: ["ems"], color: "#0F766E" },
  // Roster completion from Jeremy's rate table — display name = company
  // (no known contact person). No quick-access buttons; no tech seed.
  { email: "craigfassroofing@p1pros.com", name: "Craig Fass Roofing, LLC", initials: "CF", role: "contractor", company: "Craig Fass Roofing, LLC", trades: ["roofing"], color: "#B45309" },
  { email: "dynamicheatingcooling@p1pros.com", name: "Dynamic Heating & Cooling", initials: "DH", role: "contractor", company: "Dynamic Heating & Cooling", trades: ["hvac"], color: "#0E7490" },
  { email: "meloair@p1pros.com", name: "Melo Air, Inc", initials: "MA", role: "contractor", company: "Melo Air, Inc", trades: ["hvac"], color: "#7C3AED" },
  { email: "precisionplumbingsewer@p1pros.com", name: "Precision Plumbing & Sewer, LLC", initials: "PP", role: "contractor", company: "Precision Plumbing & Sewer, LLC", trades: ["plumbing"], color: "#2563EB" },
  { email: "spikeconstruction@p1pros.com", name: "Spike Construction", initials: "SC", role: "contractor", company: "Spike Construction", trades: ["construction"], color: "#65A30D" },
  { email: "westcoastcivil@p1pros.com", name: "West Coast Civil, LLC", initials: "WC", role: "contractor", company: "West Coast Civil, LLC", trades: ["construction"], color: "#9333EA" },
];

// 14 SCRC field technicians for the "Technician on Job" dropdown, linked to
// Derek Starnes (Starnes Commercial Refrigeration). tier is captured for
// future Phase 2 use only — nothing in Phase 1 filters/enforces by it.
// NOTE: Jorge's 5 are technically Mr. Freeze techs (a separate company SCRC
// dispatches to). Lumped under SCRC for Phase 1 simplicity; may resplit in Phase 2.
const SCRC_TECHS: { name: string; tier: "direct" | "mr_freeze" | "contracted" }[] = [
  { name: "Jorge Miranda Jr", tier: "mr_freeze" },
  { name: "Jorge Miranda Sr", tier: "mr_freeze" },
  { name: "Allan Morales", tier: "mr_freeze" },
  { name: "Fabian Cabrera", tier: "mr_freeze" },
  { name: "David Ramirez", tier: "mr_freeze" },
  { name: "Nick Gomez", tier: "direct" },
  { name: "Dylan Anderson", tier: "direct" },
  { name: "Clifford Yeager", tier: "direct" },
  { name: "Cole Anderson", tier: "direct" },
  { name: "Zach Anderson", tier: "contracted" },
  { name: "Gabe Moxley", tier: "contracted" },
  { name: "Patrick Petit", tier: "contracted" },
  { name: "Raymon Rush", tier: "contracted" },
  { name: "Nate Slayers", tier: "contracted" },
];

// nik@p1pros.com was a duplicate of Mykola Buriak (buriakmw@gmail.com) at
// Talneglobaltrans — same contractor. We keep Mykola (real email/phone + the
// seeded Slurpee WO) and remove the Nik placeholder. removeDuplicateNik()
// below reassigns any references to Mykola, then deletes the dup user.
const DUP_EMAIL = "nik@p1pros.com";
const DUP_KEEP_EMAIL = "buriakmw@gmail.com";

// Cache the user list once per run — listUsers per row is slow + brittle
let userListCache: any[] | null = null;
async function ensureUser(s: Seed): Promise<string> {
  if (!userListCache) {
    const { data: existing } = await sb.auth.admin.listUsers();
    userListCache = existing?.users || [];
  }
  let userId: string;
  const found = userListCache.find(u => u.email?.toLowerCase() === s.email.toLowerCase());
  if (found) {
    userId = found.id;
    // Re-running must guarantee the demo password is in sync for every account.
    // Existing users (e.g. Jeremy remapped to the gustavo@ mailbox) may have a
    // stale/unknown password — reset it so all quick-access logins behave alike.
    const { error: pwErr } = await sb.auth.admin.updateUserById(userId, {
      password: DEFAULT_PASSWORD,
      email_confirm: true,
    });
    if (pwErr) throw new Error(`password reset: ${pwErr.message}`);
  } else {
    const { data, error } = await sb.auth.admin.createUser({
      email: s.email,
      password: DEFAULT_PASSWORD,
      email_confirm: true,
      user_metadata: { name: s.name, role: s.role },
    });
    if (error) throw error;
    userId = data.user.id;
    userListCache.push(data.user);
  }
  // Insert/update profile manually — we dropped the trigger, so script handles it
  const profile = {
    id: userId,
    name: s.name,
    email: s.email,
    initials: s.initials,
    role: s.role,
    title: s.title || null,
    company: s.company || null,
    phone: s.phone || null,
    territory: s.territory || null,
    trades: s.trades || [],
    color: s.color,
  };
  const { error: pErr } = await sb.from("profiles").upsert(profile, { onConflict: "id" });
  if (pErr) throw new Error(`profile upsert: ${pErr.message}`);
  return userId;
}

const hoursAgo = (n: number) => new Date(Date.now() - n * 3600 * 1000).toISOString();

// Idempotent removal of the duplicate Talneglobaltrans contractor. Safe to
// re-run: once Nik is gone it's a no-op. References are reassigned to Mykola
// first because work_orders/invoices.contractor_id have no ON DELETE rule.
async function removeDuplicateNik() {
  const { data: dup } = await sb.from("profiles").select("id").eq("email", DUP_EMAIL).maybeSingle();
  if (!dup) { console.log("  Duplicate Nik: already removed ✓"); return; }
  const { data: keep } = await sb.from("profiles").select("id").eq("email", DUP_KEEP_EMAIL).maybeSingle();
  const dupId = dup.id;
  if (keep?.id) {
    await sb.from("work_orders").update({ contractor_id: keep.id }).eq("contractor_id", dupId);
    await sb.from("invoices").update({ contractor_id: keep.id }).eq("contractor_id", dupId);
  } else {
    // No Mykola to inherit — just detach so the FK delete can proceed.
    await sb.from("work_orders").update({ contractor_id: null, status: "unassigned", functional_status: "New" }).eq("contractor_id", dupId);
    await sb.from("invoices").update({ contractor_id: null }).eq("contractor_id", dupId);
  }
  await sb.from("activities").update({ author_id: null }).eq("author_id", dupId);
  await sb.from("photos").update({ uploader_id: null }).eq("uploader_id", dupId);
  // Deleting the auth user cascades to the profile row (profiles.id → auth.users on delete cascade).
  const { error } = await sb.auth.admin.deleteUser(dupId);
  if (error) { console.log(`  Duplicate Nik: delete failed — ${error.message}`); return; }
  console.log("  Duplicate Nik removed (references reassigned to Mykola) ✓");
}

async function main() {
  console.log("Bootstrapping P1 portal data...\n");

  // 1. Users + profiles
  const ids: Record<string, string> = {};
  for (const u of USERS) {
    process.stdout.write(`  ${u.name.padEnd(28)} `);
    try {
      const id = await ensureUser(u);
      ids[u.email] = id;
      console.log("✓");
    } catch (e: any) {
      console.log(`✗  ${e.message}`);
    }
  }
  console.log(`\nUsers: ${Object.keys(ids).length}/${USERS.length}\n`);

  // 1b. Remove the duplicate Talneglobaltrans contractor (Nik → Mykola).
  await removeDuplicateNik();

  // 1c. SCRC field technicians for the "Technician on Job" dropdown.
  const derekId = ids["scrcdallastexas@gmail.com"];
  if (derekId) {
    const techRows = SCRC_TECHS.map(t => ({ contractor_id: derekId, name: t.name, tier: t.tier, is_active: true }));
    const { error: techErr } = await sb.from("contractor_technicians").upsert(techRows, { onConflict: "contractor_id,name" });
    if (techErr) console.log(`  SCRC technicians: ✗ ${techErr.message}`);
    else console.log(`  SCRC technicians: ${techRows.length} seeded ✓`);
  } else {
    console.log("  SCRC technicians: ✗ Derek's profile id not found — skipped");
  }

  // 2. AFMs
  const afms = [
    { name: "Greg Peterman", email: "Greg.Peterman@7-11.com", region: "Dallas / Plano TX" },
    { name: "Jason Pulley", email: "Jason.Pulley@7-11.com", region: "Yorktown VA" },
    { name: "Marcus Holloway", email: "Marcus.Holloway@7-11.com", region: "Houston TX (placeholder)" },
    { name: "Sandra Mitchell", email: "Sandra.Mitchell@7-11.com", region: "Tampa FL (placeholder)" },
  ];
  console.log("Inserting AFMs...");
  const afmIds: Record<string, string> = {};
  for (const a of afms) {
    const { data, error } = await sb.from("afms").upsert({ name: a.name, email: a.email, region: a.region }, { onConflict: "email" }).select().single();
    if (error) console.log(`  ✗ ${a.name}: ${error.message}`);
    else { afmIds[a.name] = data.id; console.log(`  ✓ ${a.name}`); }
  }

  // 3. Stores
  const stores = [
    { store_number: "33321", city: "Dallas", state: "TX", address: "5712 Skillman St, Dallas, TX 75206", default_afm_id: afmIds["Greg Peterman"] },
    { store_number: "34197", city: "Plano", state: "TX", address: "1301 Preston Rd, Plano, TX 75093", default_afm_id: afmIds["Greg Peterman"] },
    { store_number: "33089", city: "Dallas", state: "TX", address: "2301 N Central Expy, Dallas, TX 75204", default_afm_id: afmIds["Greg Peterman"] },
    { store_number: "32333", city: "Yorktown", state: "VA", address: "5101 George Washington Memorial Hwy, Yorktown, VA 23692", default_afm_id: afmIds["Jason Pulley"] },
    { store_number: "35551", city: "Houston", state: "TX", address: "7810 Westheimer Rd, Houston, TX 77063", default_afm_id: afmIds["Marcus Holloway"] },
    { store_number: "41005", city: "Tampa", state: "FL", address: "3402 W Hillsborough Ave, Tampa, FL 33614", default_afm_id: afmIds["Sandra Mitchell"] },
    { store_number: "42210", city: "Tampa", state: "FL", address: "8801 N Dale Mabry Hwy, Tampa, FL 33614", default_afm_id: afmIds["Sandra Mitchell"] },
  ];
  console.log("\nInserting stores...");
  for (const s of stores) {
    const { error } = await sb.from("stores").upsert(s, { onConflict: "store_number" });
    if (error) console.log(`  ✗ #${s.store_number}: ${error.message}`);
    else console.log(`  ✓ #${s.store_number} ${s.city}`);
  }

  // 4. Work orders
  const wos = [
    { id: "FWKD11421039", incident_id: "INC24890517", store_number: "33321", city: "Dallas, TX", address: "5712 Skillman St, Dallas, TX 75206", line_of_service: "Refrigeration", business_service: "Refrigeration equipment", category: "Ice merchandiser/freezer", sub_category: "Machine not working", summary: "Ice merchandiser not cooling — product melting", description: "Ice merchandiser near front counter stopped cooling overnight.", priority: "p1", status: "assigned", functional_status: "Dispatched", contractor_id: ids["scrcdallastexas@gmail.com"], afm_id: afmIds["Greg Peterman"], afm_name: "Greg Peterman", afm_email: "Greg.Peterman@7-11.com", nte: 2500, dispatched_at: hoursAgo(8.2) },
    { id: "FWKD11290954", incident_id: "INC24395415", store_number: "34197", city: "Plano, TX", address: "1301 Preston Rd, Plano, TX 75093", line_of_service: "Cold Beverage - Equipment", business_service: "Fountain soda", category: "Fountain Machine", sub_category: "One or few flavors not dispensing", summary: "Fountain machine down — 5 flavors + ice not working", description: "Fountain machine five flavors and ice not working", priority: "p1", status: "assigned", functional_status: "Dispatched", contractor_id: ids["scrcdallastexas@gmail.com"], afm_id: afmIds["Greg Peterman"], afm_name: "Greg Peterman", afm_email: "Greg.Peterman@7-11.com", nte: 1800, dispatched_at: hoursAgo(2) },
    { id: "FWKD11234445", incident_id: "INC24158515", store_number: "32333", city: "Yorktown, VA", address: "5101 George Washington Memorial Hwy, Yorktown, VA 23692", line_of_service: "Frozen Beverage - Equipment", business_service: "Slurpee and Frozen Lemonade", category: "Slurpee Machine", sub_category: "One or few flavors not dispensing", summary: "Slurpee machine compressor failure — evaluate for repair or replacement", description: "Upon arrival, found entire slurpee machine not running. Performed refrigeration diagnostic to show error 0510. Compressor not operational.", priority: "p2", status: "capital", functional_status: "Pending Capital Approval", contractor_id: ids["pro.ops.inc@gmail.com"], afm_id: afmIds["Jason Pulley"], afm_name: "Jason Pulley", afm_email: "Jason.Pulley@7-11.com", nte: 6500, dispatched_at: hoursAgo(72), is_capital: true, capital_status: "Pending approval", part_needed: "Taylor 340 compressor assembly", asset_model: "Taylor 340", asset_serial: "TY-2022-81402" },
    { id: "FWKD11318902", incident_id: "INC24410088", store_number: "35551", city: "Houston, TX", address: "7810 Westheimer Rd, Houston, TX 77063", line_of_service: "Refrigeration", business_service: "Walk-in cooler", category: "Walk-in cooler/freezer", sub_category: "Temperature out of range", summary: "Walk-in cooler running warm — product at risk", description: "Walk-in cooler reading 48°F.", priority: "p1", status: "wip", functional_status: "Work in Progress", contractor_id: ids["service@archerref.com"], afm_id: afmIds["Marcus Holloway"], afm_name: "Marcus Holloway", afm_email: "Marcus.Holloway@7-11.com", nte: 2200, dispatched_at: hoursAgo(5), asset_model: "Heatcraft BHL036M", asset_serial: "HC-2020-44231" },
    { id: "FWKD11401122", incident_id: "INC24660221", store_number: "41005", city: "Tampa, FL", address: "3402 W Hillsborough Ave, Tampa, FL 33614", line_of_service: "Frozen Beverage - Equipment", business_service: "Slurpee and Frozen Lemonade", category: "Slurpee Machine", sub_category: "Machine not running", summary: "Slurpee machine #2 not cooling", description: "Slurpee machine #2 cylinder not cooling, mix is soupy.", priority: "p2", status: "assigned", functional_status: "Dispatched", contractor_id: ids["buriakmw@gmail.com"], afm_id: afmIds["Sandra Mitchell"], afm_name: "Sandra Mitchell", afm_email: "Sandra.Mitchell@7-11.com", nte: 1400, dispatched_at: hoursAgo(14) },
    { id: "FWKD11412556", incident_id: "INC24702004", store_number: "42210", city: "Tampa, FL", address: "8801 N Dale Mabry Hwy, Tampa, FL 33614", line_of_service: "Plumbing", business_service: "Restroom", category: "Toilet", sub_category: "Leak / overflow", summary: "Customer restroom toilet overflowing", description: "Customer restroom toilet overflowing.", priority: "p1", status: "wip", functional_status: "Work in Progress", contractor_id: ids["plumbingdayornight@gmail.com"], afm_id: afmIds["Sandra Mitchell"], afm_name: "Sandra Mitchell", afm_email: "Sandra.Mitchell@7-11.com", nte: 650, dispatched_at: hoursAgo(3) },
    { id: "FWKD11422018", incident_id: "INC24891002", store_number: "33089", city: "Dallas, TX", address: "2301 N Central Expy, Dallas, TX 75204", line_of_service: "Food Service", business_service: "Hot food", category: "Roller grill", sub_category: "Heating element failure", summary: "Roller grill not heating — taquitos cold", description: "Roller grill #1 heating element out.", priority: "p2", status: "unassigned", functional_status: "Dispatched", afm_id: afmIds["Greg Peterman"], afm_name: "Greg Peterman", afm_email: "Greg.Peterman@7-11.com", nte: 950, dispatched_at: hoursAgo(1) },
    { id: "FWKD11385501", incident_id: "INC24550890", store_number: "35551", city: "Houston, TX", address: "7810 Westheimer Rd, Houston, TX 77063", line_of_service: "Refrigeration", business_service: "Ice merchandiser", category: "Ice merchandiser", sub_category: "Not cooling", summary: "Ice merchandiser rebuilt — replaced evap fan motor", description: "Replaced evap fan motor.", priority: "p2", status: "completed", functional_status: "Completed", contractor_id: ids["service@archerref.com"], afm_id: afmIds["Marcus Holloway"], afm_name: "Marcus Holloway", afm_email: "Marcus.Holloway@7-11.com", nte: 850, dispatched_at: hoursAgo(30), asset_model: "Leer FF64AS", asset_serial: "LR-2019-22014" },
    { id: "FWKD11372001", incident_id: "INC24490102", store_number: "33321", city: "Dallas, TX", address: "5712 Skillman St, Dallas, TX 75206", line_of_service: "Refrigeration", business_service: "Walk-in cooler", category: "Walk-in cooler", sub_category: "Door gasket", summary: "Walk-in cooler door gasket replaced", description: "Replaced worn door gasket.", priority: "p3", status: "pending_invoice", functional_status: "Completed", contractor_id: ids["scrcdallastexas@gmail.com"], afm_id: afmIds["Greg Peterman"], afm_name: "Greg Peterman", afm_email: "Greg.Peterman@7-11.com", nte: 450, dispatched_at: hoursAgo(96), asset_model: "Heatcraft PRO26", asset_serial: "HC-2018-33910" },
    { id: "FWKD11340089", incident_id: "INC24320811", store_number: "35551", city: "Houston, TX", address: "7810 Westheimer Rd, Houston, TX 77063", line_of_service: "HVAC", business_service: "RTU", category: "RTU compressor", sub_category: "Failure — replacement", summary: "RTU compressor replacement", description: "Rooftop unit #2 compressor replaced.", priority: "p2", status: "pending_approval", functional_status: "Completed", contractor_id: ids["service@archerref.com"], afm_id: afmIds["Marcus Holloway"], afm_name: "Marcus Holloway", afm_email: "Marcus.Holloway@7-11.com", nte: 6000, invoice_total: 5240, dispatched_at: hoursAgo(168), asset_model: "Carrier 48HCEE06", asset_serial: "CR-2017-55891" },
  ];
  console.log("\nInserting work orders...");
  for (const w of wos) {
    const { error } = await sb.from("work_orders").upsert(w as any, { onConflict: "id" });
    if (error) console.log(`  ✗ ${w.id}: ${error.message}`);
    else console.log(`  ✓ ${w.id} ${w.summary.slice(0, 40)}...`);
  }

  // 5. Invoice 6556 (real, with all 13 line items)
  console.log("\nInserting Invoice 6556...");
  const { data: invRow, error: invErr } = await sb.from("invoices").upsert({
    num: "6556",
    work_order_id: "FWKD11234445",
    store_number: "32333",
    store_address: "5101 George Washington Memorial Hwy, Yorktown, VA 23692 USA",
    contractor_id: ids["pro.ops.inc@gmail.com"],
    cme: "CME-002 Beverage",
    invoice_date: "2026-04-17",
    service_date: "2026-03-25",
    due_date: "2026-05-17",
    terms: "Net 30",
    state: "submitted",
    subtotal: 4039.09,
    sales_tax: 246.00,
    total: 4285.09,
  }, { onConflict: "num" }).select().single();

  if (invErr) {
    console.log(`  ✗ ${invErr.message}`);
  } else {
    console.log(`  ✓ Invoice 6556 ($4,285.09)`);
    // Wipe + re-insert lines (cleaner than diffing)
    await sb.from("invoice_lines").delete().eq("invoice_id", invRow.id);
    const lines = [
      { type: "Travel", description: "Travel to site — initial diagnosis", qty: 1, rate: 110 },
      { type: "Travel", description: "Second trip with parts", qty: 1, rate: 110 },
      { type: "Labor", description: "Arrived onsite checked in with the MOD, recovered charge, replaced filter dryer. Pressure and vacuum tested unit. Recharged and witnessed proper cooling operation. Management asked if tech could replace product and get all barrels going. Replaced strawberry began refilling barrel and witnessed a significant leak out of the barrel from the beater motor. Tech recommends beater motor and rear seal replacement.", qty: 5.5, rate: 110 },
      { type: "Labor", description: "Arrived onsite checked in with the MOD, removed and replaced old beater motor and rear seal. Cleaned and ensured proper seal. Refilled barrel and witnessed proper unit operation. Job completed.", qty: 4.5, rate: 110 },
      { type: "Parts/Hardware", description: "Field wiring kit", qty: 2, rate: 41.42 },
      { type: "Parts/Hardware", description: "TVRN", qty: 1, rate: 150 },
      { type: "Parts/Hardware", description: "Nitrogen", qty: 1, rate: 45 },
      { type: "Parts/Hardware", description: "Reclaim", qty: 1, rate: 55 },
      { type: "Parts/Hardware", description: "R404a refrigerant", qty: 14, rate: 35 },
      { type: "Parts/Hardware", description: "3/8 dryer", qty: 1, rate: 37.5 },
      { type: "Parts/Hardware", description: "Beater motor", qty: 1, rate: 1256.25 },
      { type: "Parts/Hardware", description: "Rear seal", qty: 1, rate: 77.5 },
      { type: "Shipping", description: "NDA shipping", qty: 1, rate: 525 },
    ];
    for (let i = 0; i < lines.length; i++) {
      await sb.from("invoice_lines").insert({ invoice_id: invRow.id, position: i + 1, ...lines[i] });
    }
    console.log(`  ✓ ${lines.length} line items`);
  }

  console.log("\n✅ Bootstrap complete.\n");
  console.log("Default password for every user: " + DEFAULT_PASSWORD);
  console.log("Try signing in with: clay@p1services.com... wait — use the REAL emails:");
  console.log("  claytonetchison@gmail.com / p1demo2026!");
  console.log("  gustavo@myamzteam.com / p1demo2026!  (Jeremy Barry, owner — demo mailbox)");
  console.log("  scrcdallastexas@gmail.com / p1demo2026!  (Derek Starnes, contractor)");
}

main().catch(e => { console.error(e); process.exit(1); });
