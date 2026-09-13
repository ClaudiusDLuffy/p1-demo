import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBillingDraftPayload, validateBillingDraft } from "../src/lib/billingDraftPersistence";
import { createQuoteCalculatorDraft, validateQuoteCalculatorDraft } from "../src/lib/quoteCalculatorDraft";
import { createDraftSession, DRAFT_MAX_BYTES, DRAFT_MAX_RECORDS, DRAFT_SWEEP_LIMIT, type DraftStorage } from "../src/lib/drafts/draftSession";
import { decideDismissal } from "../src/lib/forms/dismissal";
import { isBackdropRelease } from "../src/lib/forms/modalRuntime";
import { nextEnabledOption, typeaheadOption, type SelectOption } from "../src/lib/forms/selectModel";
import { getCspReportOnlyHeaders } from "../src/lib/config/server/browserSecurity";

const WARMUPS = 5;
const ITERATIONS = 30;
const USER = "00000000-0000-4000-8000-000000000001";
const CLOCK = Date.parse("2026-09-11T00:00:00.000Z");
type Metric = { name: string; samples: number; p50Ms: number; p95Ms: number; maxMs: number; localP95LimitMs: number; passed: boolean };
const rounded = (value: number) => Math.round(value * 1000) / 1000;
function measure(name: string, prepare: () => () => void, localP95LimitMs: number): Metric {
  const times: number[] = [];
  for (let index = 0; index < WARMUPS + ITERATIONS; index++) {
    const run = prepare(); // Seed/allocation outside the measured operation.
    const started = performance.now(); run(); const elapsed = performance.now() - started;
    if (index >= WARMUPS) times.push(elapsed);
  }
  times.sort((a, b) => a - b);
  const percentile = (fraction: number) => times[Math.max(0, Math.ceil(times.length * fraction) - 1)];
  const p95 = percentile(0.95);
  return { name, samples: times.length, p50Ms: rounded(percentile(0.5)), p95Ms: rounded(p95), maxMs: rounded(times.at(-1) ?? 0),
    localP95LimitMs, passed: p95 <= localP95LimitMs };
}
function storageFixture() {
  const values = new Map<string, string>(); let keyReads = 0; let token = 0;
  const storage: DraftStorage = { get length() { return values.size; },
    key: index => { keyReads++; return [...values.keys()][index] ?? null; },
    getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); } };
  const session = createDraftSession({ environment: "test", project: "https://synthetic.invalid", storage,
    now: () => CLOCK, random: () => `synthetic-${++token}` });
  return { values, session, keyReads: () => keyReads };
}
const optionsFor = (size: number): SelectOption[] => Array.from({ length: size }, (_, index) => ({ index,
  value: `choice-${index}`, label: `Choice ${String(index).padStart(3, "0")}`, sub: "Synthetic",
  search: `Choice ${index}`, disabled: index % 11 === 5 }));
const billingPayload = (size: number) => createBillingDraftPayload({ savedAt: new Date(CLOCK).toISOString(), form: {
  workOrderId: "WOT-SYNTHETIC", lines: Array.from({ length: size }, (_, index) => ({ type: "Material",
    desc: `Synthetic material ${index}`.padEnd(size === 1000 ? 240 : 0, "."), qty: 1, rate: 25, isTaxable: false,
    sourceInvoiceLineId: null, sourceWorkOrderPartId: null, sourceUnitCost: null, markupPercent: null })),
} });

/** Node/injected storage and pure models only; not DOM paint, Web Vitals or hosted timing. */
export function verifyBrowserPolicyPerformance() {
  const metrics: Metric[] = [];
  const small = billingPayload(25), large = billingPayload(1000);
  const quote = createQuoteCalculatorDraft({ workOrderId: "WOT-SYNTHETIC", selectedSourceId: "",
    lines: Array.from({ length: 50 }, (_, index) => ({ id: `synthetic-${index}`, type: "Material",
      desc: `Synthetic quote material ${index}`, qty: 1, sourceRate: 20, rate: 25, sourceInvoiceLineId: null })),
    pricing: { laborRate: "100", partsMarkupPercent: "25", overallMarginPercent: "30" },
  }, new Date(CLOCK).toISOString());
  metrics.push(measure("modal_dismissal_and_backdrop_50_events", () => () => {
    for (let index = 0; index < 50; index++) {
      assert.equal(decideDismissal({ reason: "escape", dirty: true, busy: false, persistence: "dirty_not_persisted" }).action, "confirm_discard");
      assert.equal(decideDismissal({ reason: "backdrop", dirty: true, busy: true, persistence: "persist_failed" }).action, "blocked");
      assert.equal(isBackdropRelease(false, true), false);
    }
  }, 5));
  for (const size of [25, 50]) {
    const options = optionsFor(size);
    metrics.push(measure(`select_${size}_options_50_keyboard_steps`, () => () => {
      let current = -1;
      for (let index = 0; index < 50; index++) {
        current = nextEnabledOption(options, current, "next");
        assert.equal(options[current].disabled, false);
      }
      const last = nextEnabledOption(options, -1, "last");
      assert.equal(typeaheadOption(options, 0, options[last].label), last);
    }, 5));
  }
  metrics.push(measure("select_option_append_25_to_50_and_keyboard_identity", () => {
    const original = optionsFor(25), appended = optionsFor(50).slice(25);
    return () => {
      const combined = [...original, ...appended];
      assert.equal(combined.length, 50);
      assert.equal(nextEnabledOption(combined, 24, "next"), 25);
      assert.equal(combined[24], original[24]);
    };
  }, 5));
  for (const [size, payload] of [[25, small], [1000, large]] as const) {
    metrics.push(measure(`billing_draft_validate_${size}_lines`, () => () => {
      assert.ok(validateBillingDraft(payload));
    }, 20));
    metrics.push(measure(`billing_draft_verified_save_and_read_${size}_lines`, () => {
      const { session } = storageFixture(); assert.equal(session.activate(USER, true), true);
      const lease = session.open("staff-billing", "new:WOT-SYNTHETIC", validateBillingDraft); assert.ok(lease);
      return () => {
        assert.equal(lease.save(payload).status, "persisted");
        assert.equal(lease.isPersisted(), true); assert.ok(lease.read()); lease.close();
      };
    }, 50));
  }
  metrics.push(measure("quote_draft_validate_50_lines", () => () => assert.ok(validateQuoteCalculatorDraft(quote)), 20));
  metrics.push(measure("logout_purge_16_registered_drafts", () => {
    const { session, values } = storageFixture(); assert.equal(session.activate(USER, true), true);
    for (let index = 0; index < DRAFT_MAX_RECORDS; index++) {
      const lease = session.open("staff-billing", `synthetic-${index}`, validateBillingDraft); assert.ok(lease);
      assert.equal(lease.save(small).status, "persisted"); lease.close();
    }
    return () => {
      assert.equal(session.revoke(USER), true);
      assert.equal([...values.keys()].some(key => key.includes(`:draft:${USER}:`)), false);
    };
  }, 20));
  let maximumSweepKeyReads = 0;
  metrics.push(measure("bounded_startup_sweep_1000_unrelated_16_legacy_keys", () => {
    const { values, session, keyReads } = storageFixture();
    for (let index = 0; index < 1000; index++) values.set(`unrelated-${index}`, "synthetic");
    for (let index = 0; index < 16; index++) values.set(`p1:staff-billing-draft:v1:synthetic:${index}`, "synthetic");
    return () => {
      assert.equal(session.activate(USER, true), true);
      maximumSweepKeyReads = Math.max(maximumSweepKeyReads, keyReads());
      assert.ok(keyReads() <= 3 * DRAFT_SWEEP_LIMIT);
      assert.equal([...values.keys()].filter(key => key.startsWith("unrelated-")).length, 1000);
      assert.equal([...values.keys()].some(key => key.startsWith("p1:staff-billing-draft:v1:")), false);
    };
  }, 50));
  let reportOnlyBytes = 0;
  metrics.push(measure("strict_preview_csp_configuration", () => () => {
    const headers = getCspReportOnlyHeaders({ NODE_ENV: "production", VERCEL_ENV: "preview", P1_APP_ENV: "preview",
      NEXT_PUBLIC_P1_APP_ENV: "preview", P1_ENABLE_CSP_REPORT_ONLY: "true", NEXT_PUBLIC_SUPABASE_URL: "https://syntheticpreview.supabase.co",
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_synthetic", P1_EXPECTED_SUPABASE_PROJECT_REF: "syntheticpreview",
      P1_PRODUCTION_SUPABASE_PROJECT_REF: "syntheticproduction" });
    assert.equal(headers.length, 1); assert.doesNotMatch(headers[0].value, /unsafe-inline|unsafe-eval|report-uri|report-to/);
    reportOnlyBytes = Buffer.byteLength(headers[0].value);
  }, 5));
  const payloadBytes = { billing25: Buffer.byteLength(JSON.stringify(small)), billing1000: Buffer.byteLength(JSON.stringify(large)),
    quote50: Buffer.byteLength(JSON.stringify(quote)) };
  assert.ok(Object.values(payloadBytes).every(value => value <= DRAFT_MAX_BYTES));
  return { result: metrics.every(metric => metric.passed) ? "passed" : "failed", evidence: "LOCAL_MEASURED_PURE_MODELS_AND_INJECTED_STORAGE",
    method: { warmups: WARMUPS, measuredIterations: ITERATIONS, seed: "fixed-sequential-synthetic-v1", node: process.version,
      setupExcluded: true, percentile: "nearest-rank", localLimits: "Coarse regression ceilings, not a product SLA or browser target" },
    metrics, payloadBytes, reportOnlyBytes, bounds: { draftBytes: DRAFT_MAX_BYTES, registeredDrafts: DRAFT_MAX_RECORDS,
      sweepKeysPerPass: DRAFT_SWEEP_LIMIT, maximumSweepKeyReads, sweepPasses: 3 },
    limitations: ["Injected Map storage is not browser localStorage latency or quota behavior", "No DOM/layout/paint or assistive technology measured",
      "No network/provider/browser/hosted environment accessed", "No heap-growth or Core Web Vitals certification",
      "Option append measures the shared selection model, not a network directory request", "Run without concurrent build/database benchmarks for final evidence"] };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyBrowserPolicyPerformance(); console.log(JSON.stringify(result, null, 2));
    if (result.result !== "passed") process.exitCode = 1;
  } catch {
    console.error(JSON.stringify({ result: "failed", code: "BROWSER_POLICY_LOCAL_VERIFICATION_FAILED" })); process.exitCode = 1;
  }
}
