import { execFileSync, spawnSync } from "node:child_process";

function main() {
  execFileSync(process.execPath, ["scripts/e2e/seed-local-synthetic.mjs"], { stdio: "inherit" });
  const result = spawnSync(
    "node_modules/.bin/playwright",
    ["test", "--config", "playwright.e2e.config.mjs", ...process.argv.slice(2)],
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

