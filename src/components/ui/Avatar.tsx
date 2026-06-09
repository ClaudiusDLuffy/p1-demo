"use client";

export const Avatar = ({ initials, color, size = 36 }: any) => (
  <div style={{ width: size, height: size, borderRadius: "50%", background: color, display: "flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.32, fontWeight: 600, color: "#fff", letterSpacing: -0.3, flexShrink: 0, border: "1px solid rgba(255,255,255,0.12)" }}>{initials}</div>
);
