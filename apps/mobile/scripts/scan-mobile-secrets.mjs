import fs from "node:fs";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const scanRoots = [path.join(root, "apps", "mobile"), path.join(root, "packages", "mobile-contracts"),
  path.join(root, "packages", "design-tokens")];
const ignored = new Set(["node_modules", "dist", ".expo", "coverage"]);
const files = [];
const visit = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target); else files.push(target);
  }
};
scanRoots.forEach(visit);
const highRisk = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
  /(?:SERVICE_ROLE|DATABASE_PASSWORD|JWT_SECRET|CRON_SECRET|TWILIO_AUTH_TOKEN|QUICKBOOKS_CLIENT_SECRET)\s*[:=]\s*["'][^"'\n<{][^"'\n]{7,}/i,
];
const failures = [];
for (const file of files) {
  if (!/\.(?:ts|tsx|js|mjs|json|md|example|toml|yaml|yml)$/.test(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  if (highRisk.some(pattern => pattern.test(source))) failures.push(path.relative(root, file));
}
if (failures.length) { console.error(`High-risk secret content: ${failures.join(", ")}`); process.exit(1); }
console.log(`Mobile source secret scan passed for ${files.length} files.`);
