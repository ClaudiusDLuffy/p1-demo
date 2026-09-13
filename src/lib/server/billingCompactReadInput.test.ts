import assert from "node:assert/strict";
import test from "node:test";
import { parseCompactBillingRead } from "./billingCompactReadInput";

const id = "76000000-0000-4000-8000-000000000002";
const parse = (query: string) => parseCompactBillingRead(new URLSearchParams(query));
test("compact billing is explicit; legacy callers retain their representation", () => {
  assert.equal(parse("response=rows"), null);
  const page = parse("contract=compact-v1");
  assert.equal(page?.kind, "page");
  if (page?.kind === "page") assert.equal(page.page.response, "rows");
  assert.equal(parse("contract=compact-v1&response=count")?.kind, "count");
});
test("compact detail, bounded source summaries and versioned line continuation are separate", () => {
  assert.deepEqual(parse(`contract=compact-v1&invoiceId=${id}`), { kind: "summary", invoiceId: id });
  assert.deepEqual(parse(`contract=compact-v1&sourceInvoiceIds=${id}`), { kind: "sources", invoiceIds: [id] });
  assert.deepEqual(parse(`contract=compact-v1&invoiceId=${id}&lines=1&cursor=synthetic&expectedVersion=7`),
    { kind: "lines", invoiceId: id, limit: 50, cursor: "synthetic", expectedVersion: 7 });
});
for (const query of [
  "contract=other", "contract=compact-v1&contract=compact-v1", "invoiceId=nope", "lines=1",
  `invoiceId=${id}&lines=0`, `invoiceId=${id}&lines=1&limit=101`, `invoiceId=${id}&lines=1&limit=0`,
  `invoiceId=${id}&lines=1&cursor=synthetic`, `invoiceId=${id}&lines=1&cursor=%00&expectedVersion=1`,
  `invoiceId=${id}&lines=1&expectedVersion=9007199254740992`, `invoiceId=${id}&lines=1&expectedVersion=-1`,
  `invoiceId=${id}&sourceInvoiceIds=${id}`, `sourceInvoiceIds=${id},${id}`, "sourceInvoiceIds=",
  `sourceInvoiceIds=${Array.from({ length: 101 }, () => id).join(",")}`,
]) test(`invalid compact read is rejected: ${query.slice(0, 85)}`, () => {
  assert.throws(() => parse(query.startsWith("contract=") ? query : `contract=compact-v1&${query}`));
});
