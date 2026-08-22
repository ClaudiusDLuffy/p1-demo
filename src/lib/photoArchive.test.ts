import assert from "node:assert/strict";
import test from "node:test";

import {
  PHOTO_ARCHIVE_MAX_BYTES,
  buildPhotoArchive,
  photoArchiveFilename,
} from "./photoArchive";

const blob = (bytes: number[], type = "image/jpeg") =>
  new Blob([new Uint8Array(bytes)], { type });

test("photo archives deduplicate paths, preserve image types, and report progress", async () => {
  const progress: string[] = [];
  const result = await buildPhotoArchive(
    ["wo/a.jpeg", "wo/a.jpeg", "wo/b"],
    async path => path.endsWith("/b")
      ? blob([4, 5], "image/png")
      : blob([1, 2, 3]),
    value => progress.push(`${value.completed}/${value.total}`),
  );
  const decoded = new TextDecoder().decode(result.archive);

  assert.equal(result.downloadedCount, 2);
  assert.equal(result.skippedCount, 0);
  assert.deepEqual(progress, ["1/2", "2/2"]);
  assert.match(decoded, /photo-01\.jpg/);
  assert.match(decoded, /photo-02\.png/);
});

test("photo archives skip unavailable objects but never produce an empty ZIP", async () => {
  const partial = await buildPhotoArchive(
    ["missing.jpg", "available.webp"],
    async path => {
      if (path.startsWith("missing")) throw new Error("not found");
      return blob([9], "image/webp");
    },
  );
  assert.equal(partial.downloadedCount, 1);
  assert.equal(partial.skippedCount, 1);

  await assert.rejects(
    () => buildPhotoArchive(["missing.jpg"], async () => {
      throw new Error("not found");
    }),
    /None of the selected photos could be downloaded/,
  );
});

test("photo archives enforce the shared safe size boundary", async () => {
  await assert.rejects(
    () => buildPhotoArchive(
      ["large.jpg"],
      async () => ({
        size: PHOTO_ARCHIVE_MAX_BYTES + 1,
        type: "image/jpeg",
        arrayBuffer: async () => new ArrayBuffer(0),
      }),
    ),
    /95 MB safe archive limit/,
  );
});

test("photo archive filenames are filesystem safe", () => {
  assert.equal(photoArchiveFilename("WOT/12 34"), "WOT-12-34-photos.zip");
});

test("photo entries ignore non-image source extensions", async () => {
  const result = await buildPhotoArchive(
    ["https://example.test/photo.php?id=1"],
    async () => blob([1], "image/jpeg"),
  );
  const decoded = new TextDecoder().decode(result.archive);
  assert.match(decoded, /photo-01\.jpg/);
  assert.doesNotMatch(decoded, /\.php/);
});
