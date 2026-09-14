import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..", "..", "..");
const webSource = path.join(root, "src") + path.sep;
const roots = [
  path.join(root, "apps", "mobile", "app"),
  path.join(root, "apps", "mobile", "src"),
  path.join(root, "packages", "mobile-contracts", "src"),
  path.join(root, "packages", "design-tokens", "src"),
];
const files = [];
const visit = directory => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (/\.(?:ts|tsx)$/.test(entry.name)) files.push(target);
  }
};
roots.forEach(visit);
const imports = /(?:from\s+|import\s*)["']([^"']+)["']/g;
const browserGlobal = /\b(?:window|document|localStorage|sessionStorage|FileList|URL\.createObjectURL)\b/;
const rawTokenLog = /console\.(?:log|warn|error|info)\([^\n]*(?:access.?token|refresh.?token|authorization)/i;
const forbiddenPackage = /^(?:next(?:\/|$)|@\/)/;
const forbiddenLeaf = /(?:^|\/)(?:PortalShell|server(?:-only)?|browser(?:-only)?|db)(?:\/|\.|$)/i;
const failures = [];
for (const file of files) {
  const source = fs.readFileSync(file, "utf8");
  for (const match of source.matchAll(imports)) {
    const specifier = match[1];
    const resolved = specifier.startsWith(".") ? path.resolve(path.dirname(file), specifier) : "";
    if (forbiddenPackage.test(specifier) || (resolved && (resolved + path.sep).startsWith(webSource))
      || forbiddenLeaf.test(specifier.replaceAll("\\", "/"))) {
      failures.push(`${path.relative(root, file)}: forbidden platform import ${specifier}`);
    }
  }
  if (browserGlobal.test(source)) failures.push(`${path.relative(root, file)}: browser-only global`);
  if (rawTokenLog.test(source)) failures.push(`${path.relative(root, file)}: possible raw token logging`);
}
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
console.log(`Mobile import boundary passed for ${files.length} source files.`);
