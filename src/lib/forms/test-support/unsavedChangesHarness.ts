import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import * as dismissal from "../dismissal";
import type { UnsavedChangesOptions } from "../useUnsavedChangesGuard";

type Guard = ReturnType<typeof import("../useUnsavedChangesGuard").useUnsavedChangesGuard>;
type Effect = { dependencies?: readonly unknown[]; cleanup?: () => void };
const filename = resolve("src/lib/forms/useUnsavedChangesGuard.tsx");
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText;

/** Actual production hook, injected hooks/window; not browser focus evidence. */
export function createUnsavedChangesHarness() {
  const states: unknown[] = [];
  const refs: { current: unknown }[] = [];
  const effects: Effect[] = [];
  const queue: (() => void)[] = [];
  const listeners = new Map<string, Set<(event: { preventDefault(): void; returnValue: string }) => void>>();
  let stateIndex = 0, refIndex = 0, effectIndex = 0, registered = 0;
  let forcedDeploymentReload = false;
  const exports: { useUnsavedChangesGuard?: (options: UnsavedChangesOptions) => Guard } = {};
  runInNewContext(compiled, { exports,
    window: {
      addEventListener: (name: string, callback: (event: { preventDefault(): void; returnValue: string }) => void) => {
        if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name)?.add(callback);
      },
      removeEventListener: (name: string, callback: (event: { preventDefault(): void; returnValue: string }) => void) => listeners.get(name)?.delete(callback),
    },
    require: (name: string) => {
      if (name === "./dismissal") return dismissal;
      if (name === "./dirtyFormRegistry") return { registerDirtySensitiveForm: () => { registered += 1; return () => { registered -= 1; }; } };
      if (name === "../deploymentReload") return { isForcedDeploymentReload: () => forcedDeploymentReload };
      if (name.endsWith("/DiscardChangesDialog")) return { DiscardChangesDialog: "DiscardChangesDialog" };
      if (name === "react/jsx-runtime") return { jsx: (type: unknown, props: unknown) => ({ type, props }) };
      if (name === "react") return {
        useCallback: (callback: unknown) => callback,
        useRef: (initial: unknown) => { const index = refIndex++; return refs[index] ??= { current: initial }; },
        useState: (initial: unknown) => { const index = stateIndex++; if (!(index in states)) states[index] = initial;
          return [states[index], (value: unknown) => { states[index] = typeof value === "function" ? value(states[index]) : value; }]; },
        useEffect: (callback: () => void | (() => void), dependencies?: readonly unknown[]) => {
          const index = effectIndex++, old = effects[index];
          if (!old || !dependencies || !old.dependencies || dependencies.some((value, i) => !Object.is(value, old.dependencies?.[i]))) {
            queue.push(() => { old?.cleanup?.(); const cleanup = callback(); effects[index] = {
              dependencies, cleanup: typeof cleanup === "function" ? cleanup : undefined,
            }; });
          }
        },
      };
      throw new Error(`Unexpected hook dependency: ${name}`);
    },
  }, { filename });
  if (!exports.useUnsavedChangesGuard) throw new Error("Guard export missing");
  const hook = exports.useUnsavedChangesGuard;
  return {
    useGuard(options: UnsavedChangesOptions): Guard {
      stateIndex = 0; refIndex = 0; effectIndex = 0;
      const result = hook(options);
      while (queue.length) queue.shift()?.();
      return result;
    },
    unmount: () => { for (const effect of effects) effect.cleanup?.(); },
    listenerCount: () => listeners.get("beforeunload")?.size || 0,
    registeredCount: () => registered,
    beginForcedDeploymentReload: () => { forcedDeploymentReload = true; },
    dispatchBeforeUnload: () => {
      let prevented = false;
      const event = { preventDefault: () => { prevented = true; }, returnValue: "untouched" };
      for (const listener of listeners.get("beforeunload") || []) listener(event);
      return { prevented, returnValue: event.returnValue };
    },
  };
}
