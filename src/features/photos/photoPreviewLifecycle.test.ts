import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createBrowserPhotoStorageAdapter } from "./browserPhotoStorageAdapter";
import * as fileAdapter from "./browserPhotoFileAdapter";

for (const earlyUnmount of [false, true]) test(`gallery preview cleanup handles ${earlyUnmount ? "late download after unmount" : "normal unmount"}`, async () => {
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  const created: string[] = [], revoked: string[] = [], stateUpdates: number[] = [];
  URL.createObjectURL = () => { const url = "blob:synthetic-" + created.length; created.push(url); return url; };
  URL.revokeObjectURL = url => { revoked.push(url); };
  try {
    let finish: ((value: unknown) => void) | undefined;
    const pending = new Promise<unknown>(done => { finish = done; });
    const storage = createBrowserPhotoStorageAdapter({
      session: async () => { throw new Error("Unexpected preview session"); },
      configuration: () => { throw new Error("Unexpected preview upload"); },
      download: async path => { assert.equal(path, "wo/SYNTHETIC/reviewed"); return pending; },
      fetch: async () => { throw new Error("External request forbidden"); },
    });
    const effects: (() => void | (() => void))[] = [];
    let stateIndex = 0;
    const file = resolve("src/features/photos/PhotoGallery.tsx"), requireHere = createRequire(import.meta.url);
    const exports: { default?: (props: Record<string, unknown>) => unknown } = {};
    runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText, { exports, Set, Promise,
      require: (name: string): unknown => {
        if (name === "react/jsx-runtime") return { jsx: () => null, jsxs: () => null };
        if (name === "react") return {
          useEffect: (effect: () => void | (() => void)) => effects.push(effect),
          useRef: (current: unknown) => ({ current }),
          useState: (initial: unknown) => { const index = stateIndex++; return [index === 1 ? true : initial, () => stateUpdates.push(index)]; },
        };
        if (name === "./browserPhotoStorageAdapter") return storage;
        if (name === "./browserPhotoFileAdapter") return fileAdapter;
        if (name.endsWith("/db")) return {};
        if (name.endsWith("/constants")) return { T: {} };
        if (name.includes("/components/") || name === "./PhotoUploadProgress") return {};
        return requireHere(resolve(file, "..", name));
      },
    }, { filename: file });
    assert.ok(exports.default);
    exports.default({ woId: "SYNTHETIC", photos: ["wo/SYNTHETIC/reviewed"], setImageErrors: () => undefined, setLightbox: () => undefined });
    assert.equal(effects.length, 2);
    const cleanup = effects[1](); assert.equal(typeof cleanup, "function"); if (typeof cleanup !== "function") throw new Error("Missing effect cleanup");
    if (earlyUnmount) cleanup();
    const previousUpdates = stateUpdates.length;
    assert.ok(finish); finish({ data: new Blob(["synthetic"]), error: null });
    await new Promise<void>(done => setImmediate(done));
    assert.equal(created.length, 1);
    if (earlyUnmount) assert.equal(stateUpdates.length, previousUpdates, "No stale React update after unmount");
    else { assert.equal(revoked.length, 0); cleanup(); }
    assert.deepEqual(revoked, created);
  } finally { URL.createObjectURL = originalCreate; URL.revokeObjectURL = originalRevoke; }
});
