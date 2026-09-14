import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createUnsavedChangesHarness } from "./forms/test-support/unsavedChangesHarness";
import type { UnsavedChangesOptions } from "./forms/useUnsavedChangesGuard";

export type PartsTestElement = { type: unknown; props: Record<string, unknown> };
export function partsElements(value: unknown): PartsTestElement[] {
  if (Array.isArray(value)) return value.flatMap(partsElements);
  if (!value || typeof value !== "object" || !("props" in value) || !("type" in value) || !value.props || typeof value.props !== "object") return [];
  const element = { type: value.type, props: value.props as Record<string, unknown> };
  return [element, ...partsElements(element.props.children)];
}
export function partsVisibleText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(partsVisibleText).join(" ");
  if (value && typeof value === "object" && "props" in value && value.props && typeof value.props === "object" && "children" in value.props) return partsVisibleText(value.props.children);
  return "";
}
export function partsModuleHarness(path: string, mocks: Record<string, unknown> = {}, localExports: readonly string[] = []) {
  const dismissals: ReturnType<typeof createUnsavedChangesHarness>[] = [];
  let dismissalIndex = 0;
  const filename = resolve(path);
  // Test-only access to a legacy file-local component; production exports stay unchanged.
  for (const name of localExports) assert.match(name, /^[A-Za-z_$][\w$]*$/);
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText + localExports.map(name => `\nexports.${name} = ${name};`).join("");
  const requireHere = createRequire(import.meta.url);
  const state: unknown[] = []; let cursor = 0;
  const effects: (() => unknown)[] = [];
  const exports: Record<string, unknown> = {};
  runInNewContext(compiled, { exports, crypto: mocks.crypto || { randomUUID: () => "81000000-0000-4000-8000-000000000003" },
    document: { activeElement: null }, HTMLElement: class {}, setTimeout, clearTimeout, Date, Request, Response, Headers,
    require: (name: string): unknown => {
      if (name in mocks) return mocks[name];
      if (name.endsWith("/useUnsavedChangesGuard")) return { useUnsavedChangesGuard: (options: UnsavedChangesOptions) => {
        const index = dismissalIndex++;
        return (dismissals[index] ??= createUnsavedChangesHarness()).useGuard(options);
      } };
      if (name.endsWith("/ui/Modal")) return { Modal: "shared-modal" };
      if (name === "next/server") return { NextResponse: Response };
      if (name === "react") return {
        useId: () => "synthetic-parts-dialog", useCallback: (fn: unknown) => fn,
        useDeferredValue: (value: unknown) => value,
        useMemo: (fn: () => unknown) => fn(), useEffect: (fn: () => unknown) => { effects.push(fn); },
        useState: (initial: unknown) => { const slot = cursor++; if (!(slot in state)) state[slot] = typeof initial === "function" ? initial() : initial;
          return [state[slot], (next: unknown) => { state[slot] = typeof next === "function" ? next(state[slot]) : next; }]; },
        useRef: (initial: unknown) => { const slot = cursor++; if (!(slot in state)) state[slot] = { current: initial }; return state[slot]; },
      };
      return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
    } }, { filename });
  return { exports, effects, call: (name: string, ...args: unknown[]) => { cursor = 0; dismissalIndex = 0; const fn = exports[name]; assert.equal(typeof fn, "function");
    return (fn as (...input: unknown[]) => unknown)(...args); },
  render: (props: Record<string, unknown>) => { cursor = 0; dismissalIndex = 0; assert.equal(typeof exports.default, "function");
    return partsElements((exports.default as (props: Record<string, unknown>) => unknown)(props)); } };
}
export function partsFind(tree: PartsTestElement[], type: string) { const value = tree.find(item => item.type === type); assert.ok(value, type); return value; }
export function partsInvoke(element: PartsTestElement, handler: string, payload?: unknown) {
  const fn = element.props[handler]; assert.equal(typeof fn, "function"); return (fn as (payload?: unknown) => unknown)(payload);
}
export function partsButton(tree: PartsTestElement[], text: string) {
  const value = tree.find(item => item.type === "button" && partsVisibleText(item.props.children).replace(/\s+/g, " ").trim() === text); assert.ok(value, text); return value;
}
