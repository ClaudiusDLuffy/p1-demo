"use client";

import { T } from "../../lib/constants";

export function SevenElevenSyncBadge({ count }: { count?: number }) {
  if (!count) return null;

  return (
    <span
      title={`${count} update${count === 1 ? "" : "s"} need to be copied to the 7-Eleven portal`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "2px 7px",
        borderRadius: 9,
        border: `1px solid ${T.warn}55`,
        background: T.warnSoft,
        color: "#73560C",
        fontSize: 9,
        fontWeight: 800,
        whiteSpace: "nowrap",
      }}
    >
      711 update{count === 1 ? "" : "s"} · {count}
    </span>
  );
}
