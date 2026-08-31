export type PdfPreviewDimensions = {
  cssWidth: number;
  cssHeight: number;
  renderScale: number;
  pixelWidth: number;
  pixelHeight: number;
};

const MIN_PREVIEW_WIDTH = 240;
const MAX_PREVIEW_WIDTH = 1_200;
const MAX_PIXEL_RATIO = 2;

export function calculatePdfPreviewDimensions({
  pageWidth,
  pageHeight,
  availableWidth,
  devicePixelRatio = 1,
}: {
  pageWidth: number;
  pageHeight: number;
  availableWidth: number;
  devicePixelRatio?: number;
}): PdfPreviewDimensions {
  if (
    !Number.isFinite(pageWidth)
    || !Number.isFinite(pageHeight)
    || pageWidth <= 0
    || pageHeight <= 0
  ) {
    throw new Error("Invalid PDF page dimensions");
  }

  const safeAvailableWidth = Number.isFinite(availableWidth) && availableWidth > 0
    ? availableWidth
    : pageWidth;
  const cssWidth = Math.min(
    pageWidth,
    Math.max(MIN_PREVIEW_WIDTH, Math.min(MAX_PREVIEW_WIDTH, safeAvailableWidth)),
  );
  const cssScale = cssWidth / pageWidth;
  const pixelRatio = Math.min(
    MAX_PIXEL_RATIO,
    Math.max(1, Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1),
  );

  return {
    cssWidth,
    cssHeight: pageHeight * cssScale,
    renderScale: cssScale * pixelRatio,
    pixelWidth: Math.ceil(pageWidth * cssScale * pixelRatio),
    pixelHeight: Math.ceil(pageHeight * cssScale * pixelRatio),
  };
}
