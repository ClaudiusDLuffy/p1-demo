import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import type { useListExport, ListExportOptions } from "./useListExport";
import { ListExportLimitError } from "./listExport";

const filename = resolve("src/features/list-export/useListExport.ts");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const requireHere = createRequire(import.meta.url);
function harness() {
  const refs: { current: unknown }[] = []; const states: unknown[] = [];
  let refIndex = 0, stateIndex = 0, effectIdentity: unknown;
  let cleanup: (() => void) | undefined;
  const downloads: string[] = [];
  const pending: { signal: AbortSignal; finish(rows: { id: string }[]): void; fail(): void }[] = [];
  const exports: { useListExport?: typeof useListExport } = {};
  runInNewContext(compiled, { exports, AbortController, JSON, require: (name: string) => {
    if (name === "react") return {
      useRef: (initial: unknown) => { const i = refIndex++; return refs[i] ?? (refs[i] = { current: initial }); },
      useState: (initial: unknown) => {
        const i = stateIndex++; if (!(i in states)) states[i] = initial;
        return [states[i], (value: unknown) => { states[i] = typeof value === "function"
          ? (value as (old: unknown) => unknown)(states[i]) : value; }];
      },
      useEffect: (effect: () => () => void, deps: unknown[]) => {
        if (effectIdentity !== deps[0]) { cleanup?.(); effectIdentity = deps[0]; cleanup = effect(); }
      },
    };
    if (name === "./listExport") return { ListExportLimitError,
      downloadListCsv: (value: string) => downloads.push(value) };
    return requireHere(resolve(filename, "..", name));
  } });
  const options: ListExportOptions<{ id: string }> = {
    identity: "actor-A:filters-A", enabled: true, fileName: "synthetic.csv",
    read: signal => new Promise((finish, reject) => pending.push({ signal, finish, fail: () => reject(new Error("synthetic-private-detail")) })),
    format: rows => JSON.stringify(rows),
  };
  return { pending, downloads, cleanup: () => cleanup?.(), render: (patch: Partial<typeof options> = {}) => {
    refIndex = 0; stateIndex = 0; assert.ok(exports.useListExport);
    return exports.useListExport!({ ...options, ...patch });
  } };
}

test("no automatic export, repeated clicks dispatch once, successful result downloads once", async () => {
  const h = harness(); const action = h.render(); assert.equal(h.pending.length, 0);
  const first = action.start(); await action.start(); assert.equal(h.pending.length, 1);
  h.pending[0].finish([{ id: "ONE" }]); await first;
  assert.equal(h.downloads.length, 1); assert.match(h.render().message, /Exported 1/);
});
test("cancel and immediate retry reject the late first result without affecting the new request", async () => {
  const h = harness(); const action = h.render(); const first = action.start(); action.cancel();
  const next = h.render().start(); h.pending[0].finish([{ id: "OLD" }]); await first;
  assert.equal(h.downloads.length, 0); h.pending[1].finish([{ id: "NEW" }]); await next;
  assert.deepEqual(h.downloads, ['[{"id":"NEW"}]']);
});
test("actor/filter/navigation changes cancel pending exports and never download the old scope", async () => {
  for (const patch of [{ identity: "actor-B:filters-A" }, { identity: "actor-A:filters-B" }, { enabled: false }]) {
    const h = harness(); const first = h.render().start(); h.render(patch);
    assert.equal(h.pending[0].signal.aborted, true);
    h.pending[0].finish([{ id: "PRIVATE-OLD-SCOPE" }]); await first;
    assert.equal(h.downloads.length, 0);
    assert.equal(h.render().busy, false);
  }
});
test("empty results and failures download nothing; failures are safe and retryable by the user", async () => {
  const h = harness(); const first = h.render().start(); h.pending[0].finish([]); await first;
  assert.equal(h.downloads.length, 0); assert.match(h.render().message, /No records/);
  const next = h.render().start(); h.pending[1].fail(); await next;
  assert.equal(h.downloads.length, 0); assert.match(h.render().error, /No partial file/);
  assert.doesNotMatch(h.render().error, /synthetic-private-detail/);
});
test("unmount and inactive accounts prevent exports and late downloads", async () => {
  const h = harness(); await h.render({ enabled: false }).start(); assert.equal(h.pending.length, 0);
  const action = h.render().start(); h.cleanup(); h.pending[0].finish([{ id: "OLD" }]); await action;
  assert.equal(h.downloads.length, 0);
});
