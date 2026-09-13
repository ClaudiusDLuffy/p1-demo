import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "./errors/AppError";
import { createPhotoMetadataReadHarness, photoPage, photoRecord, photoRespond } from "./photo-metadata-read-test-support/harness";
import { PHOTO_PARENT, expectedPhotoPage, photoFixture, photoPath } from "./photo-metadata-read-test-support/fixtures";

test("photo metadata facade preserves the exact string page, RPC arguments, canonical identity and signal", async () => {
  const controller = new AbortController();
  const row = photoFixture();
  const harness = createPhotoMetadataReadHarness([photoRespond(photoPage([row]))]);
  const result = await harness.loadPage(PHOTO_PARENT, undefined, undefined, controller.signal);
  const expected = expectedPhotoPage([photoPath()]);
  assert.deepEqual(result, expected);
  assert.equal(JSON.stringify(result), JSON.stringify(expected));
  assert.deepEqual(harness.calls, [{ name: "list_work_order_photos_rows_v1",
    args: { p_work_order_id: PHOTO_PARENT, p_limit: 24, p_cursor: null }, signal: controller.signal }]);
  assert.equal(harness.remainingPlans(), 0);
  assert.notEqual(row.id, row.storage_path.split("/")[2]);
  assert.deepEqual(Object.keys(photoRecord(result)), ["items", "nextCursor", "hasMore", "totalCount", "aggregates"]);
});

test("photo metadata continuation keeps cursor bytes and result order without a count or duplicate query", async () => {
  const cursor = "eyJjcmVhdGVkIjoiMjAyNi0wOS0wNVQwMDowMDowMCswMDowMCIsImlkIjoiYTgxMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAxIn0";
  const rows = [photoFixture({}, 3), photoFixture({}, 2), photoFixture({}, 1)];
  const harness = createPhotoMetadataReadHarness([photoRespond(photoPage(rows, cursor))]);
  const result = await harness.loadPage(PHOTO_PARENT, cursor, 24);
  assert.deepEqual(result, expectedPhotoPage([photoPath(3), photoPath(2), photoPath(1)], cursor));
  assert.equal(harness.calls.length, 1);
  assert.equal(harness.calls[0].args.p_cursor, cursor);
});

for (const name of ["first", "final"]) {
  test(`photo metadata empty ${name} page retains null count and null cursor`, async () => {
    const harness = createPhotoMetadataReadHarness([photoRespond(photoPage([]))]);
    assert.deepEqual(await harness.loadPage(PHOTO_PARENT, name === "final" ? "opaque-previous-page" : null), expectedPhotoPage([]));
    assert.equal(harness.calls.length, 1);
  });
}

test("photo metadata accepts the established JSON-string RPC envelope without payload expansion", async () => {
  const harness = createPhotoMetadataReadHarness([photoRespond(JSON.stringify(photoPage([photoFixture()]))) ]);
  assert.deepEqual(await harness.loadPage(PHOTO_PARENT), expectedPhotoPage([photoPath()]));
});

test("photo metadata null-heavy valid database row preserves its legacy path and exposes no fabricated fields", async () => {
  const path = `wo/${PHOTO_PARENT}/Synthetic historical.HEIC`;
  const row = photoFixture({ storage_path: path, uploader_id: null, uploader_name: null, caption: null, created_at: null });
  const harness = createPhotoMetadataReadHarness([photoRespond(photoPage([row]))]);
  assert.deepEqual(await harness.loadPage(PHOTO_PARENT), expectedPhotoPage([path]));
});

for (const suffix of ["Synthetic.jpg", "Synthetic.PNG", "Synthetic.webp", "Synthetic.gif", "Synthetic.tiff", "Synthetic.HEIC",
  "Synthetic.heif", "Synthetic.bmp", "Synthetic reviewed ✓ 東京.jpg", "Synthetic nested/path.jpg", ""]) {
  test(`photo metadata preserves reviewed legacy path bytes ${JSON.stringify(suffix)} without format inference`, async () => {
    const path = `wo/${PHOTO_PARENT}/${suffix}`;
    const harness = createPhotoMetadataReadHarness([photoRespond(photoPage([photoFixture({ storage_path: path })]))]);
    assert.deepEqual(await harness.loadPage(PHOTO_PARENT), expectedPhotoPage([path]));
    assert.equal(harness.calls.length, 1);
  });
}

test("photo metadata reviewed legacy parent path has no invented UUID or extension suffix requirement", async () => {
  const path = `wo/${PHOTO_PARENT}`;
  const harness = createPhotoMetadataReadHarness([photoRespond(photoPage([photoFixture({ storage_path: path })]))]);
  assert.deepEqual(await harness.loadPage(PHOTO_PARENT), expectedPhotoPage([path]));
});

test("photo metadata canonical parent remains TEXT when its exact database identity contains a slash", async () => {
  const parent = "SYNTHETIC-PHOTO/PARENT-7C3-2";
  const path = `wo/${parent}/a8400000-0000-4000-8000-000000000099`;
  const harness = createPhotoMetadataReadHarness([photoRespond(photoPage([photoFixture({ work_order_id: parent, storage_path: path })]))]);
  assert.deepEqual(await harness.loadPage(parent), expectedPhotoPage([path]));
  assert.equal(harness.calls[0].args.p_work_order_id, parent);
});

for (const value of [0, 1, 25, 9007199254740991, null]) {
  test(`photo metadata retains valid explicit compatibility totalCount ${value}`, async () => {
    const harness = createPhotoMetadataReadHarness([photoRespond({ ...photoPage([photoFixture()]), totalCount: value })]);
    assert.deepEqual(await harness.loadPage(PHOTO_PARENT), expectedPhotoPage([photoPath()], null, value));
    assert.equal(harness.calls.length, 1);
  });
}

test("photo metadata preserves established finite aggregate normalization and property ordering", async () => {
  const aggregates = { first: "1.25", second: -2, third: "0", fourth: ".5", fifth: "1e2" };
  const harness = createPhotoMetadataReadHarness([photoRespond({ ...photoPage([photoFixture()]), aggregates })]);
  const expected = expectedPhotoPage([photoPath()], null, null, { first: 1.25, second: -2, third: 0, fourth: .5, fifth: 100 });
  const result = await harness.loadPage(PHOTO_PARENT);
  assert.deepEqual(result, expected);
  assert.equal(JSON.stringify(result), JSON.stringify(expected));
});

for (const [supplied, expected] of [[undefined, 24], [0, 1], [-5, 1], [1, 1], [24.9, 24], [100, 100], [101, 100],
  [500, 100], [NaN, 25], [Infinity, 25], [-Infinity, 25]]) {
  test(`photo metadata page limit ${String(supplied)} retains existing clamp ${expected}`, async () => {
    const harness = createPhotoMetadataReadHarness([photoRespond(photoPage([]))]);
    await harness.loadPage(PHOTO_PARENT, null, supplied);
    assert.equal(harness.calls[0].args.p_limit, expected);
    assert.equal(harness.calls.length, 1);
  });
}

test("photo metadata maximum page returns one hundred paths in supplied database order with one RPC", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => photoFixture({}, index + 1));
  const expected = rows.map(row => row.storage_path);
  const harness = createPhotoMetadataReadHarness([photoRespond(photoPage(rows, "opaque-next"))]);
  assert.deepEqual(await harness.loadPage(PHOTO_PARENT, null, 100), expectedPhotoPage(expected, "opaque-next"));
  assert.equal(harness.calls.length, 1);
});

test("photo metadata missing parent preserves original error before any query", async () => {
  const harness = createPhotoMetadataReadHarness([]);
  await assert.rejects(harness.loadPage(""), { message: "A work order ID is required" });
  assert.equal(harness.calls.length, 0);
});

test("photo metadata missing parent remains the first validation even when request was already aborted", async () => {
  const controller = new AbortController(); controller.abort();
  const harness = createPhotoMetadataReadHarness([]);
  await assert.rejects(harness.loadPage("", null, 24, controller.signal), { message: "A work order ID is required" });
  assert.equal(harness.calls.length, 0);
});

test("photo metadata already-aborted transport preserves its reason and prevents dispatch", async () => {
  const controller = new AbortController(); const reason = new DOMException("Synthetic read cancelled", "AbortError");
  controller.abort(reason);
  const harness = createPhotoMetadataReadHarness([]);
  await assert.rejects(harness.loadPage(PHOTO_PARENT, null, 24, controller.signal), cause => cause === reason);
  assert.equal(harness.calls.length, 0);
});

for (const continuation of [false, true]) {
  test(`photo metadata cancellation during ${continuation ? "continuation" : "first page"} reaches actual supported transport`, async () => {
    const controller = new AbortController(); const reason = new DOMException("Synthetic during-query cancellation", "AbortError");
    let notifyDispatched: (() => void) | undefined;
    const dispatched = new Promise<void>(resolve => { notifyDispatched = resolve; });
    const harness = createPhotoMetadataReadHarness([call => {
      assert.equal(call.signal, controller.signal); notifyDispatched?.();
      return new Promise(resolve => {
        controller.signal.addEventListener("abort", () => resolve({ data: null, error: { name: "AbortError" } }), { once: true });
      });
    }]);
    const pending = harness.loadPage(PHOTO_PARENT, continuation ? "opaque-next" : null, 24, controller.signal);
    await dispatched; controller.abort(reason);
    await assert.rejects(pending, cause => cause === reason);
    assert.equal(harness.calls.length, 1);
    await assert.rejects(harness.loadPage(PHOTO_PARENT, "no-later-request", 24, controller.signal), cause => cause === reason);
    assert.equal(harness.calls.length, 1);
  });
}

test("photo metadata read aborted after transport response prevents stale result use", async () => {
  const controller = new AbortController(); const reason = new DOMException("Synthetic late read cancellation", "AbortError");
  const harness = createPhotoMetadataReadHarness([() => {
    controller.abort(reason); return { data: photoPage([photoFixture()]), error: null };
  }]);
  await assert.rejects(harness.loadPage(PHOTO_PARENT, null, 24, controller.signal), cause => cause === reason);
  assert.equal(harness.calls.length, 1);
});

for (const { error, expectedCode } of [
  { error: { code: "42501", message: "Synthetic private SQL detail", details: "Synthetic private provider payload" }, expectedCode: "FORBIDDEN" },
  { error: { code: "22023", message: "Synthetic invalid cursor detail" }, expectedCode: "VALIDATION_FAILED" },
  { error: { message: "Synthetic unexpected private provider detail" }, expectedCode: "INTERNAL_ERROR" },
]) {
  test(`photo metadata provider ${"code" in error ? error.code : "unknown"} remains safely normalized without retry`, async () => {
    const harness = createPhotoMetadataReadHarness([() => ({ data: null, error })]);
    await assert.rejects(harness.loadPage(PHOTO_PARENT), cause => {
      assert.ok(cause instanceof AppError);
      assert.equal(cause.code, expectedCode);
      assert.ok(!cause.message.includes("Synthetic"));
      assert.ok(!JSON.stringify(cause).includes("Synthetic private"));
      return true;
    });
    assert.equal(harness.calls.length, 1);
  });
}

test("photo metadata input rows/envelope are immutable and repeated reads are deterministic", async () => {
  const row = Object.freeze(photoFixture());
  const raw = Object.freeze(photoPage(Object.freeze([row])));
  const before = JSON.stringify(raw);
  const harness = createPhotoMetadataReadHarness([photoRespond(raw), photoRespond(raw)]);
  const first = await harness.loadPage(PHOTO_PARENT), second = await harness.loadPage(PHOTO_PARENT);
  assert.deepEqual(first, second); assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(raw), before); assert.equal(harness.calls.length, 2);
});
