import assert from "node:assert/strict";
import test from "node:test";

import {
  contractorAttentionRequestToast,
  contractorNotificationToast,
  shouldAutomaticallyNotifyContractor,
} from "./activityNotificationPolicy";

test("staff contractor-visible messages automatically notify the assigned contractor", () => {
  for (const role of ["manager", "dispatcher", "back_office"]) {
    assert.equal(
      shouldAutomaticallyNotifyContractor(role, "contractor_message"),
      true,
    );
  }
});

test("private notes and 7-Eleven updates never enter the contractor notification path", () => {
  for (const channel of ["internal_note", "field_note", "system_event", "legacy"]) {
    assert.equal(
      shouldAutomaticallyNotifyContractor("manager", channel),
      false,
    );
  }
});

test("contractor messages do not send an automatic email back to their author", () => {
  for (const role of ["contractor", "system", null, undefined]) {
    assert.equal(
      shouldAutomaticallyNotifyContractor(role, "contractor_message"),
      false,
    );
  }
});

test("only confirmed delivery states tell staff the contractor was notified", () => {
  assert.match(contractorNotificationToast("sent"), /contractor notified$/);
  assert.match(contractorNotificationToast("already_sent"), /already notified$/);
  assert.doesNotMatch(
    contractorNotificationToast("pending_or_unknown"),
    /contractor notified$/,
  );
  assert.match(
    contractorNotificationToast("pending_or_unknown"),
    /could not yet be confirmed$/,
  );
  assert.match(
    contractorNotificationToast("delivery_unknown"),
    /could not be confirmed$/,
  );
  assert.doesNotMatch(
    contractorAttentionRequestToast("pending_or_unknown"),
    /email sent$/,
  );
  assert.match(
    contractorAttentionRequestToast("delivery_unknown"),
    /could not be confirmed$/,
  );
});
