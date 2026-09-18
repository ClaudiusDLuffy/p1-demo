import { execFileSync, spawnSync } from "node:child_process";

function main() {
  execFileSync(process.execPath, ["scripts/e2e/seed-local-synthetic.mjs"], { stdio: "inherit" });
  const forwarded = process.argv.slice(2);
  if (!forwarded.some(argument => argument === "--project" || argument.startsWith("--project="))) {
    forwarded.push("--project=desktop-chrome");
  }
  const result = spawnSync(
    "node_modules/.bin/playwright",
    ["test", "--config", "playwright.e2e.config.mjs", ...forwarded],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Local E2E run failed.");
  process.exitCode = 1;
}
