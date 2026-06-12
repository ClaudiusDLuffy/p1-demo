"use client";

import { T } from "../../lib/constants";

export const Modal = ({ onClose, title, children, width = 480 }: any) => (
  <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) onClose(); }} style={{ position: "fixed", inset: 0, background: "rgba(31,30,28,0.45)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16 }}>
    <div className="modal-inner" style={{ background: T.surface, borderRadius: 20, width: "90%", maxWidth: width, padding: 28, animation: "fadeUp 0.25s", boxShadow: "0 20px 60px rgba(31,30,28,0.22)", maxHeight: "90vh", overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", border: `1px solid ${T.borderSoft}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div className="display" style={{ fontSize: 22, color: T.ink }}>{title}</div>
        <button className="modal-close" onClick={onClose} style={{ width: 44, height: 44, borderRadius: "50%", border: `1px solid ${T.border}`, background: T.bgWarm, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 18, color: T.muted, flexShrink: 0 }}>x</button>
      </div>
      {children}
    </div>
  </div>
);
