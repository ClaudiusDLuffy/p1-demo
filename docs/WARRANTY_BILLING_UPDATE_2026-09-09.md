# Warranty billing update — 2026-09-09

## Scope and starting state

Requested by the repository owner from Lynzy's billing feedback: add a Warranty
item that permits a $0 bill. Work started on clean `dev` at
`ad92203faef8f982a660cb2957870af22a91015b`, which already contains the Net 60 and
plain-zero numeral updates. Those changes remain intact.

Stabilization remains preserved in stash
`5ed8b826fab0b8e9d2c6898e216bb7c9a3d50643`; it was read only for compatibility
analysis and isolated SQL fixtures, not applied or modified. No production or
staging access, commits, pushes, deployments, or dependency changes occurred.

## Billing behavior

- `Warranty` is an explicit P1 staff-billing line category and quick-add item.
  It defaults to quantity 1, rate $0 and a no-charge warranty description.
- Selecting Warranty defaults the rate to $0 and removes parts markup. Existing
  explicit positive Warranty prices remain valid and are preserved on edit and
  export; the request permits zero rather than requiring every Warranty to be free.
- Quantity must be finite and positive; description is required. Rate must be
  finite and nonnegative for Warranty and positive for every other line type.
  Description text alone cannot turn a paid line into Warranty.
- POST/PATCH validate rates before numeric normalization, so absent, null,
  nonnumeric or infinite values cannot turn into a free Warranty line.
- An invalid line rejects the entire save instead of being silently omitted.
  Existing database rounding remains authoritative; an ordinary rate that
  rounds to zero is invalid.
- Warranty-only invoices can save as draft or submitted with subtotal/tax/total
  $0. Mixed invoices retain both no-charge and paid rows.
- Required P1-purchased parts cannot be reclassified to bypass their canonical
  price/source rules. Contractor billing, invoice permissions, source ownership,
  tax rules and explicit tax overrides are unchanged.
- Summaries, PDF and CSV keep the Warranty label and zero values. Capital Quote
  SaasAnt exclusion is unchanged. External accounting must verify the new
  `Warranty` Product/Service mapping before importing such CSVs.

## Database migration and rollout

Forward migration: `0122_allow_zero_rate_staff_warranty_lines.sql`, immediately
after dev's `0121_atomic_repeat_dispatch_refresh.sql`. The owner confirmed the
stabilization migrations are not applied and requested sequential numbering for
this earlier dev release. The uncommitted Warranty migration was consequently
renamed from its initially reserved 0133 number; no applied migration was renamed.
No historical invoice rows are rewritten.

The migration patches only the known rate/quantity validation fragment in:

```text
public.save_staff_billing_invoice(uuid, uuid, text, text, text, text, text,
  date, date, date, text, text, numeric, text, numeric, text, jsonb, uuid[])
```

The existing `save_staff_billing_invoice_v3` call chain, arithmetic, atomic
header/line/source/audit writes, execution grants, function ownership and pinned
search paths remain intact. Fixed-signature, exact-fragment shape checks abort
on an unexpected definition. Reapplying the same patch is deterministic.

If already installed, the migration also adds the same exception to
`public.normalize_staff_invoice_payload(jsonb)`, preserving all Phase 3 strict
payload checks. The supported dev filename order is 0001–0121 then Warranty
0122. A separate synthetic fixture checks the patch against the preserved
stabilization function definitions; it is NOT a deployable combined filename
order while both branches contain a migration numbered 0122.

Numbering inspection also found the pre-existing committed pair
`0029_add_p5_priority.sql` and `0029_invoice_type.sql`. Neither was changed.
The focused harness permits only that exact historical duplicate and rejects any
new collision or missing version through Warranty 0122. Its SQL execution is not
Supabase migration-ledger certification; release-owner verification of the
existing target ledger remains required, including the historical 0029 pair.

Deployment is not performed by this task. Release owner steps:

1. Verify the target project and its actual migration ledger, then approve and
   apply Warranty 0122 before deploying the Warranty-compatible application. Old code
   remains unable to create a zero-rate Warranty line during this expansion.
2. Deploy and smoke-test a synthetic Warranty-only draft, submission, edit, mixed
   invoice, PDF and CSV. Confirm ordinary zero-rate lines are denied and required
   P1-purchased parts remain protected.
3. Confirm the accounting Product/Service mapping for Warranty. Local CSV/PDF
   generation does not prove external SaasAnt/QuickBooks import acceptance.
4. If rollback is required, pause Warranty entry and forward-fix. Do not delete
   existing zero-rate invoices or relabel them Other through incompatible code.

### Required stabilization integration gate

The preserved stabilization stash still contains its original unapplied
0122–0132 files, byte-identical. Before integrating it, resequence those pending
migrations after the now-occupied Warranty 0122, preserving their relative order,
and update their harnesses/runbooks. Do not merge duplicate version prefixes or
rename Warranty 0122 once it has been applied. Confirm all target ledgers before
renaming any pending file; no target ledger was accessed in this local task.

The stabilization financial expansion (currently named 0124) also introduces the
older positive-only financial normalizer. A **new, separately numbered forward
bridge** is required after that expansion to restore the narrow Warranty
exception. The final identifiers and complete clean/upgrade rollout must be
reviewed and retested when stabilization resumes. Never edit an applied migration
or use ledger repair to pretend the bridge ran. The synthetic compatibility
fixture applies preserved definitions followed by the Warranty patch explicitly;
it does not certify that future resequenced rollout.

The preserved stabilization application's `src/lib/staffInvoiceContracts.ts`
also has a positive-only `StaffFinancialLineSchema.rate`. When merging this
hotfix back, adapt that schema to the explicit Warranty exception while keeping
its finite-number, scale, amount, source, version and operation constraints.
Its client and v4 route both use that schema. Do not restore the legacy v3 route
over the authoritative financial commands. Rerun Phase 3 and combined regression
gates before promoting the merged candidate. The stash is intentionally not
changed as part of this dev hotfix.

## Verification

Synthetic fixtures and local adapters only; no real customer documents or data.
The UI tests execute the actual Zod schemas, quick-add definition and type-change
handler. Route tests execute POST/PATCH with provider IO replaced. PDF tests
generate and parse real synthetic PDF bytes. These are not deployed browser,
Storage, PostgREST or accounting-import certification.

- Before: 654 Node tests pass; global lint 682 errors / 44 warnings.
- After: 679 Node tests pass; repository TypeScript passes; focused strict
  TypeScript passes for the shared helpers and affected test roots.
- Global lint remains 682 errors / 44 warnings; new files have no diagnostics.
- Production webpack build still fails on the pre-existing dev PDF/native-canvas
  browser import boundary. This failure predates Warranty and is fixed only in
  the separately preserved stabilization work; no alias or suppression was added.
- After renumbering, the Warranty SQL harness passes 50/50 checks on current dev
  through 0121 followed by Warranty 0122, and 56/56 in the separate preserved
  stabilization definition-compatibility fixture. The latter is not a deployable
  merged migration sequence. The additional numbering assertions reject gaps and
  new duplicates, including accidental merging of the two 0122 histories.
  Checks include real zero-total draft/submitted saves and matching audit,
  mixed/positive arithmetic, canonical P1 procurement pricing, malformed-line
  rejection, five rollback points, function metadata/ACL preservation,
  idempotence, unexpected-definition rollback, and Phase 3 replay/version controls.
- Existing dev lifecycle/workflow harness: 22/22 runtime checks pass, including
  audits 0119–0121. These are the dev harness counts, not the separately stashed
  stabilization harness totals.
- `git diff --check` passes. Package manifests, historical migrations and both
  stabilization stashes are unchanged.

The final rename rerun also passes all 679 Node tests and 22 existing dev
workflow checks. No application behavior changed during renumbering.

Migration SHA-256:
`35cc17ba91f5e260cb90d81ac1c0e2471f4e1723557da341d2a655bb31861925`.

Commands:

```sh
node --import tsx --test --test-reporter=spec src/**/*.test.ts
npx tsc --noEmit --incremental false
npm run lint -- --format json
npm run build -- --webpack
P1_SQL_TEST_ENGINE_DIR=/private/tmp/p1-sql-check.6STUri node scripts/verify-warranty-billing.mjs
P1_SQL_TEST_ENGINE_DIR=/private/tmp/p1-sql-check.6STUri node scripts/verify-warranty-billing.mjs --stabilization-ref=5ed8b826fab0b8e9d2c6898e216bb7c9a3d50643
P1_SQL_TEST_ENGINE_DIR=/private/tmp/p1-sql-check.6STUri node scripts/verify-work-order-lifecycle.mjs
git diff --check
```
