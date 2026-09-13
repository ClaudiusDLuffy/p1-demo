import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import {
  currentPhotoPersistenceSource, photoPersistenceHarness, verifyPhotoBaselineSource,
} from "./photo-test-support/persistenceHarness";
import { LEGACY_PHOTO_SOURCE } from "./photo-test-support/legacyPersistenceSource";
import {
  probeCanvasBuffer, syntheticBmp, syntheticPhotoBuffers, syntheticPhotoFormatProbes, syntheticTwoFrameGif,
} from "./photo-test-support/syntheticFormats";
import { syntheticHeic } from "./photo-test-support/syntheticHeic";

// These are BEFORE-fix vulnerability observations, never security acceptance.
// Default mode freezes the small legacy implementation so future remediation
// cannot erase its evidence. Run P1_PHOTO_CHARACTERIZE_CURRENT=1 before changing
// production functions to execute identical tests against actual current db.ts.
const source = process.env.P1_PHOTO_CHARACTERIZE_CURRENT === "1"
  ? currentPhotoPersistenceSource() : LEGACY_PHOTO_SOURCE;
verifyPhotoBaselineSource(source);
const file = (name = "synthetic.jpg", type = "image/jpeg") => new File(
  [new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9])], name, { type },
);

test("LEGACY positive control: upload returns paths after object, metadata and aggregate activity commits", async () => {
  const h = photoPersistenceHarness({ source });
  const paths = await h.upload([file(), file("second.png", "image/png")]);
  assert.equal(paths.length, 2);
  assert.equal(h.objects.size, 2);
  assert.equal(h.photos.length, 2);
  assert.equal(h.activities.length, 1);
  assert.equal(h.activities[0].message, "Added 2 photos.");
  assert.deepEqual(h.calls.map(call => call.split(":")[0]), [
    "storage-upload", "metadata-insert", "storage-upload", "metadata-insert", "activity-insert",
  ]);
  assert.deepEqual(paths, h.photos.map(photo => photo.storage_path));
  assert.ok(h.photos.every(photo => photo.uploader_id === h.actorId));
});

test("LEGACY defect: metadata rejection after accepted upload leaves an untracked object", async () => {
  const h = photoPersistenceHarness({ source, failures: ["metadata:1"] });
  await assert.rejects(h.upload([file()]), /metadata:1/);
  assert.equal(h.objects.size, 1);
  assert.equal(h.photos.length, 0);
  assert.equal(h.activities.length, 0);
  assert.equal(h.calls.includes("storage-delete"), false);
});

test("LEGACY defect: activity failure leaves committed metadata and objects despite rejected upload result", async () => {
  const h = photoPersistenceHarness({ source, failures: ["activity"] });
  await assert.rejects(h.upload([file()]), /activity/);
  assert.equal(h.objects.size, 1);
  assert.equal(h.photos.length, 1);
  assert.equal(h.activities.length, 0);
});

test("LEGACY defect: second-file failure partially commits and retry creates another first-file copy", async () => {
  const h = photoPersistenceHarness({ source, failures: ["upload:before:2"] });
  const files = [file("first.jpg"), file("second.jpg")];
  await assert.rejects(h.upload(files), /upload:before:2/);
  const originalPath = h.photos[0].storage_path;
  assert.equal(h.objects.size, 1);
  assert.equal(h.photos.length, 1);
  assert.equal(h.activities.length, 0);
  const retriedPaths = await h.upload(files);
  assert.equal(h.objects.size, 3);
  assert.equal(h.photos.length, 3);
  assert.equal(retriedPaths.includes(originalPath), false);
  assert.equal([...h.objects.values()].filter(object => object.file.name === "first.jpg").length, 2);
  assert.equal(h.activities.length, 1);
  assert.equal(h.activities[0].message, "Added 2 photos.");
});

test("LEGACY defect: lost upload response leaves object and uncertain retry uses a different identity", async () => {
  const h = photoPersistenceHarness({ source, failures: ["upload:after:1"] });
  const sameFile = file();
  await assert.rejects(h.upload([sameFile]), /upload:after:1/);
  const firstPath = [...h.objects.keys()][0];
  assert.equal(h.photos.length, 0);
  const retriedPaths = await h.upload([sameFile]);
  assert.equal(h.objects.size, 2);
  assert.equal(h.photos.length, 1);
  assert.notEqual(retriedPaths[0], firstPath);
  assert.ok(h.objects.has(firstPath), "No cleanup or reconciliation was attempted");
});

test("LEGACY defect: Storage delete failure removes metadata first and a retry cannot find the deleted row", async () => {
  const h = photoPersistenceHarness({ source, failures: ["storage-delete"] });
  const [path] = await h.upload([file()]);
  const result = await h.remove(path);
  assert.equal(result.success, false);
  assert.equal(h.photos.length, 0);
  assert.equal(h.objects.size, 1);
  assert.deepEqual(h.calls.slice(-2), ["metadata-delete", "storage-delete"]);
  const again = await h.remove(path);
  assert.equal(again.success, false);
  assert.ok(again.error instanceof Error);
  assert.match(again.error.message, /Only the uploader/);
  assert.equal(h.calls.filter(call => call === "storage-delete").length, 1);
  assert.equal(h.objects.size, 1);
});

test("LEGACY response model: metadata-backed Storage delete authorization disappears before its request", async () => {
  const h = photoPersistenceHarness({ source, requireMetadataForStorageDelete: true });
  const [path] = await h.upload([file()]);
  const result = await h.remove(path);
  assert.equal(result.success, false);
  assert.ok(result.error instanceof Error);
  assert.match(result.error.message, /metadata authorization was removed/);
  assert.equal(h.objects.size, 1);
  assert.equal(h.photos.length, 0);
  // This is intentionally a transport response model, not a claim of actual
  // Storage RLS execution. The separate SQL harness must verify the predicate.
});

test("LEGACY positive control: metadata-delete rejection retains metadata and never calls Storage remove", async () => {
  const h = photoPersistenceHarness({ source, failures: ["metadata-delete"] });
  const [path] = await h.upload([file()]);
  const result = await h.remove(path);
  assert.equal(result.success, false);
  assert.equal(h.photos.length, 1);
  assert.equal(h.objects.size, 1);
  assert.equal(h.calls.includes("storage-delete"), false);
});

test("LEGACY defect: misleading filename/MIME passes through without examining non-image bytes", async () => {
  const h = photoPersistenceHarness({ source });
  const invalid = new File(["Synthetic plain text, not a decodable image"], "not-really.jpg", { type: "image/jpeg" });
  const [path] = await h.upload([invalid]);
  assert.ok(path.endsWith(".jpg"));
  assert.equal(h.objects.get(path)?.contentType, "image/jpeg");
  assert.equal(new TextDecoder().decode(h.objects.get(path)?.bytes), "Synthetic plain text, not a decodable image");
  assert.equal(h.photos.length, 1);
  assert.equal(h.activities.length, 1);
});

test("LEGACY defect: direct persistence caller is not limited to the UI's first eight photos", async () => {
  const h = photoPersistenceHarness({ source });
  const paths = await h.upload(Array.from({ length: 9 }, (_, index) => file(`synthetic-${index}.jpg`)));
  assert.equal(paths.length, 9);
  assert.equal(h.photos.length, 9);
});

test("FORMAT PROBE: installed locked decoder processes synthetic JPEG, PNG, WebP, GIF and TIFF", async context => {
  const probes = await syntheticPhotoFormatProbes();
  for (const format of ["jpeg", "png", "webp", "gif", "tiff"]) {
    const probe = probes.find(probe => probe.format === format);
    assert.equal(probe?.status, "decoded", `Synthetic ${format} must decode`);
    assert.equal(probe?.width, 64);
    assert.equal(probe?.height, 48);
    assert.equal(probe?.pixels, 3072);
    context.diagnostic(`${format}: ${JSON.stringify(probe)}`);
  }
  assert.equal(syntheticBmp().readUInt32LE(2), 58);
  for (const probe of probes.filter(probe => ["bmp", "heic"].includes(probe.format))) {
    context.diagnostic(`${probe.format}: ${JSON.stringify(probe)}`);
  }
  // BMP/HEIC limitations are reported, not converted to a new application
  // format restriction. HEIC fixture was independently decoded by ImageIO.
});

test("RESOURCE PROBE: each supported synthetic image honors an explicit decoded-pixel ceiling", async () => {
  for (const { format, bytes } of await syntheticPhotoBuffers()) {
    if (["bmp", "heic"].includes(format)) continue;
    const decoded = await sharp(bytes, { failOn: "error", limitInputPixels: 3072 })
      .raw().toBuffer({ resolveWithObject: true });
    assert.equal(decoded.info.width * decoded.info.height, 3072);
    await assert.rejects(sharp(bytes, { failOn: "error", limitInputPixels: 3071 }).raw().toBuffer(), /pixel limit/);
  }
  // These tiny limits establish decoder behavior, not an application limit or
  // a claim of large-file/serverless memory certification.
});

test("RESOURCE PROBE: successful JPEG metadata does not establish complete image decoding", async () => {
  const jpeg = (await syntheticPhotoBuffers()).find(fixture => fixture.format === "jpeg");
  assert.ok(jpeg);
  const truncated = jpeg.bytes.subarray(0, jpeg.bytes.length - 2);
  const metadata = await sharp(truncated, { failOn: "error", limitInputPixels: 3072 }).metadata();
  assert.equal(metadata.width, 64);
  assert.equal(metadata.height, 48);
  await assert.rejects(sharp(truncated, { failOn: "error", limitInputPixels: 3072 }).raw().toBuffer(), /premature end/);
});

test("RESOURCE PROBE: GIF first-frame decoding is not whole-animation validation", async () => {
  const bytes = await syntheticTwoFrameGif();
  const metadata = await sharp(bytes).metadata();
  assert.equal(metadata.pages, 2);
  const first = await sharp(bytes, { limitInputPixels: 64 }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(first.info.width * first.info.height, 64);
  await assert.rejects(sharp(bytes, { animated: true, limitInputPixels: 64 }).raw().toBuffer(), /pixel limit/);
  const all = await sharp(bytes, { animated: true, limitInputPixels: 128 }).raw().toBuffer({ resolveWithObject: true });
  assert.equal(all.info.width * all.info.height, 128);
  assert.equal(all.info.pages, 2);
  // No new rejection/conversion policy for existing animated uploads is set.
});

test("CANVAS PROBE: existing decoder yields full pixels from complete tiny synthetic BMP", () => {
  for (const [width, height] of [[1, 1], [8, 8]]) {
    const result = probeCanvasBuffer(syntheticBmp(width, height));
    assert.equal(result.status, "decoded");
    assert.equal(result.width, width);
    assert.equal(result.height, height);
    assert.equal(result.rgbaBytes, width * height * 4);
    assert.deepEqual(result.firstPixel, [0, 0, 255, 255]);
  }
});

test("CANVAS PROBE: successful drawing does not prove BMP pixel data is present", context => {
  const truncated = probeCanvasBuffer(syntheticBmp().subarray(0, 54));
  context.diagnostic(JSON.stringify(truncated));
  if (truncated.status === "decoded") {
    assert.deepEqual(truncated.firstPixel, [0, 0, 0, 0]);
    assert.equal(truncated.rgbaBytes, 4);
  } else {
    assert.ok(["rejected", "native_failure"].includes(truncated.status));
  }
  assert.equal(probeCanvasBuffer(Buffer.alloc(0)).status, "rejected");
  // Lenient transparent output is a limitation, not approval for malformed
  // uploads. Different native platform builds may safely reject this fixture.
});

test("CANVAS PROBE: caller drawing ceiling is checked only after native image decoding", () => {
  const result = probeCanvasBuffer(syntheticBmp(8, 8), 16);
  assert.deepEqual(result, { status: "decoded_too_large", width: 8, height: 8 });
  // loadImage has no pixel/byte/native-memory ceiling option. This prevents
  // a second canvas allocation only; it is not predecode resource protection.
});

// Do not register an unexecuted probe as a default passing test. This optional
// diagnostic intentionally exercises previously observed native crashes in
// disposable child processes, not application acceptance behavior.
if (process.env.P1_PHOTO_NATIVE_PROBE === "1") {
  test("CANVAS PROBE: opt-in malformed BMP and HEIC native crash observation stays process-isolated", context => {
    const invalidBitDepth = Buffer.from(syntheticBmp());
    invalidBitDepth.writeUInt16LE(0, 28);
    for (const [name, bytes] of [["corrupt-bmp", invalidBitDepth], ["valid-heic", syntheticHeic()]] as const) {
      const outcome = probeCanvasBuffer(bytes);
      context.diagnostic(`${name}: ${JSON.stringify(outcome)}`);
      // This reports native capability/failure across platforms; no decoder
      // failure is misreported as passing content validation.
      assert.ok(["native_failure", "rejected", "decoded"].includes(outcome.status));
    }
  });
}
