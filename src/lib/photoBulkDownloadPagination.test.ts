import assert from "node:assert/strict";
import test from "node:test";
import { createPhotoMetadataReadHarness, photoPage, photoRespond } from "./photo-metadata-read-test-support/harness";
import { PHOTO_PARENT, photoFixture, photoPath } from "./photo-metadata-read-test-support/fixtures";

for (const count of [0, 24, 25, 42, 100, 101, 242]) {
  test(`download all collects ${count} photos independently of the 24-thumbnail gallery page`, async () => {
    const rows = Array.from({ length: count }, (_, index) => photoFixture({}, index + 1));
    const plans = Array.from({ length: Math.max(1, Math.ceil(count / 100)) }, (_, index) => photoRespond(
      photoPage(rows.slice(index * 100, (index + 1) * 100), count > (index + 1) * 100 ? `next-${index + 1}` : null)));
    const harness = createPhotoMetadataReadHarness(plans);
    assert.deepEqual(await harness.collectPaths(PHOTO_PARENT), rows.map(row => row.storage_path));
    assert.ok(harness.calls.every(call => call.args.p_limit === 100));
    assert.equal(harness.remainingPlans(), 0);
  });
}

test("download all deduplicates paths across pages without duplicating ZIP images", async () => {
  const harness = createPhotoMetadataReadHarness([
    photoRespond(photoPage([photoFixture()], "next")),
    photoRespond(photoPage([photoFixture({ storage_path: photoPath(1) }, 2), photoFixture({}, 3)])),
  ]);
  assert.deepEqual(await harness.collectPaths(PHOTO_PARENT), [photoPath(1), photoPath(3)]);
});

test("download all rejects a repeated cursor instead of locking up in an infinite loop", async () => {
  const harness = createPhotoMetadataReadHarness([
    photoRespond(photoPage([photoFixture()], "same")),
    photoRespond(photoPage([photoFixture({}, 2)], "same")),
  ]);
  await assert.rejects(harness.collectPaths(PHOTO_PARENT), /Photo pagination returned an invalid cursor/);
  assert.equal(harness.calls.length, 2);
});
