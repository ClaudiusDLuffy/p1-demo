"use client";

import { T } from "../../lib/constants";

export function NteApprovalWaitDot({ show }: { show?: boolean }) {
  if (!show) return null;

  return (
    <span
      role="img"
      aria-label="NTE request submitted — awaiting approval"
      title="NTE request submitted — awaiting approval"
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: "50%",
        background: T.warn,
        boxShadow: `0 0 0 3px ${T.warnSoft}`,
        flexShrink: 0,
      }}
    />
  );
}
