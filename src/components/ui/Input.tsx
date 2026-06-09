"use client";

import { T } from "../../lib/constants";

export const Input = (props: any) => <input {...props} style={{ width: "100%", padding: "10px 13px", borderRadius: 10, border: `1px solid ${T.border}`, fontSize: 13, fontFamily: "inherit", background: T.surface, color: T.ink, boxSizing: "border-box", outline: "none", ...(props.style || {}) }} />;
