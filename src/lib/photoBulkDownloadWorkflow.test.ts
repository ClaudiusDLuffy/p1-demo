import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const db = read("src/lib/db.ts");
const gallery = read("src/features/photos/PhotoGallery.tsx");

const allPhotosStart = db.indexOf("export async function loadAllWorkOrderPhotoPaths");
const visitsStart = db.indexOf("export async function loadWorkOrderVisitsPage", allPhotosStart);
const allPhotos = db.slice(allPhotosStart, visitsStart);

test("download all traverses the authorized photo cursor instead of only loaded thumbnails", () => {
  assert.ok(allPhotosStart >= 0);
  assert.ok(visitsStart > allPhotosStart);
  assert.match(allPhotos, /loadWorkOrderPhotosPage\(workOrderId, cursor, 100\)/);
  assert.match(allPhotos, /seenPaths/);
  assert.match(allPhotos, /seenCursors/);
  assert.match(allPhotos, /Photo pagination returned an invalid cursor/);
  assert.doesNotMatch(allPhotos, /offset|from\("photos"\)/);
});

test("bulk downloads retain the existing RLS-enforced storage boundary", () => {
  assert.match(db, /export async function loadPhotoBlob[\s\S]*storage\.from\("photos"\)\.download\(path\)/);
  assert.match(gallery, /loadAllWorkOrderPhotoPaths\(woId\)/);
  assert.match(gallery, /buildPhotoArchive\([\s\S]*loadPhotoBlob/);
  assert.match(gallery, /await import\("\.\.\/\.\.\/lib\/photoArchive"\)/);
});

test("selection mode separates download selection from destructive photo removal", () => {
  assert.match(gallery, /"Download all"/);
  assert.match(gallery, /Download selected \(\$\{selectedPaths\.size\}\)/);
  assert.match(gallery, /if \(selecting\) toggleSelected\(path\)/);
  assert.match(gallery, /\{!selecting && <button disabled=\{removing\}/);
});
