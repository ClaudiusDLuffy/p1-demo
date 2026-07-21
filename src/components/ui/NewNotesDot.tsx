"use client";

import { T } from "../../lib/constants";

export function NewNotesDot({ show }: { show?: boolean }) {
  if (!show) return null;

  return (
    <span
      aria-label="New notes"
      title="New notes"
      style={{
        display: "inline-block",
        width: 9,
        height: 9,
        borderRadius: "50%",
        background: T.success,
        boxShadow: `0 0 0 3px ${T.successSoft}`,
        flexShrink: 0,
      }}
    />
  );
}
