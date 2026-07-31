"use client";

import type { CSSProperties, MouseEvent } from "react";
import { Ico } from "./Ico";
import { T } from "../../lib/constants";

type CopyWorkOrderButtonProps = {
  value: string;
  onCopied?: (value: string) => void;
  style?: CSSProperties;
};

const fallbackCopy = (value: string) => {
  const input = document.createElement("textarea");
  input.value = value;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  document.body.removeChild(input);
};

export function CopyWorkOrderButton({
  value,
  onCopied,
  style,
}: CopyWorkOrderButtonProps) {
  const copy = async (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      fallbackCopy(value);
    }
    onCopied?.(value);
  };

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${value}`}
      aria-label={`Copy work order ${value}`}
      style={{
        width: 26,
        height: 26,
        display: "inline-grid",
        placeItems: "center",
        flex: "0 0 auto",
        padding: 0,
        border: "none",
        borderRadius: 6,
        background: "transparent",
        color: T.subtle,
        cursor: "pointer",
        ...style,
      }}
    >
      <Ico
        d="M8 8h10v10H8zM6 16H4V4h12v2"
        size={14}
        color="currentColor"
      />
    </button>
  );
}
