import assert from "node:assert/strict";
import test from "node:test";
import { BILLING_SEARCH_MAX_LENGTH, billingReadUrl, normalizeBillingSearch, parseBillingCount, parseBillingReadInput, parseBillingRows } from "./billingReadContracts";
import { billingInvoiceCountKey, billingInvoicePageKey } from "./billingQueryKeys";

test("legacy billing first pages preserve count while every continuation is rows only", () => {
  assert.equal(parseBillingReadInput(new URLSearchParams()).response, "legacy");
  for (const response of ["", "&response=rows"]) {
    assert.equal(parseBillingReadInput(new URLSearchParams(`cursor=opaque${response}`)).response, "rows");
  }
  assert.equal(parseBillingReadInput(new URLSearchParams("response=rows")).response, "rows");
});
test("billing count URL/key cannot acquire page cursor, ordering or page-size dependencies", () => {
  const params = { queue: "all", cursor: "opaque", limit: 100, sort: "total", direction: "asc", search: " synthetic " } as const;
  const url = new URL(billingReadUrl(params, "count"), "https://synthetic.invalid");
  assert.deepEqual([...url.searchParams.keys()], ["response", "queue", "search"]);
  assert.equal(parseBillingReadInput(url.searchParams).response, "count");
  assert.deepEqual(billingInvoiceCountKey("actorA", params), billingInvoiceCountKey("actorA", { ...params, search: "synthetic" }));
  assert.notDeepEqual(billingInvoiceCountKey("actorA", params), billingInvoiceCountKey("actorB", params));
  assert.notDeepEqual(billingInvoiceCountKey("actorA", params), billingInvoicePageKey("actorA", params));
});
test("billing clients bound long searches before strict read validation", () => {
  const overlong = `  ${"a".repeat(BILLING_SEARCH_MAX_LENGTH + 40)}  `;
  assert.equal(normalizeBillingSearch(overlong).length, BILLING_SEARCH_MAX_LENGTH);
  const url = new URL(billingReadUrl({ queue: "all", search: overlong }, "rows"), "https://synthetic.invalid");
  assert.equal(url.searchParams.get("search")?.length, BILLING_SEARCH_MAX_LENGTH);
  assert.doesNotThrow(() => parseBillingReadInput(url.searchParams));
  assert.deepEqual(
    billingInvoiceCountKey("actorA", { queue: "all", search: overlong }),
    billingInvoiceCountKey("actorA", { queue: "all", search: "a".repeat(BILLING_SEARCH_MAX_LENGTH) }),
  );
});
for (const invalid of ["limit=0", "limit=-1", "limit=101", "limit=1.5", "limit=12junk", "limit=", "limit=01",
  "queue=secret", "sort=untrusted", "direction=sideways", "cursor=a&cursor=b", "queue=all&queue=active",
  "search=%00", `search=${"a".repeat(201)}`, `cursor=${"a".repeat(8193)}`]) {
  test(`strict billing read rejects ${invalid.slice(0, 45)}`, () => {
    assert.throws(() => parseBillingReadInput(new URLSearchParams(`response=rows&${invalid}`)));
  });
}
test("a count request cannot accept a continuation cursor", () => {
  assert.throws(() => parseBillingReadInput(new URLSearchParams("response=count&cursor=opaque")));
});
test("billing count unknown or malformed is never represented as zero", () => {
  assert.equal(parseBillingRows({ items: [], hasMore: false, nextCursor: null }).totalCount, null);
  for (const totalCount of [undefined, null, -1, "0", Infinity, NaN, 1.1]) {
    assert.throws(() => parseBillingCount({ totalCount }));
  }
  assert.deepEqual(parseBillingCount({ totalCount: 0 }), { totalCount: 0 });
});
test("billing page proof remains independent from count and rejects corrupt continuation", () => {
  assert.equal(parseBillingRows({ items: [{ id: "synthetic" }], hasMore: true, nextCursor: "opaque" }).hasMore, true);
  for (const value of [null, [], { items: [], hasMore: true, nextCursor: "opaque" },
    { items: [{ id: "a" }, { id: "a" }], hasMore: false, nextCursor: null },
    { items: [], hasMore: false, nextCursor: "unexpected" }]) assert.throws(() => parseBillingRows(value));
});
