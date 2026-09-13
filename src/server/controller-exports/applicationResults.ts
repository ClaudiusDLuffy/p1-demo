import type { PublicErrorCode } from "../../lib/errors/catalog";
import type { ControllerExportHistoryBody } from "./historyMapper";
import type { ExportCompensationState } from "./compensation";

export type ControllerExportDownload = {
  batchId: string; downloadUrl: string; filename: string;
  format: "reference_manifest_v2" | "legacy_saas_ant_v1";
};
/** Only validated receipt fields, never an unknown RPC object. */
export type ControllerExportTransitionReceipt =
  | { applied: true; batchId: string; status: "confirmed"; invoiceCount: number; total: number; confirmedAt: string; confirmedBy: string }
  | { applied: false; reason: "already_confirmed"; batchId: string; status: "confirmed"; confirmedAt: string; confirmedBy: string }
  | { applied: true; batchId: string; status: "cancelled"; cancelledAt: string; cancelledBy: string; reason: string };
export type ControllerExportApplicationResult =
  | { kind: "queue"; count: number; limit: 500; canHandoff: boolean; pendingCount: number; oldestPendingAt: string | null }
  | { kind: "history"; body: ControllerExportHistoryBody }
  | { kind: "csv"; rows: AsyncIterable<string>; filename: string }
  | { kind: "download"; body: ControllerExportDownload }
  | { kind: "staged"; replayed: boolean; body: ControllerExportDownload & { status: "pending"; archiveSha256: string; archiveBytes: number } }
  | { kind: "transition"; batch: ControllerExportTransitionReceipt }
  | { kind: "failed"; code: PublicErrorCode; status: number;
      outcome: "known_not_dispatched" | "known_rejected" | "unknown"; compensation?: ExportCompensationState };
