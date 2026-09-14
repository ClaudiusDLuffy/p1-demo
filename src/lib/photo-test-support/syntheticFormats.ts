import sharp from "sharp";
import { spawnSync } from "node:child_process";
import { syntheticHeic } from "./syntheticHeic";

export type PhotoFormatProbe = {
  format: string;
  status: "decoded" | "unavailable";
  bytes?: number;
  detectedFormat?: string;
  diagnostic?: string;
  width?: number;
  height?: number;
  pixels?: number;
  rawBytes?: number;
};

// One blue RGB pixel. This complete uncompressed BMP is synthetic, including
// its file/DIB headers and four-byte-aligned row; it is not a customer fixture.
export function syntheticBmp(width = 1, height = 1): Buffer {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 64 || height > 64) {
    throw new Error("Synthetic BMP fixture dimensions must be within 1..64");
  }
  const rowBytes = Math.ceil(width * 3 / 4) * 4;
  const bytes = Buffer.alloc(54 + rowBytes * height);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(rowBytes * height, 34);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) bytes[54 + y * rowBytes + x * 3] = 255;
  }
  return bytes;
}

export async function syntheticPhotoBuffers(): Promise<{ format: string; bytes: Buffer }[]> {
  const input = () => sharp({ create: { width: 64, height: 48, channels: 3, background: "#0044cc" } });
  const formats: { name: string; encode: () => Promise<Buffer> }[] = [
    { name: "jpeg", encode: () => input().jpeg().toBuffer() },
    { name: "png", encode: () => input().png().toBuffer() },
    { name: "webp", encode: () => input().webp().toBuffer() },
    { name: "gif", encode: () => input().gif().toBuffer() },
    { name: "tiff", encode: () => input().tiff().toBuffer() },
    { name: "bmp", encode: async () => syntheticBmp() },
    // The OS-generated fixture tests actual HEVC input decoding, independently
    // of the installed Sharp build's unsupported HEVC encoder.
    { name: "heic", encode: async () => syntheticHeic() },
  ];
  const buffers: { format: string; bytes: Buffer }[] = [];
  for (const format of formats) buffers.push({ format: format.name, bytes: await format.encode() });
  return buffers;
}

export async function syntheticPhotoFormatProbes(): Promise<PhotoFormatProbe[]> {
  const results: PhotoFormatProbe[] = [];
  for (const { format, bytes: encoded } of await syntheticPhotoBuffers()) {
    try {
      const metadata = await sharp(encoded, { failOn: "error", limitInputPixels: 4096 }).metadata();
      const decoded = await sharp(encoded, { failOn: "error", limitInputPixels: 4096 }).raw().toBuffer({ resolveWithObject: true });
      results.push({ format, status: "decoded", bytes: encoded.length, detectedFormat: metadata.format,
        width: decoded.info.width, height: decoded.info.height,
        pixels: decoded.info.width * decoded.info.height, rawBytes: decoded.data.length });
    } catch (error: unknown) {
      results.push({ format, status: "unavailable", diagnostic: error instanceof Error ? error.message : "Synthetic codec probe failed" });
    }
  }
  return results;
}

export async function syntheticTwoFrameGif(): Promise<Buffer> {
  const pixels = Buffer.alloc(8 * 16 * 3);
  pixels.fill(255, 8 * 8 * 3);
  return sharp(pixels, { raw: { width: 8, height: 16, channels: 3, pageHeight: 8 } })
    .gif({ delay: [100, 100], loop: 0 }).toBuffer();
}

export type CanvasBufferProbe = {
  status: "decoded" | "rejected" | "decoded_too_large" | "native_failure";
  width?: number;
  height?: number;
  rgbaBytes?: number;
  firstPixel?: number[];
  diagnostic?: string;
};

// Exploratory only: the installed native codec crashed on tiny invalid BMP and
// valid HEIC. Run it in an expendable process, never the main Node test runner.
// The timeout/output cap protect this probe; they do NOT cap native memory or
// imply that loadImage offers production resource isolation. Only bounded
// synthetic buffers generated above belong here. No path/URL input is passed.
export function probeCanvasBuffer(bytes: Buffer, maxDrawPixels = 4096): CanvasBufferProbe {
  if (bytes.length > 64 * 1024 || !Number.isInteger(maxDrawPixels) || maxDrawPixels < 1 || maxDrawPixels > 4096) {
    throw new Error("Canvas probe only accepts tiny synthetic inputs and drawing limits");
  }
  const source = `
    const { loadImage, createCanvas } = require("@napi-rs/canvas");
    loadImage(Buffer.from(process.argv[1], "base64")).then(image => {
      const width = image.width; const height = image.height;
      if (width * height > Number(process.argv[2])) {
        console.log(JSON.stringify({status:"decoded_too_large",width,height})); return;
      }
      const canvas = createCanvas(width,height);
      const context = canvas.getContext("2d");
      context.drawImage(image,0,0);
      const pixels = context.getImageData(0,0,width,height).data;
      console.log(JSON.stringify({status:"decoded",width,height,rgbaBytes:pixels.length,firstPixel:[...pixels.slice(0,4)]}));
    }).catch(error => console.log(JSON.stringify({status:"rejected",diagnostic:error.message})));
  `;
  const run = spawnSync(process.execPath, ["-e", source, bytes.toString("base64"), String(maxDrawPixels)], {
    encoding: "utf8", timeout: 3000, maxBuffer: 16 * 1024,
  });
  if (run.status !== 0 || run.signal || run.error) return {
    status: "native_failure", diagnostic: run.signal || run.error?.message || `Process exited ${run.status}`,
  };
  const value: unknown = JSON.parse(run.stdout);
  if (!value || typeof value !== "object" || !("status" in value)) throw new Error("Invalid synthetic canvas probe result");
  if (value.status === "rejected" && "diagnostic" in value && typeof value.diagnostic === "string") {
    return { status: "rejected", diagnostic: value.diagnostic };
  }
  if (!("width" in value) || typeof value.width !== "number"
    || !("height" in value) || typeof value.height !== "number") throw new Error("Invalid canvas dimensions");
  if (value.status === "decoded_too_large") return { status: value.status, width: value.width, height: value.height };
  if (value.status !== "decoded" || !("rgbaBytes" in value) || typeof value.rgbaBytes !== "number"
    || !("firstPixel" in value) || !Array.isArray(value.firstPixel)) throw new Error("Invalid canvas pixel result");
  const firstPixel = Array.from(value.firstPixel, (channel: unknown) => {
    if (typeof channel !== "number" || !Number.isInteger(channel) || channel < 0 || channel > 255) throw new Error("Invalid pixel channel");
    return channel;
  });
  return { status: value.status, width: value.width, height: value.height, rgbaBytes: value.rgbaBytes, firstPixel };
}
