import { AppError } from "../../lib/errors/AppError";
import type { ControllerExportApplicationResult } from "./applicationResults";

function csvStream(rows: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const iterator = rows[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(encoder.encode(next.value));
      } catch {
        // A failed download is not a successful partial audit. Never stream a raw database error.
        controller.error(new AppError("INTERNAL_ERROR"));
        await iterator.return?.();
      }
    },
    async cancel() { await iterator.return?.(); },
  });
}

export function mapControllerExportHttp(result: ControllerExportApplicationResult): Response {
  if (result.kind === "failed") throw new AppError(result.code, { status: result.status });
  if (result.kind === "csv") return new Response(csvStream(result.rows), { headers: {
    "Content-Type": "text/csv;charset=utf-8", "Content-Disposition": `attachment; filename="${result.filename}"`,
    "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
  } });
  if (result.kind === "download" || result.kind === "staged") return Response.json(result.body, {
    headers: { "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  });
  if (result.kind === "history") return Response.json(result.body, { headers: { "Cache-Control": "no-store" } });
  if (result.kind === "transition") return Response.json({ batch: result.batch }, { headers: { "Cache-Control": "no-store" } });
  return Response.json({ count: result.count, limit: result.limit, canHandoff: result.canHandoff,
    pendingCount: result.pendingCount, oldestPendingAt: result.oldestPendingAt }, { headers: { "Cache-Control": "no-store" } });
}
