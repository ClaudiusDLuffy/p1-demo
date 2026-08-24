export const RPC_CONFLICT_CODE = "PT409";

type RpcErrorLike = {
  code?: unknown;
  message?: unknown;
};

export function isRpcConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = String((error as RpcErrorLike).code || "").toUpperCase();
  return code === RPC_CONFLICT_CODE;
}

export function rpcConflictMessage(subject = "Record"): string {
  return `${subject} changed in another session. Latest data is being refreshed; review it before trying again.`;
}

export function rpcErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const message = (error as RpcErrorLike).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return String(error);
}
