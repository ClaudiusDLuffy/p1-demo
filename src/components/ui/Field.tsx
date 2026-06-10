"use client";

import { T } from "../../lib/constants";

export const Field = ({ label, children }: any) => (
  <div>
    <label style={{ fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 6, display: "block" }}>{label}</label>
    {children}
  </div>
);
