import assert from "node:assert/strict";
import test from "node:test";
import { parsePhotoMetadataPage } from "./photoMetadataValidators";
import { mapPhotoMetadataPage } from "./photoMetadataMappers";
import { createPhotoMetadataReadRepository } from "./photoMetadataReadRepository";
import { AppError } from "../../../lib/errors/AppError";
import { PHOTO_PARENT, photoFixture, photoPath, expectedPhotoPage } from "../../../lib/photo-metadata-read-test-support/fixtures";
import { createPhotoMetadataReadHarness, photoPage, photoRespond } from "../../../lib/photo-metadata-read-test-support/harness";

test("feature repository and forwarding facade execute the same validated one-RPC contract", async () => {
  const raw = photoPage([photoFixture()]);
  const calls: unknown[][] = [];
  const repository = createPhotoMetadataReadRepository({ read: async (...args) => { calls.push(args); return raw; } });
  const signal = new AbortController().signal;
  const result = await repository.loadWorkOrderPhotosPage(PHOTO_PARENT, null, 24, signal);
  const facade = createPhotoMetadataReadHarness([photoRespond(raw)]);
  assert.deepEqual(await facade.loadPage(PHOTO_PARENT, null, 24, signal), result);
  assert.deepEqual(result, expectedPhotoPage([photoPath()]));
  assert.deepEqual(calls, [["list_work_order_photos_rows_v1", { p_work_order_id: PHOTO_PARENT, p_limit: 24, p_cursor: null }, signal]]);
  assert.equal(facade.calls.length, 1);
});

const invalidRows: [string, unknown][] = [
  ["null", null], ["array", []], ["missing fields", { storage_path: photoPath() }],
  ["numeric id", photoFixture({ id: "not-a-uuid" })],
  ["wrong parent", photoFixture({ work_order_id: "OTHER-SYNTHETIC" })],
  ["wrong object parent", photoFixture({ storage_path: "wo/OTHER-SYNTHETIC/object" })],
  ["parent prefix collision", photoFixture({ storage_path: `wo/${PHOTO_PARENT}-OTHER/object` })],
  ["empty path", photoFixture({ storage_path: "" })],
  ["external path", photoFixture({ storage_path: "https://example.invalid/synthetic.jpg" })],
  ["invalid uploader", photoFixture({ uploader_id: "not-a-uuid" })],
  ["invalid timestamp", photoFixture({ created_at: "not-a-date" })],
  ["invalid calendar date", photoFixture({ created_at: "2026-02-30T00:00:00Z" })],
  ["numeric caption", { ...photoFixture(), caption: 1 }],
  ["object uploader name", { ...photoFixture(), uploader_name: {} }],
];
for (const [name, row] of invalidRows) test(`photo validator rejects ${name} without leaking raw values`, () => {
  assert.throws(() => parsePhotoMetadataPage(photoPage([row]), PHOTO_PARENT), error => {
    assert.ok(error instanceof AppError); assert.equal(error.code, "INTERNAL_ERROR");
    assert.ok(!JSON.stringify(error).includes(PHOTO_PARENT)); return true;
  });
});
const invalidPages: [string, unknown][] = [
  ["null envelope", null], ["array envelope", []], ["malformed JSON", "{"], ["missing items", {}],
  ["too many rows", photoPage(Array.from({ length: 101 }, (_, i) => photoFixture({}, i + 1)))],
  ["duplicate id", photoPage([photoFixture(), photoFixture()])],
  ["nonboolean hasMore", { ...photoPage([]), hasMore: "false" }],
  ["cursor disagreement", { ...photoPage([]), nextCursor: "opaque-next" }],
  ["empty cursor", { ...photoPage([]), nextCursor: "" }],
  ["negative count", { ...photoPage([]), totalCount: -1 }],
  ["unsafe count", { ...photoPage([]), totalCount: Number.MAX_SAFE_INTEGER + 1 }],
  ["nonfinite aggregate", { ...photoPage([]), aggregates: { value: "Infinity" } }],
];
for (const [name, raw] of invalidPages) test(`photo validator rejects ${name}`, () => {
  assert.throws(() => parsePhotoMetadataPage(raw, PHOTO_PARENT), AppError);
});
test("pure mapper preserves order, cursor, payload bytes and immutable input", () => {
  const raw = photoPage([photoFixture({}, 2), photoFixture()], "opaque-native-cursor");
  const validated = parsePhotoMetadataPage(raw, PHOTO_PARENT);
  Object.freeze(validated.items); Object.freeze(validated);
  const before = JSON.stringify(validated), mapped = mapPhotoMetadataPage(validated);
  assert.equal(JSON.stringify(mapped), JSON.stringify(expectedPhotoPage([photoPath(2), photoPath()], "opaque-native-cursor")));
  assert.equal(JSON.stringify(validated), before);
  assert.notEqual(mapped.items, validated.items);
});
