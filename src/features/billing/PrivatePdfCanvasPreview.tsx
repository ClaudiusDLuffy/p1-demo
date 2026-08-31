"use client";

import { useEffect, useRef, useState } from "react";
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { T } from "../../lib/constants";
import { calculatePdfPreviewDimensions } from "../../lib/pdfPreview";

type LoadedDocument = {
  blob: Blob;
  loadingTask: PDFDocumentLoadingTask;
  pdf: PDFDocumentProxy;
};

export default function PrivatePdfCanvasPreview({
  blob,
  title,
}: {
  blob: Blob;
  title: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loadedDocument, setLoadedDocument] = useState<LoadedDocument | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [availableWidth, setAvailableWidth] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const updateWidth = () => {
      setAvailableWidth(Math.max(0, container.clientWidth - 24));
    };
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;

    setLoadedDocument(null);
    setPageNumber(1);
    setLoading(true);
    setError("");

    void blob.arrayBuffer()
      .then(async data => {
        const { getDocument } = await import("pdfjs-dist/webpack.mjs");
        if (cancelled) return null;
        loadingTask = getDocument({
          data: new Uint8Array(data),
          isEvalSupported: false,
          useSystemFonts: true,
        });
        const pdf = await loadingTask.promise;
        if (cancelled) {
          await loadingTask.destroy();
          return null;
        }
        setLoadedDocument({ blob, loadingTask, pdf });
        return pdf;
      })
      .catch(loadError => {
        if (cancelled) return;
        setError(
          loadError instanceof Error
            ? loadError.message
            : "The PDF preview could not be rendered",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (loadingTask) void loadingTask.destroy();
    };
  }, [blob]);

  const currentDocument = loadedDocument?.blob === blob
    ? loadedDocument.pdf
    : null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!currentDocument || !canvas || availableWidth <= 0) return;

    let cancelled = false;
    let renderTask: RenderTask | null = null;
    setLoading(true);
    setError("");

    void currentDocument.getPage(pageNumber)
      .then(async page => {
        if (cancelled) return;
        const baseViewport = page.getViewport({ scale: 1 });
        const dimensions = calculatePdfPreviewDimensions({
          pageWidth: baseViewport.width,
          pageHeight: baseViewport.height,
          availableWidth,
          devicePixelRatio: window.devicePixelRatio || 1,
        });
        const viewport = page.getViewport({ scale: dimensions.renderScale });

        canvas.width = dimensions.pixelWidth;
        canvas.height = dimensions.pixelHeight;
        canvas.style.width = `${dimensions.cssWidth}px`;
        canvas.style.height = `${dimensions.cssHeight}px`;

        renderTask = page.render({
          canvas,
          viewport,
          background: "rgb(255,255,255)",
        });
        await renderTask.promise;
      })
      .catch(renderError => {
        if (cancelled || (renderError instanceof Error && renderError.name === "RenderingCancelledException")) {
          return;
        }
        setError(
          renderError instanceof Error
            ? renderError.message
            : "The PDF page could not be rendered",
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [availableWidth, currentDocument, pageNumber]);

  const pageCount = currentDocument?.numPages || 0;

  return (
    <div
      ref={containerRef}
      style={{
        minHeight: 520,
        display: "grid",
        alignContent: "start",
        justifyItems: "center",
        gap: 10,
        padding: 12,
        overflow: "auto",
        border: `1px solid ${T.borderSoft}`,
        borderRadius: 10,
        background: T.surfaceSoft,
      }}
    >
      {pageCount > 1 && (
        <div
          aria-label="PDF page controls"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 1,
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: 6,
            borderRadius: 8,
            background: T.surface,
            boxShadow: "0 1px 4px rgba(31,30,28,0.12)",
          }}
        >
          <button
            type="button"
            className="btn-soft"
            disabled={pageNumber <= 1 || loading}
            onClick={() => setPageNumber(current => Math.max(1, current - 1))}
          >
            Previous
          </button>
          <span className="mono" style={{ minWidth: 82, textAlign: "center", fontSize: 11 }}>
            Page {pageNumber} of {pageCount}
          </span>
          <button
            type="button"
            className="btn-soft"
            disabled={pageNumber >= pageCount || loading}
            onClick={() => setPageNumber(current => Math.min(pageCount, current + 1))}
          >
            Next
          </button>
        </div>
      )}

      {loading && (
        <div role="status" style={{ minHeight: 240, display: "grid", placeItems: "center", color: T.muted }}>
          <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <BtnSpinner /> Rendering original PDF…
          </span>
        </div>
      )}

      {error && (
        <div role="alert" style={{ padding: 12, borderRadius: 9, color: T.danger, background: T.dangerSoft }}>
          The embedded preview could not be rendered: {error}. You can still open or download the original PDF above.
        </div>
      )}

      <canvas
        ref={canvasRef}
        role="img"
        aria-label={`${title}, page ${pageNumber}${pageCount ? ` of ${pageCount}` : ""}`}
        hidden={!currentDocument || Boolean(error)}
        style={{ display: loading ? "none" : "block", maxWidth: "100%", background: "white", boxShadow: "0 1px 5px rgba(31,30,28,0.15)" }}
      />
    </div>
  );
}
