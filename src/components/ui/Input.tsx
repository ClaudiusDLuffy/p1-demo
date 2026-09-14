"use client";

import { T } from "../../lib/constants";
import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { useFieldControl } from "./fieldContext";

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<"input">>(function Input(props, ref) {
  const association = useFieldControl(props);
  return <input {...props} {...association} ref={ref} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface, color: T.ink, boxSizing: "border-box", ...(props.style || {}) }} />;
});
