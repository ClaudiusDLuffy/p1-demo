import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NextRequest, NextResponse } from "next/server";
import { configurationFixture } from "../../../lib/config-test-support/runtimeConfig";

type ModuleExports = Record<string, unknown>;
type ModuleWrapper = (actual: ModuleExports) => ModuleExports;
export type ControllerTestModules = Readonly<Record<string, ModuleExports>>;

/** Each invocation has its own module cache, transport ports, and log sink.
 * The real route, contracts, authorization and request boundary are compiled;
 * there is no legacy behavior loader or fallback database/provider client. */
export function controllerModuleHarness(options: {
  modules?: ControllerTestModules;
  wrappers?: Readonly<Record<string, ModuleWrapper>>;
  loggingFailure?: boolean;
  fetch?: typeof fetch;
} = {}) {
  const requireHere = createRequire(import.meta.url);
  const modules = new Map<string, ModuleExports>();
  const logs: string[] = [];
  const loaded: string[] = [];
  let networkCalls = 0;
  const resolveModule = (file: string) => {
    const path = resolve(file);
    if (existsSync(path) && /\.[cm]?[jt]sx?$/.test(path)) return path;
    for (const suffix of [".ts", ".tsx", "/index.ts"]) {
      if (existsSync(path + suffix)) return path + suffix;
    }
    throw new Error(`Missing isolated controller module: ${file}`);
  };
  const log = (...values: unknown[]) => {
    logs.push(values.map(value => typeof value === "string" ? value : JSON.stringify(value)).join(" "));
    if (options.loggingFailure) throw new Error("Synthetic controller logging failure");
  };
  const load = (file: string): ModuleExports => {
    const path = resolveModule(file);
    if (path.endsWith("/legacyRouteImplementation.ts")) {
      throw new Error("Controller tests must execute the focused production graph, never the legacy owner");
    }
    const supplied = options.modules?.[path];
    if (supplied) return supplied;
    const cached = modules.get(path);
    if (cached) return cached;
    const output: ModuleExports = {};
    modules.set(path, output);
    loaded.push(path);
    const source = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    runInNewContext(source, {
      exports: output, module: { exports: output },
      Request, Response, Headers, URL, URLSearchParams, TextEncoder, TextDecoder,
      ReadableStream, TransformStream, Uint8Array, ArrayBuffer, DataView, Buffer,
      AbortController, AbortSignal, DOMException, Error, TypeError, Date,
      crypto: globalThis.crypto, performance, setTimeout, clearTimeout, setImmediate,
      process: { env: { NODE_ENV: "test" } }, console: { info: log, warn: log, error: log, log },
      fetch: options.fetch ?? (async () => { networkCalls++; throw new Error("Unexpected controller test network access"); }),
      require: (name: string): unknown => {
        if (options.modules?.[name]) return options.modules[name];
        const dependencyPath = name.startsWith(".") ? resolveModule(resolve(dirname(path), name)) : null;
        if (dependencyPath && options.modules?.[dependencyPath]) return options.modules[dependencyPath];
        if (name === "next/server") return { NextRequest, NextResponse };
        if (name === "server-only") return {};
        if (name === "node:process") return { env: { NODE_ENV: "test" } };
        const config = configurationFixture(name);
        if (config) return config;
        if (name === "@supabase/supabase-js" || name.includes("/supabase/server") || name.includes("/supabase/client")) {
          throw new Error(`An explicit isolated controller transport is required: ${name}`);
        }
        if (dependencyPath) return load(dependencyPath);
        return requireHere(name);
      },
    }, { filename: path });
    const wrapped = options.wrappers?.[path]?.(output) ?? output;
    modules.set(path, wrapped);
    return wrapped;
  };
  const call = (file: string, symbol: string, ...args: unknown[]): unknown => {
    const fn = load(file)[symbol];
    if (typeof fn !== "function") throw new Error(`Missing controller export: ${symbol}`);
    return Reflect.apply(fn, undefined, args);
  };
  const route = async (method: string, request: Request): Promise<Response> => {
    const result: unknown = await call("src/app/api/controller-exports/route.ts", method, request);
    if (!(result instanceof Response)) throw new Error("The actual controller route did not return a Response");
    return result;
  };
  return { load, call, route, logs, loaded, networkCalls: () => networkCalls };
}
