import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
const root = path.resolve(import.meta.dirname, "..", "..", "..");
const output = path.join(root, "apps", "mobile", "docs", "EAS_UPLOAD_MANIFEST.txt");
const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root })
  .toString("utf8").split("\0").filter(Boolean).map(value => value.replaceAll("\\", "/"));
const allowed = listed.filter(file => file === "package.json" || file === "package-lock.json"
  || file.startsWith("apps/mobile/") || file.startsWith("packages/mobile-contracts/")
  || file.startsWith("packages/design-tokens/"));
const forbidden = /(?:^|\/)(?:\.git|node_modules|\.next|dist|coverage|\.expo|\.supabase|recovery|evidence)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:log|pem|p12|mobileprovision|keystore|jks|dump|sql|pdf|heic|jpe?g)$/i;
const unexpected = allowed.filter(file => forbidden.test(file) && !file.endsWith("/.env.example"));
if (unexpected.length) { console.error(`Unexpected EAS upload files:\n${unexpected.join("\n")}`); process.exit(1); }
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, allowed.sort().join("\n") + "\n");
console.log(`EAS upload manifest contains ${allowed.length} approved files.`);
