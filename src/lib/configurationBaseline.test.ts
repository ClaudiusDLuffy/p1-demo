import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

type Legacy = {
  legacyTwilioCredentials: (env: Record<string, string>) => { username: string; password: string };
  legacyRedirectAllowed: (raw: string) => boolean;
  legacyGraphOrigin: (env: Record<string, string>) => string;
  legacySmsOrigin: (env: Record<string, string>) => string;
  legacyGraphConfigured: (env: Record<string, string>) => boolean;
};
const compiled = ts.transpileModule(readFileSync("src/lib/config-test-support/legacy-config.fixture", "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const legacy = {} as Legacy;
runInNewContext(compiled, { exports: legacy, URL });
test("pre-fix partial Twilio API credentials silently fall back to a different authentication mode", () => {
  const config = legacy.legacyTwilioCredentials({ TWILIO_ACCOUNT_SID: "synthetic-account", TWILIO_AUTH_TOKEN: "synthetic-token", TWILIO_API_KEY_SID: "synthetic-incomplete-key" });
  assert.equal(config.username, "synthetic-account");
  assert.equal(config.password, "synthetic-token");
});
test("pre-fix QuickBooks redirect validation accepts wrong callback path and embedded user information", () => {
  assert.equal(legacy.legacyRedirectAllowed("https://synthetic:synthetic@portal.example.invalid/wrong?unexpected=1#fragment"), true);
});
test("pre-fix preview notification families can select different application environments", () => {
  const env = { NEXT_PUBLIC_APP_URL: "https://preview.example.invalid" };
  assert.notEqual(legacy.legacyGraphOrigin(env), legacy.legacySmsOrigin(env));
});
test("pre-fix boolean Graph status cannot distinguish absent from partial configuration", () => {
  assert.equal(legacy.legacyGraphConfigured({}), false);
  assert.equal(legacy.legacyGraphConfigured({ OUTLOOK_TENANT_ID: "synthetic" }), false);
});
