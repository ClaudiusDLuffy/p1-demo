import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildPortalNavigationItems } from "../lib/portalNavigationItems";
import { PortalNavigation } from "./PortalNavigation";

const counts = { capital: 2, contractorActive: 3, contractorAttention: 1, contractorInvoice: 4,
  history: 5, open: 6, pendingApproval: 7, staffWork: 8 };
const render = (items: ReturnType<typeof buildPortalNavigationItems>, selectedPage: string) =>
  renderToStaticMarkup(createElement(PortalNavigation, { items, selectedPage, onNavigate() {} }));
const labels = (html: string) => [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map(match => match[1]);

test("ordinary, simplified, schedule, billing and detail pages retain the same manager menu and order", () => {
  const items = buildPortalNavigationItems({ isManager: true, invoiceController: false, counts });
  for (const selectedPage of ["dashboard", "my_schedule", "simplified", "billing", "wo_detail", "work_orders", "my_schedule"]) {
    const html = render(items, selectedPage);
    assert.deepEqual(labels(html), items.map(item => item.label));
    assert.doesNotMatch(html, /<details|More tools/);
    assert.match(html, /aria-label="Portal pages"/);
    assert.equal((html.match(/>Beta</g) || []).length, 1);
    const selected = items.find(item => item.id === selectedPage);
    assert.equal((html.match(/aria-current="page"/g) || []).length, selected ? 1 : 0);
    if (selected) assert.ok(html.includes(`aria-label="${selected.label}" aria-current="page"`));
  }
});

test("the shared menu never introduces staff or billing pages for restricted accounts", () => {
  for (const permissions of [
    { isManager: false, invoiceController: false },
    { isManager: false, invoiceController: false, canInvoice: true, canManageTeam: true },
    { isManager: false, invoiceController: true },
  ]) {
    const items = buildPortalNavigationItems({ ...permissions, counts });
    for (const selectedPage of ["my_jobs", "my_schedule", "simplified", "billing", "wo_detail"]) {
      const html = render(items, selectedPage);
      assert.deepEqual(labels(html), items.map(item => item.label));
      assert.doesNotMatch(html, /aria-label="(?:Simplified|7-Eleven billing|Contractors|Capital)"/);
    }
  }
});

test("schedule Beta and counts/attention indicators are preserved", () => {
  const items = buildPortalNavigationItems({ isManager: false, invoiceController: false, canInvoice: true, counts });
  const html = render(items, "my_schedule");
  assert.match(html, /aria-label="My Schedule" aria-current="page"/);
  assert.match(html, />Beta</);
  assert.match(html, /title="1 update need your attention"/);
  assert.match(html, />3</);
  assert.match(html, />4</);
  assert.match(html, /min-h-0 flex-1.*overflow-y-auto/);
});
