# Screenshot bug fixes — deployment handoff

Scope: reopened, already-billed work-order closure and incoming 7-Eleven
priority escalation. This is not the platform audit or a general refactor.
No production records, deployments, credentials, or package lockfiles were changed.

## What changes

- Operational P1 staff can select **Close follow-up — no additional billing**
  for eligible reopened field work. A reason and current record version are
  required. The database verifies prior billing, rejects new/changed billing
  and pending operational updates, closes open visits, and preserves invoices.
- Approved direct 7-Eleven email notices can raise an operational work order's
  priority, update its SLA deadlines using the existing SLA start, and queue
  a private P1 email notification. Lower-priority, stale and replayed notices
  cannot downgrade the job or duplicate the escalation event.
- Reassignment copies receive updates on the current continuation. Repeated
  dispatch metadata and priority changes commit together. Existing Do Not
  Dispatch handling retains the correct billing destination and sends its
  outgoing contractor removal notice through a separate, intake-owned queue.

These changes do not close WOT1015920 automatically, change its invoice, or
backfill WOT1266375. An authorized staff member must review and close the
former in the portal. Any historical priority correction needs a separate
verified source; do not replay an entire old mailbox.

## Deployment order

1. Apply these new migrations in order against the intended Supabase project:
   - `supabase/migrations/0119_close_reopened_follow_up_without_billing.sql`
   - `supabase/migrations/0120_atomic_email_priority_escalations.sql`
   - `supabase/migrations/0121_atomic_repeat_dispatch_refresh.sql`
2. Run the corresponding read-only SQL files in `supabase/audits/`. Each must
   return `all_checks_pass = true`; investigate failures instead of overriding
   them. Existing data was not available for this local verification.
3. Set server-only `EMAIL_PRIORITY_INTAKE_START_AT` to the approved cutover
   instant, including timezone, for example an ISO timestamp ending in `Z`.
   Missing/invalid configuration holds priority updates and repeat dispatches
   without changing their mailbox state. Earlier notices are skipped.
4. Verify existing Graph credentials, inbox sender allowlist, intake scheduler
   and `NOTIFY_OWNER_EMAILS`. Priority alerts go to the configured owner list
   plus the existing P1 service inbox; not to the receiving contractor.
5. Deploy the web/server code together after the build passes. Refresh open
   staff browser tabs: the legacy one-argument no-invoice close RPC is revoked;
   the new client sends the expected workflow cycle and record version.

Before enabling escalation intake, confirm a real direct 7-Eleven escalation
email matches the parser. The screenshot alone does not establish its email
format. `src/lib/slaConfig.ts` still labels its existing SLA windows as sample-
derived, pending the official matrix; this change does not invent new windows.

## Targeted acceptance checks

- Reopened, previously billed fixture: close with a reason, verify one new
  close event, closed visits, unchanged invoice IDs/totals, correct closer.
- New/deleted invoice, changed billing, pending 7-Eleven update, inactive user,
  contractor, invoice controller or stale screen: closure is rejected.
- Fresh P4-to-P1 email: priority and deadline display update; one P1 alert.
  Replay the same message, then an older one: no duplicate event or alert.
- Repeat after creating a reassignment copy: update the current copy without
  disclosing the receiving contractor to the outgoing contractor.
- Closed/billing-stage job: a priority notice must not reopen it or replace
  historical provider details.
- Assigned Do Not Dispatch fixture: billing-only/pending-invoice state,
  archived assignment, and one outgoing removal notification.
- Run true two-session races in staging (duplicate vs escalation, invoice vs
  close, reopen vs stale close). The local test engine checks both sequential
  orderings but cannot prove production multi-session locking or mail delivery.

## Verification and remaining release checks

The complete unit suite, TypeScript, focused lint, migration application,
22 database workflow scenarios, and all three catalog audits are checked
locally. Database tests use in-memory PGlite with synthetic auth/storage
fixtures, not Docker or a production connection.

Reproduce the database checks with an isolated installation of
`@electric-sql/pglite@0.5.8`, without changing application dependencies:

```sh
P1_SQL_TEST_ENGINE_DIR=/absolute/path/to/isolated-install node scripts/verify-work-order-lifecycle.mjs
```

Local full-repository lint is not clean (700 errors, 47 warnings in the last
run). Production-build attempts were blocked by Turbopack port permissions;
the webpack fallback hit the existing client PDF/native canvas import path.
The installed Next version is 16.3.4 while the manifest specifies 16.2.3.
This is not a certified successful production build; the deployment pipeline
must install from the lockfile and pass its build before promotion.

Delivery monitoring: inspect both priority and intake-linked assignment
queues for `unknown`, failed priority sends, and claims older than 15 minutes.
Unknown/abandoned sends are not automatically resent because Graph may have
accepted them. Reconcile with message trace before any operator retry.

Rollback: pause escalation intake if necessary; retain the guards, audit
history and queued records. Do not drop these migrations or restore unsafe
legacy close permissions. A web rollback must keep the versioned close RPC
contract, or temporarily disable the close action until a forward fix lands.
