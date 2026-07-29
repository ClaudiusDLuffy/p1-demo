import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { jsPDF } from "jspdf";

import { POST } from "../app/api/invoice-pdf/parse-total/route";

test("parses a downloaded invoice with a remembered browser session", async () => {
  const document = new jsPDF();
  document.text("Invoice Number INV-200", 20, 20);
  document.text("Description", 20, 40);
  document.text("Qty", 100, 40);
  document.text("Rate", 125, 40);
  document.text("Amount", 160, 40);
  document.text("Labor service", 20, 50);
  document.text("2", 100, 50);
  document.text("80.00", 125, 50);
  document.text("160.00", 160, 50);
  document.text("Total Due 160.00", 130, 70);
  const pdf = document.output("arraybuffer");

  const projectUrl = "https://project-ref.supabase.co";
  const publishableKey = "sb_publishable_test-key";
  const userId = "11111111-1111-4111-8111-111111111111";
  const encodeJwtPart = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const accessToken = [
    encodeJwtPart({ alg: "ES256", typ: "JWT" }),
    encodeJwtPart({
      sub: userId,
      role: "authenticated",
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
    "test-signature",
  ].join(".");
  const previousProjectUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const previousPublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const originalFetch = globalThis.fetch;
  let authRequests = 0;

  process.env.NEXT_PUBLIC_SUPABASE_URL = projectUrl;
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = publishableKey;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    authRequests += 1;
    const requestUrl = new URL(String(input));
    assert.equal(requestUrl.origin, projectUrl);
    assert.equal(requestUrl.pathname, "/rest/v1/profiles");
    assert.equal(requestUrl.searchParams.get("select"), "id");
    assert.equal(requestUrl.searchParams.get("id"), `eq.${userId}`);
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("apikey"), publishableKey);
    assert.equal(headers.get("authorization"), `Bearer ${accessToken}`);
    return new Response(JSON.stringify([{ id: userId }]), {
      status: 200,
      headers: {
        "Content-Type": "application/json",
      },
    });
  }) as typeof fetch;

  try {
    const formData = new FormData();
    formData.append("file", new File([pdf], "source.pdf", {
      type: "application/pdf",
    }));
    const request = new NextRequest(
      "https://portal.example/api/invoice-pdf/parse-total",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      },
    );
    const response = await POST(request);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(authRequests, 1);
    assert.deepEqual(
      payload.lines.map((line: { desc: string; qty: number; rate: number; amount: number }) => ({
        desc: line.desc,
        qty: line.qty,
        rate: line.rate,
        amount: line.amount,
      })),
      [
        {
          desc: "Labor service",
          qty: 2,
          rate: 80,
          amount: 160,
        },
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (previousProjectUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_URL = previousProjectUrl;
    }
    if (previousPublishableKey === undefined) {
      delete process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
    } else {
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = previousPublishableKey;
    }
  }
});
