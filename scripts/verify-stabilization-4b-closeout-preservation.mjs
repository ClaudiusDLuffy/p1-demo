import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const snapshot = process.env.P1_4B_CLOSEOUT_SNAPSHOT;
assert(snapshot && path.isAbsolute(snapshot), "P1_4B_CLOSEOUT_SNAPSHOT must identify the verified local recovery directory");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const read = (relative) => readFileSync(path.join(snapshot, relative));
const manifestBytes = read("SHA256SUMS.json");
assert.equal(digest(manifestBytes), "27402123e7f8cbfc69ba4096e2975ff48c0dd50a4b9ddb521e6920000928f9b9", "Recovery manifest changed");
const manifests = JSON.parse(manifestBytes.toString("utf8"));
const protectedFiles = JSON.parse(read("protected-hashes.json").toString("utf8"));
const starting = JSON.parse(read("path-manifest.json").toString("utf8"));
for (const file of manifests) assert.equal(digest(read(file.path)), file.sha256, `Recovery payload changed: ${file.path}`);
for (const file of protectedFiles) assert.equal(digest(readFileSync(file.path)), file.sha256, `Protected file changed: ${file.path}`);
for (const file of starting) assert(existsSync(file.path), `Starting work discarded: ${file.path}`);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
assert.equal(git("branch", "--show-current").trim(), "fix/stabilize-app");
assert.equal(git("rev-parse", "HEAD").trim(), "19270673d7288022b35096988f3329ec810bf058");
assert.equal(git("diff", "--cached", "--name-only"), "", "Unexpected staged work");
git("diff", "--check");
const billingRoute = readFileSync("src/app/api/billing-invoices/route.ts", "utf8");
const mutations = billingRoute.slice(billingRoute.indexOf("export async function POST"));
assert.equal(digest(mutations), "f9abade754ce916e2d1319e156928c6840f1f6a13058b4fe4267756c18406f64", "Billing mutation handlers changed");
const startingPaths = new Set(starting.map(file => file.path));
const changedStartingPaths = starting.filter(file => digest(readFileSync(file.path)) !== file.sha256).map(file => file.path);
const changedPreviouslyCleanPaths = git("diff", "--name-only", "-z").split("\0").filter(file => file && !startingPaths.has(file));
const newPaths = git("ls-files", "--others", "--exclude-standard", "-z").split("\0").filter(file => file && !startingPaths.has(file));
console.log(JSON.stringify({
  snapshot, manifestSha256: digest(manifestBytes), payloadChecksums: manifests.length,
  protectedFiles: protectedFiles.length, startingPathsPresent: starting.length,
  billingMutationHandlersUnchanged: true, diffCheck: "passed", staged: 0,
  changedStartingPaths, changedPreviouslyCleanPaths, newPaths,
  protectedDocumentHashes: protectedFiles.filter(file => file.path.startsWith("docs/")),
  localRecoveryOnly: true,
}, null, 2));
