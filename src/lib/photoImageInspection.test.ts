import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import { deflateSync } from "node:zlib";
import test from "node:test";
import sharp from "sharp";
import ts from "typescript";
import {
  detectPhotoSignature, PHOTO_ACCEPTED_FORMAT_GUIDANCE, PHOTO_CONTENT_LIMITS,
  PHOTO_IMAGE_FORMATS, PHOTO_INPUT_ACCEPT, type PhotoImageMetadata,
} from "./photoContentPolicy";
import { syntheticBmp, syntheticPhotoBuffers, syntheticTwoFrameGif } from "./photo-test-support/syntheticFormats";
import { syntheticHeic } from "./photo-test-support/syntheticHeic";

type Inspector = (bytes: Uint8Array, signal?: AbortSignal) => Promise<PhotoImageMetadata>;

// Node does not install Next's server-only virtual alias. Execute the actual
// TS parent with only that marker and process-launch/timer IO replaceable.
// Standard tests below launch the real independently checked Sharp worker.
function loadInspector(options: { childScript?: string; deadlineMs?: number; failSpawn?: boolean } = {}) {
  const filename = resolve("src/lib/server/photoImageInspection.ts");
  const requireHere = createRequire(import.meta.url);
  const children: ChildProcessWithoutNullStreams[] = [];
  const environments: (NodeJS.ProcessEnv | undefined)[] = [];
  const exports: Record<string, unknown> = {};
  runInNewContext(ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    exports, Buffer, process, Error, clearTimeout,
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, options.deadlineMs ?? delay),
    require: (name: string) => {
      if (name === "server-only") return {};
      if (name === "node:child_process") return {
        spawn: (command: string, args: string[], launchOptions: SpawnOptionsWithoutStdio) => {
          if (options.failSpawn) throw new Error("Synthetic provider detail never exposed");
          environments.push(launchOptions.env);
          const child = spawn(command, options.childScript ? ["-e", options.childScript] : args, {
            ...launchOptions, stdio: ["pipe", "pipe", "pipe"],
          });
          children.push(child);
          return child;
        },
      };
      return requireHere(name.startsWith(".") ? resolve(filename, "..", name) : name);
    },
  }, { filename });
  assert.equal(typeof exports.inspectPhotoImage, "function");
  // Known source export, runtime checked as callable; its unknown child JSON
  // is validated inside production code and exercised by malformed IO tests.
  const inspect = exports.inspectPhotoImage as Inspector;
  return { inspect, children, environments };
}

function assertCode(code: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok("code" in error);
    assert.equal(error.code, code);
    assert.doesNotMatch(error.message, /sharp|vips|native|node_modules|\/private\/|provider detail|stack trace/i);
    return true;
  };
}

async function jpeg() {
  return sharp({ create: { width: 64, height: 48, channels: 3, background: "#0044cc" } }).jpeg().toBuffer();
}

function pngChunk(type: string, data: Buffer): Buffer {
  const named = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const byte of named) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, named, checksum]);
}

function syntheticPng(width: number, height: number, animation: boolean | "separate_default" = false): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  // Only tiny rows are allocated, including when testing a declared oversized
  // raster: that case must fail the header resource check before decoding.
  const rowWidth = 8 * 3 + 1;
  const pixels = Buffer.alloc(rowWidth * 8);
  const chunks = [Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk("IHDR", header)];
  const frameControl = (sequence: number) => {
    const data = Buffer.alloc(26);
    data.writeUInt32BE(sequence); data.writeUInt32BE(width, 4); data.writeUInt32BE(height, 8);
    data.writeUInt16BE(1, 20); data.writeUInt16BE(10, 22);
    return pngChunk("fcTL", data);
  };
  if (animation) {
    const control = Buffer.alloc(8); control.writeUInt32BE(animation === "separate_default" ? 1 : 2);
    chunks.push(pngChunk("acTL", control));
    if (animation !== "separate_default") chunks.push(frameControl(0));
  }
  chunks.push(pngChunk("IDAT", deflateSync(pixels)));
  if (animation) {
    pixels.fill(255); for (let row = 0; row < 8; row += 1) pixels[row * rowWidth] = 0;
    const sequence = Buffer.alloc(4); sequence.writeUInt32BE(animation === "separate_default" ? 1 : 2);
    chunks.push(frameControl(animation === "separate_default" ? 0 : 1), pngChunk("fdAT", Buffer.concat([sequence, deflateSync(pixels)])));
  }
  chunks.push(pngChunk("IEND", Buffer.alloc(0)));
  assert.equal(chunks[chunks.length - 1].readUInt32BE(8), 0xae426082, "Known PNG IEND CRC checks fixture construction");
  return Buffer.concat(chunks);
}

test("photo policy uses actual bytes and a closed browser-safe accepted format list", async () => {
  for (const { format, bytes } of await syntheticPhotoBuffers()) {
    assert.equal(detectPhotoSignature(bytes).status, ["bmp", "heic"].includes(format) ? "unsupported" : "accepted");
  }
  assert.equal(detectPhotoSignature(new TextEncoder().encode("<svg></svg>")).status, "unsupported");
  assert.match(PHOTO_ACCEPTED_FORMAT_GUIDANCE, /JPEG, PNG, WebP, GIF, or TIFF/);
  assert.match(PHOTO_ACCEPTED_FORMAT_GUIDANCE, /HEIC and HEIF upload support is temporarily unavailable/);
  assert.match(PHOTO_ACCEPTED_FORMAT_GUIDANCE, /BMP uploads are unsupported/);
  assert.match(PHOTO_ACCEPTED_FORMAT_GUIDANCE, /Existing uploaded photos are unaffected/);
  for (const format of Object.values(PHOTO_IMAGE_FORMATS)) {
    assert.ok(PHOTO_ACCEPTED_FORMAT_GUIDANCE.includes(format.label));
    assert.ok(PHOTO_INPUT_ACCEPT.split(",").includes(format.mimeType));
    assert.ok(format.extensions.every(extension => PHOTO_INPUT_ACCEPT.split(",").includes(`.${extension}`)));
  }
  const file = new File([new Uint8Array(await jpeg())], "camera.heic", { type: "application/octet-stream" });
  const result = await loadInspector().inspect(new Uint8Array(await file.arrayBuffer()));
  assert.equal(result.format, "jpeg");
  assert.equal(result.mimeType, "image/jpeg");
  assert.equal(result.extension, "jpg");
});

test("HEIC/HEIF/BMP bytes are denied before launching any native decoder regardless of their names", async () => {
  const h = loadInspector();
  const heifHeader = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypmif1"), Buffer.alloc(4), Buffer.from("mif1heix")]);
  assert.deepEqual(detectPhotoSignature(heifHeader), { status: "unsupported", format: "heif" });
  for (const bytes of [syntheticBmp(), syntheticHeic(), heifHeader]) {
    for (const type of ["image/jpeg", "application/octet-stream"]) {
      for (const filename of ["disguised.jpg", "disguised.png"]) {
        const file = new File([new Uint8Array(bytes)], filename, { type });
        await assert.rejects(h.inspect(new Uint8Array(await file.arrayBuffer())), assertCode("UNSUPPORTED_IMAGE_FORMAT"));
      }
    }
  }
  assert.equal(h.children.length, 0);
});

test("image byte bounds, empty content and unknown formats are rejected before process creation", async () => {
  const h = loadInspector();
  await assert.rejects(h.inspect(new Uint8Array()), assertCode("EMPTY_IMAGE"));
  await assert.rejects(h.inspect(new Uint8Array(PHOTO_CONTENT_LIMITS.maxBytes + 1)), assertCode("IMAGE_TOO_LARGE"));
  await assert.rejects(h.inspect(new TextEncoder().encode("not an image")), assertCode("UNSUPPORTED_IMAGE_FORMAT"));
  assert.equal(h.children.length, 0);
});

test("trusted worker fully decodes all five accepted formats and derives stable digest and metadata", async () => {
  const h = loadInspector();
  for (const { format, bytes } of await syntheticPhotoBuffers()) {
    if (format === "bmp" || format === "heic") continue;
    const result = await h.inspect(bytes);
    assert.ok(result.format in PHOTO_IMAGE_FORMATS);
    const { mimeType, extension } = PHOTO_IMAGE_FORMATS[result.format];
    assert.deepEqual({ ...result }, { format, mimeType, extension, sizeBytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"), width: 64, height: 48, frames: 1 });
  }
  assert.ok(h.children.every(child => child.exitCode === 0));
  assert.ok(h.environments.every(environment => environment && Object.keys(environment).sort().join(",") === "NODE_ENV,UV_THREADPOOL_SIZE,VIPS_CONCURRENCY"));
});

test("truncated and corrupt accepted-format bytes fail full verification with safe errors", async () => {
  const h = loadInspector();
  for (const { format, bytes } of await syntheticPhotoBuffers()) {
    if (format === "bmp" || format === "heic") continue;
    await assert.rejects(h.inspect(bytes.subarray(0, Math.floor(bytes.length / 2))), assertCode("INVALID_IMAGE_CONTENT"));
    await assert.rejects(h.inspect(bytes.subarray(0, bytes.length - 2)), assertCode("INVALID_IMAGE_CONTENT"));
  }
  const full = await jpeg();
  const truncated = full.subarray(0, full.length - 2);
  assert.equal((await sharp(truncated).metadata()).width, 64, "Header inspection alone would accept this file");
  await assert.rejects(h.inspect(truncated), assertCode("INVALID_IMAGE_CONTENT"));
});

test("accepted animated GIF reports every frame and rejects frame-count overflow", async () => {
  const h = loadInspector();
  const result = await h.inspect(await syntheticTwoFrameGif());
  assert.equal(result.frames, 2);
  assert.equal(result.width, 8);
  assert.equal(result.height, 8);
  const pixels = Buffer.alloc(8 * 8 * 101 * 3);
  for (let frame = 0; frame < 101; frame += 1) pixels.fill(frame % 2 ? 255 : 0, frame * 8 * 8 * 3, (frame + 1) * 8 * 8 * 3);
  const excessive = await sharp(pixels, { raw: { width: 8, height: 8 * 101, channels: 3, pageHeight: 8 } }).gif({ effort: 1 }).toBuffer();
  assert.equal((await sharp(excessive).metadata()).pages, 101);
  await assert.rejects(h.inspect(excessive), assertCode("IMAGE_RESOURCE_LIMIT"));
});

test("individual image dimensions are bounded before full raster statistics", async () => {
  const h = loadInspector();
  for (const [width, height] of [[12001, 1], [1, 12001]]) {
    const bytes = await sharp({ create: { width, height, channels: 3, background: "white" } }).png().toBuffer();
    await assert.rejects(h.inspect(bytes), assertCode("IMAGE_RESOURCE_LIMIT"));
  }
});

test("total-pixel overflow is denied from bounded metadata without allocating the declared raster", async () => {
  const h = loadInspector();
  const excessive = syntheticPng(10000, 5000);
  assert.ok(excessive.length < 1000);
  await assert.rejects(h.inspect(excessive), assertCode("IMAGE_RESOURCE_LIMIT"));
});

test("PNG checksum corruption and unverified APNG frames are not silently accepted", async () => {
  const h = loadInspector();
  const staticPng = syntheticPng(8, 8);
  assert.equal((await h.inspect(staticPng)).frames, 1);
  const corrupt = Buffer.from(staticPng); corrupt[corrupt.length - 1] ^= 1;
  await assert.rejects(h.inspect(corrupt), assertCode("INVALID_IMAGE_CONTENT"));
  const animation = syntheticPng(8, 8, true);
  const metadata = await sharp(animation, { animated: true }).metadata();
  if ((metadata.pages ?? 1) === 2) {
    assert.equal((await h.inspect(animation)).frames, 2);
  } else {
    await assert.rejects(h.inspect(animation), assertCode("INVALID_IMAGE_CONTENT"));
  }
  // libspng in the locked local build exposes only APNG's default image. A
  // future decoder may support it, but declared frames must always match.
  const separateDefault = syntheticPng(8, 8, "separate_default");
  assert.equal((await sharp(separateDefault, { animated: true }).metadata()).pages, undefined,
    "The locked native decoder does not expose the separate APNG animation frame");
  await assert.rejects(h.inspect(separateDefault), assertCode("INVALID_IMAGE_CONTENT"));
});

test("timeout kills the actual child process instead of merely abandoning its promise", async () => {
  const h = loadInspector({ childScript: "process.stdin.resume();setInterval(()=>{},1000)", deadlineMs: 100 });
  await assert.rejects(h.inspect(await jpeg()), assertCode("IMAGE_INSPECTION_TIMEOUT"));
  assert.equal(h.children.length, 1);
  assert.equal(h.children[0].signalCode, "SIGKILL");
  assert.throws(() => process.kill(h.children[0].pid ?? -1, 0), /ESRCH/);
});

test("abort terminates native work and pre-aborted requests never start a process", async () => {
  const h = loadInspector({ childScript: "process.stdin.resume();setInterval(()=>{},1000)" });
  const bytes = await jpeg();
  const controller = new AbortController();
  const pending = h.inspect(bytes, controller.signal);
  controller.abort();
  await assert.rejects(pending, assertCode("IMAGE_INSPECTION_ABORTED"));
  assert.equal(h.children[0].signalCode, "SIGKILL");
  const count = h.children.length;
  await assert.rejects(h.inspect(bytes, controller.signal), assertCode("IMAGE_INSPECTION_ABORTED"));
  assert.equal(h.children.length, count);
});

test("one inspection slot rejects overflow without retaining an input queue and releases after termination", async () => {
  const h = loadInspector({ childScript: "process.stdin.resume();setInterval(()=>{},1000)" });
  const bytes = await jpeg();
  const first = new AbortController();
  const a = h.inspect(bytes, first.signal);
  await assert.rejects(h.inspect(bytes), assertCode("IMAGE_INSPECTION_BUSY"));
  assert.equal(h.children.length, 1);
  first.abort();
  await assert.rejects(a, assertCode("IMAGE_INSPECTION_ABORTED"));
  const third = new AbortController(); const retry = h.inspect(bytes, third.signal); third.abort();
  await assert.rejects(retry, assertCode("IMAGE_INSPECTION_ABORTED"));
  assert.equal(h.children.length, 2);
});

test("malformed worker output, process failure and synchronous launch errors never expose internals", async () => {
  for (const childScript of [
    "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('provider detail /private/secret'))",
    "process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('native stack trace');process.exit(1)})",
    "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('x'.repeat(8192)))",
  ]) await assert.rejects(loadInspector({ childScript }).inspect(await jpeg()), assertCode("IMAGE_INSPECTION_FAILED"));
  await assert.rejects(loadInspector({ failSpawn: true }).inspect(await jpeg()), assertCode("IMAGE_INSPECTION_FAILED"));
});

test("worker metadata cannot substitute another image digest, dimensions or result contract", async () => {
  const bytes = await jpeg();
  const valid = { ok: true, format: "jpeg", sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"), width: 64, height: 48, frames: 1 };
  for (const changed of [
    { sha256: "0".repeat(64) }, { sizeBytes: bytes.length + 1 }, { format: "png" },
    { width: 0 }, { height: 12001 }, { frames: 101 }, { extra: "untrusted detail" },
  ]) {
    const output = JSON.stringify({ ...valid, ...changed });
    const childScript = `process.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(output)}))`;
    await assert.rejects(loadInspector({ childScript }).inspect(bytes), assertCode("IMAGE_INSPECTION_FAILED"));
  }
});
