"use client";

import { T } from "../../lib/constants";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { useFieldControl } from "./fieldContext";

export const TA = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<"textarea">>(function TA(props, ref) {
  const association = useFieldControl(props);
  return <textarea {...props} {...association} ref={ref} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface, color: T.ink, resize: "vertical", boxSizing: "border-box", ...(props.style || {}) }} />;
});
