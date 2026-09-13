/** Frozen, synthetic-only reproduction of the pre-FILE002 route admission.
 * This deliberately preserves its unsafe decisions; never import in production.
 * The real gateway still validates JWT signatures. This fixture does not claim
 * otherwise: its mock represents a successful own-profile PostgREST lookup. */
export async function legacyInvoicePdfAdmission(
  request: { headers: Headers; formData(): Promise<FormData> },
  ownProfileLookup: (subject: string, token: string) => Promise<unknown>,
): Promise<{ status: number; bytes?: Uint8Array }> {
  const token = request.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  let subject = "";
  try {
    const parts = token.split(".");
    if (parts.length === 3 && parts[1]) {
      const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
      if (typeof payload === "object" && payload !== null && "sub" in payload && typeof payload.sub === "string") {
        subject = payload.sub;
      }
    }
  } catch { return { status: 401 }; }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(subject)) return { status: 401 };
  const profiles = await ownProfileLookup(subject, token);
  if (!Array.isArray(profiles) || !profiles.some((profile: unknown) => typeof profile === "object"
    && profile !== null && "id" in profile && profile.id === subject)) return { status: 401 };
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File) || !file.size) return { status: 400 };
  if (file.size > 5 * 1024 * 1024) return { status: 413 };
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) return { status: 415 };
  return { status: 200, bytes: new Uint8Array(await file.arrayBuffer()) };
}
