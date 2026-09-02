import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const shell = read("src/components/PortalShell.tsx");
const historyView = read("src/features/work-orders/HistoryView.tsx");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const activityPanels = read("src/features/work-orders/WorkOrderActivityPanels.tsx");
const photoGallery = read("src/features/photos/PhotoGallery.tsx");
const historyReadMigration = read(
  "supabase/migrations/0109_immediate_seven_eleven_activity_alerts.sql",
);

test("contractors have a clearly labeled closed-jobs navigation entry", () => {
  assert.match(
    shell,
    /\{ id: "history", label: "Closed jobs",[\s\S]*badge: historyCount \|\| null \}/,
  );
  assert.match(shell, /history: isManager \? "History" : "Closed jobs"/);
  assert.match(shell, /<HistoryView[\s\S]*currentUser=\{currentUser\}/);
  assert.match(historyView, /isContractorHistory \? "Closed jobs" : "History"/);
  assert.match(
    historyView,
    /Read-only history for work orders that remain assigned to your company\./,
  );
});

test("contractor closed jobs reuse the RLS-scoped history query with explicit company scope", () => {
  assert.match(
    historyView,
    /currentUser\?\.contractorAccountId \|\| currentUser\?\.id \|\| null/,
  );
  assert.match(
    historyView,
    /scope: "history"[\s\S]*contractorId: isManager[\s\S]*: contractorId/,
  );
  assert.match(
    historyView,
    /isContractorHistory && w\.contractor !== contractorId/,
  );
  assert.match(
    historyReadMigration,
    /create or replace function public\.list_work_orders_table_page\([\s\S]*security invoker/,
  );
  assert.match(
    historyReadMigration,
    /when 'history' then work_order\.status::text = 'closed'/,
  );
  assert.match(
    historyReadMigration,
    /p_contractor_id is null or work_order\.contractor_id = p_contractor_id/,
  );
});

test("contractor history detail is read only across every mutation surface", () => {
  assert.match(
    detail,
    /const contractorHistoryReadOnly = !isManager[\s\S]*page === "history" \|\| woData\?\.status === "closed"/,
  );
  assert.match(detail, /Closed job · read only/);
  assert.match(detail, /<PhotoGallery[\s\S]*readOnly=\{contractorHistoryReadOnly\}/);
  assert.match(detail, /<WorkOrderActivityPanels[\s\S]*readOnly=\{contractorHistoryReadOnly\}/);
  assert.match(detail, /<PartsPanel[\s\S]*readOnly=\{contractorHistoryReadOnly\}/);
  assert.match(
    detail,
    /const canDeleteInvoice = !contractorHistoryReadOnly/,
  );
  assert.match(
    detail,
    /!contractorHistoryReadOnly && !invoiceController && \(isManager \|\| canInvoice\)/,
  );
  assert.match(
    detail,
    /!contractorHistoryReadOnly && woData\.status !== "closed" && \(\(\) =>/,
  );
});

test("read-only activity, photo, and part panels omit their write controls", () => {
  assert.match(activityPanels, /if \(readOnly \|\| !text \|\| posting\) return/);
  assert.match(activityPanels, /const canDelete = !readOnly/);
  assert.match(
    activityPanels,
    /!readOnly && !isManager && activity\.requiresContractorAttention/,
  );
  assert.match(
    activityPanels,
    /Closed-job activity is read only\. New notes, acknowledgements, and deletions are disabled\./,
  );
  assert.match(photoGallery, /!readOnly && doAddPhotos &&/);
  assert.match(photoGallery, /!readOnly && doRemovePhoto && \(/);
  assert.match(photoGallery, /!selecting && <button disabled=\{removing\}/);
  assert.match(detail, /!readOnly && !isP1Order && p\.status !== "received"/);
  assert.match(detail, /!readOnly && <button type="button" onClick=\{\(\) => startEdit\(p\)\}/);
});
