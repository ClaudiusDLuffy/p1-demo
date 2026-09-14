import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";

export type UiNode = { type: unknown; props: Record<string, unknown> & { children?: unknown } };
export function uiNodes(value: unknown): UiNode[] {
  if (Array.isArray(value)) return value.flatMap(uiNodes);
  if (!value || typeof value !== "object" || !("type" in value) || !("props" in value) || !value.props || typeof value.props !== "object") return [];
  const node = value as UiNode;
  return [node, ...uiNodes(node.props.children)];
}
export function uiText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(uiText).join("");
  return uiNodes(value).length ? uiText(uiNodes(value)[0].props.children) : "";
}
export function uiInvoke(node: UiNode, name: string, payload?: unknown) {
  const handler = node.props[name]; assert.equal(typeof handler, "function", name);
  return (handler as (event?: unknown) => unknown)(payload);
}
export function primitiveHarness(path: string, mocks: Record<string, unknown> = {}) {
  const file = resolve(path);
  const nativeRequire = createRequire(import.meta.url);
  const slots: unknown[] = [];
  let cursor = 0;
  const effects: (() => void | (() => void))[] = [];
  const imperative: (() => unknown)[] = [];
  const jsx = (type: unknown, props: UiNode["props"]) => ({ type, props });
  const state = (initial: unknown) => {
    const slot = cursor++;
    if (!(slot in slots)) slots[slot] = typeof initial === "function" ? initial() : initial;
    return [slots[slot], (next: unknown) => { slots[slot] = typeof next === "function" ? next(slots[slot]) : next; }];
  };
  const react = {
    createContext: (value: unknown) => ({ value, Provider: "context-provider" }),
    useContext: (context: { value: unknown }) => context.value,
    useState: state, useId: () => `synthetic-${cursor++}`,
    useRef: (initial: unknown) => { const slot = cursor++; if (!(slot in slots)) slots[slot] = { current: initial }; return slots[slot]; },
    useCallback: (callback: unknown) => callback, useMemo: (callback: () => unknown) => callback(),
    useEffect: (callback: () => void | (() => void)) => effects.push(callback),
    useLayoutEffect: (callback: () => void | (() => void)) => effects.push(callback),
    useImperativeHandle: (_ref: unknown, callback: () => unknown) => imperative.push(callback),
    forwardRef: (render: (props: unknown, ref: unknown) => unknown) => (props: unknown) => render(props, {}),
    isValidElement: (value: unknown) => Boolean(value && typeof value === "object" && "props" in value),
    Children: { toArray: (children: unknown) => Array.isArray(children) ? children : children ? [children] : [] },
  };
  const exports: Record<string, unknown> = {};
  const document = { activeElement: null as unknown, addEventListener() {}, removeEventListener() {},
    createElement: () => ({ name: "", value: "", appendChild() {} }) };
  const code = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  runInNewContext(code, { exports, Event, document: mocks.document || document, AbortController, AbortSignal,
    process: { env: { NODE_ENV: "test" } }, console: mocks.console || console,
    requestAnimationFrame: (callback: () => void) => { callback(); return 1; }, cancelAnimationFrame() {},
    require: (name: string) => name in mocks ? mocks[name] : name === "react" ? react
      : name === "react/jsx-runtime" ? { jsx, jsxs: jsx, Fragment: "fragment" }
        : name === "react-dom" ? { createPortal: (children: unknown) => children }
        : name.endsWith("/fieldContext") ? { FieldContext: { Provider: "field-context" }, useFieldControl: (props: object) => ({ id: "field-control", ...props }) }
          : name.includes("components/ui/") ? new Proxy({}, { get: (_target, key) => String(key) })
            : nativeRequire(name.startsWith(".") ? resolve(file, "..", name) : name),
  }, { filename: file });
  return { slots, effects, imperative, document, render(name: string, props: object) {
    cursor = 0; effects.length = 0; imperative.length = 0;
    const render = exports[name]; assert.equal(typeof render, "function");
    const tree = (render as (props: object) => unknown)(props);
    const root = uiNodes(tree)[0];
    return root && typeof root.type === "function" ? root.type(root.props) : tree;
  } };
}
