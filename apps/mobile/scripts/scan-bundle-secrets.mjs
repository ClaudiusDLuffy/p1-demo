import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "dist");
if (!fs.existsSync(output)) {
  console.error("Expo export output is missing; run the bundle before scanning.");
  process.exit(1);
}
const files = [];
const visit = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target); else files.push(target);
  }
};
visit(output);
const highRisk = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bsb_secret_[A-Za-z0-9_-]{16,}\b/,
  /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/,
];
const failures = [];
for (const file of files) {
  const value = fs.readFileSync(file);
  const source = value.toString("latin1");
  if (highRisk.some(pattern => pattern.test(source))) failures.push(path.relative(root, file));
}
if (failures.length) {
  console.error(`High-risk content entered the mobile bundle: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`Mobile bundle secret scan passed for ${files.length} exported files.`);
