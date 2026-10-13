import assert from "node:assert/strict";
import test from "node:test";
import { safeErrorMessage } from "./errors/normalizeUnknown";
import { AppError } from "./errors/AppError";

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
    error => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, "PHOTO_ARCHIVE_TOO_LARGE");
      assert.match(safeErrorMessage(error), /95 MB safe archive limit.*Select fewer photos/);
      return true;
    },
  );
});

test("all-unavailable and empty photo selections retain safe actionable messages", async () => {
  await assert.rejects(buildPhotoArchive([], async () => blob([1])), error => {
    assert.equal(safeErrorMessage(error), "Select at least one photo to download.");
    return true;
  });
  await assert.rejects(buildPhotoArchive(["synthetic.png"], async () => {
    throw new Error("PRIVATE STORAGE ERROR MUST NOT LEAK");
  }), error => {
    assert.match(safeErrorMessage(error), /None of the selected photos.*Check your connection/);
    assert.doesNotMatch(safeErrorMessage(error), /PRIVATE STORAGE/);
    return true;
  });
});

test("photo download all includes more than twenty-four photos and verifies ZIP entry count", async () => {
  for (const count of [24, 25, 42, 101]) {
    const paths = Array.from({ length: count }, (_, index) => `wo/SYNTHETIC/photo-${index}.png`);
    const result = await buildPhotoArchive(paths, async () => blob([1, 2, 3], "image/png"));
    const end = new DataView(result.archive.buffer, result.archive.byteOffset + result.archive.length - 22, 22);
    assert.equal(end.getUint32(0, true), 0x06054b50);
    assert.equal(end.getUint16(10, true), count);
    assert.equal(result.downloadedCount, count);
    assert.equal(result.skippedCount, 0);
  }
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
