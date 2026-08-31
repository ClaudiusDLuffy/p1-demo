import assert from "node:assert/strict";
import test from "node:test";
import { calculatePdfPreviewDimensions } from "./pdfPreview";

test("PDF preview fits the page to the available width and preserves aspect ratio", () => {
  assert.deepEqual(
    calculatePdfPreviewDimensions({
      pageWidth: 612,
      pageHeight: 792,
      availableWidth: 510,
      devicePixelRatio: 1,
    }),
    {
      cssWidth: 510,
      cssHeight: 660,
      renderScale: 510 / 612,
      pixelWidth: 510,
      pixelHeight: 660,
    },
  );
});

test("PDF preview caps high-DPI and oversized rendering to protect client memory", () => {
  const dimensions = calculatePdfPreviewDimensions({
    pageWidth: 2_000,
    pageHeight: 3_000,
    availableWidth: 3_000,
    devicePixelRatio: 4,
  });

  assert.equal(dimensions.cssWidth, 1_200);
  assert.equal(dimensions.cssHeight, 1_800);
  assert.equal(dimensions.pixelWidth, 2_400);
  assert.equal(dimensions.pixelHeight, 3_600);
  assert.equal(dimensions.renderScale, 1.2);
});

test("PDF preview rejects invalid source page dimensions", () => {
  assert.throws(
    () => calculatePdfPreviewDimensions({
      pageWidth: 0,
      pageHeight: 792,
      availableWidth: 510,
    }),
    /Invalid PDF page dimensions/,
  );
});
