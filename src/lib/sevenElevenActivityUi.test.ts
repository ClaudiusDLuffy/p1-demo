import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");
const detail = read("src/features/work-orders/WorkOrderDetail.tsx");
const panels = read("src/features/work-orders/WorkOrderActivityPanels.tsx");
const hook = read("src/features/work-orders/useWorkOrders.ts");

test("the work-order detail renders two explicit posting destinations with independent drafts", () => {
  assert.match(detail, /<WorkOrderActivityPanels/);
  assert.match(detail, /key=\{woData\.id\}/);
  assert.match(panels, /7-Eleven updates \/ job notes/);
  assert.match(panels, /General chat &amp; activity/);
  assert.match(panels, /const \[generalText, setGeneralText\] = useState/);
  assert.match(detail, /fieldNoteText=\{noteText\}/);
  assert.match(panels, /postDraft\("field_note", fieldNoteText/);
  assert.match(panels, /isManager \? generalChannel : "contractor_message", generalText/);
  assert.doesNotMatch(panels, /Choose note channel|aria-label="Activity channels"/);
});

test("privacy filtering happens before the activity is split into the two threads", () => {
  assert.match(
    detail,
    /\(woData\?\.activities \|\| \[\]\)\.filter\([\s\S]*?isManager \|\| !isInternalWorkOrderActivity\(activity\)/,
  );
  assert.match(detail, /activities=\{allVisibleActivities\}/);
  assert.match(panels, /channelForWorkOrderActivity\(activity\) === "field_note"/);
  assert.match(panels, /channelForWorkOrderActivity\(activity\) !== "field_note"/);
  assert.match(panels, /internal_note: "P1 internal"/);
  assert.match(panels, /system_event: "System activity"/);
});

test("only the 7-Eleven composer can create a portal alert", () => {
  assert.match(panels, /postDraft\("field_note", fieldNoteText/);
  assert.match(panels, /Every note posted here creates a “Needs 7-Eleven update” alert/);
  assert.match(panels, /Nothing posted here creates a 7-Eleven portal alert/);
  assert.match(panels, /"internal_note" \| "contractor_message"/);
  assert.match(hook, /requiresSevenElevenSync: channel === "field_note"/);
  assert.match(hook, /activityChannel: channel/);
});

test("check-in and Pause parts are immediately optimistic and persisted as 7-Eleven updates", () => {
  for (const eventKey of ["check_in", "job_paused"]) {
    assert.match(
      hook,
      new RegExp(`localActivity\\(text, "note", isManager, "${eventKey}", true, false, "field_note"\\)`),
    );
    assert.match(
      hook,
      new RegExp(`workflowAuditFor\\([\\s\\S]*?"${eventKey}"[\\s\\S]*?"field_note",[\\s\\n]*true,[\\s\\n]*\\)`),
    );
  }
  assert.match(hook, /localActivity\(text, "note", isManager, "job_completed", true, false, "field_note"\)/);
  assert.match(hook, /completionResult = await completeWorkOrderOnce\(woId/);
  assert.match(hook, /status: workOrderStatusAfterFieldCompletion\(existing\?\.status\)/);
  assert.match(hook, /pendingSevenElevenSyncCount: pendingSevenElevenCountFor\(w\) \+ 1/);
  assert.match(hook, /existing\?\.functionalStatus !== "Work in Progress"/);
  assert.match(detail, /woData\.functionalStatus === "Work in Progress"/);
});

test("sync, contractor-attention, delete, and shared pagination controls remain available", () => {
  assert.match(panels, /doMarkSevenElevenSynced/);
  assert.match(panels, /Needs 7-Eleven update/);
  assert.match(panels, /doMarkContractorAttention/);
  assert.match(panels, /doAcknowledgeContractorAttention/);
  assert.match(panels, /setModal\("deleteActivity"\)/);
  assert.equal((panels.match(/Load older activity/g) || []).length, 1);
  assert.match(detail, /pendingSevenElevenCount=\{woData\.pendingSevenElevenSyncCount\}/);
  assert.match(panels, /Math\.max\(pendingSevenElevenCount, loadedPendingSevenEleven\)/);
});
