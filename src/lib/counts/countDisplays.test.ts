import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import PhotoGallery from "../../features/photos/PhotoGallery";
import VisitTimeline from "../../features/work-orders/VisitTimeline";
import WorkOrderActivityPanels from "../../features/work-orders/WorkOrderActivityPanels";

test("photo total unavailable displays loaded count, not a complete-directory assertion", () => {
  const markup = renderToStaticMarkup(createElement(PhotoGallery, { woId: "WOT-SYNTHETIC",
    photos: ["synthetic-one", "synthetic-two"], totalCount: null, hasMore: true, readOnly: true,
    setImageErrors: () => undefined, setLightbox: () => undefined }));
  assert.ok(markup.includes("Photos (2 loaded)") || /Photos \(<!-- -->2 loaded/.test(markup));
  assert.ok(markup.includes("2 loaded"));
  assert.ok(!markup.includes("of 2"));
});

test("unknown visit total preserves load-more and marks ordinal as loaded only", () => {
  const client = new QueryClient();
  try {
    const markup = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(VisitTimeline, {
      workOrder: { id: "WOT-SYNTHETIC", status: "closed", city: "Synthetic, FL" },
      visits: [{ id: "synthetic-visit", checkInAt: "2026-09-01T12:00:00Z", checkOutAt: "2026-09-01T13:00:00Z" }],
      totalCount: null, hasMore: true, currentUser: null,
    })));
    assert.ok(markup.includes("1 loaded")); assert.ok(markup.includes("Loaded visit 1"));
    assert.ok(markup.includes("Load older visits (1 loaded)")); assert.ok(!markup.includes("of 1"));
  } finally { client.clear(); }
});

test("unknown activity total never labels an incomplete first page as all activity", () => {
  const markup = renderToStaticMarkup(createElement(WorkOrderActivityPanels, {
    workOrderId: "WOT-SYNTHETIC", activities: [{ id: "synthetic-note", type: "note", text: "Synthetic fixture" }],
    totalCount: null, hasMore: true, fieldNoteText: "", setFieldNoteText: () => undefined,
    doPostNote: () => false, onCopyWorkOrder: () => undefined, aiNote: null, setAiNote: () => undefined,
    aiEnhancing: false, doAiEnhance: () => undefined, isManager: false, currentUser: null,
    activityMenuId: null, setActivityMenuId: () => undefined, setPendingDelete: () => undefined,
    setModal: () => undefined, isLoading: () => false, doMarkSevenElevenSynced: () => undefined,
    doMarkContractorAttention: () => undefined, doAcknowledgeContractorAttention: () => undefined, readOnly: true,
  }));
  assert.ok(markup.includes("Load older activity (1 loaded)")); assert.ok(!markup.includes("1 of 1"));
});
