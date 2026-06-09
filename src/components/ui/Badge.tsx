"use client";

export const Badge = ({ conf, small = false }: any) => conf ? (
  <span style={{ fontSize: small ? 10 : 11, fontWeight: 600, padding: small ? "2px 8px" : "3px 10px", borderRadius: 20, background: conf.bg, color: conf.color, border: `1px solid ${conf.ring || conf.bg}`, whiteSpace: "nowrap", letterSpacing: .2 }}>{conf.label}</span>
) : null;
