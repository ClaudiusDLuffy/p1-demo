import { spawn } from "node:child_process";
import config from "../../playwright.e2e.config.mjs";

// Reuse the test runner's localhost-only credentials and disabled provider settings.
// Does not reset fixtures, write credentials, or use hosted Supabase.
const server = spawn("node_modules/.bin/next", ["dev", "--hostname", "127.0.0.1", "--port", "3100"], {
  stdio: "inherit", env: config.webServer.env,
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.kill(signal));
server.on("error", () => { console.error("The disposable local app could not start."); process.exitCode = 1; });
server.on("exit", code => { process.exitCode = code || 0; });
