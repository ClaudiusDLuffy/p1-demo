"use client";

import Image from "next/image";
import { Avatar } from "../../components/ui/Avatar";
import { T, DEMO_ACCOUNTS, DEMO_PASSWORD } from "../../lib/constants";

export default function LoginForm({
  loginEmail, setLoginEmail, loginPassword, setLoginPassword,
  loginLoading, loginError, fadeIn, imageErrors, setImageErrors,
  doLogin, CSS
}: any) {
  return (
    <div style={{ minHeight: "100vh", background: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-inter), system-ui, sans-serif", padding: 16, opacity: fadeIn ? 1 : 0, transition: "opacity 0.6s", position: "relative" }}>
      <style>{CSS}</style>
      <div style={{ position: "absolute", inset: 0, backgroundImage: "radial-gradient(circle at 1px 1px, rgba(31,30,28,0.04) 1px, transparent 0)", backgroundSize: "28px 28px" }} />
      <div style={{ position: "relative", zIndex: 1, width: "100%", maxWidth: 420 }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", padding: "14px 22px", borderRadius: 16, background: "#fff", marginBottom: 18, boxShadow: "0 8px 24px rgba(31,30,28,0.12)", border: `1px solid ${T.borderSoft}` }}>
            {imageErrors.loginLogo ? (
              <div style={{ width: 56, height: 56, background: T.ink, color: T.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--font-instrument-serif), serif", fontSize: 28, letterSpacing: -1 }}>P1</div>
            ) : (
              <Image
                src="/p1-pros-logo.jpeg"
                alt="P1 Pros"
                width={180}
                height={60}
                style={{ objectFit: "contain" }}
                priority
                onError={() => setImageErrors((prev: any) => ({ ...prev, loginLogo: true }))}
              />
            )}
          </div>
          <div className="display" style={{ fontSize: 34, color: T.ink, lineHeight: 1.1 }}>P1 Service Portal</div>
          <div style={{ fontSize: 14, color: T.muted, marginTop: 8 }}>Operations for 7-Eleven facility services</div>
        </div>
        <div className="card" style={{ padding: 28 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: T.ink, marginBottom: 18 }}>Sign in to your account</div>
          <div style={{ marginBottom: 14 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 7, display: "block", textTransform: "uppercase", letterSpacing: 0.8 }}>Email</label>
            <input value={loginEmail} onChange={e => setLoginEmail(e.target.value)} placeholder="you@p1pros.com" style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surfaceSoft, color: T.ink, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
          </div>
          <div style={{ marginBottom: 18 }}>
            <label style={{ fontSize: 11, fontWeight: 600, color: T.muted, marginBottom: 7, display: "block", textTransform: "uppercase", letterSpacing: 0.8 }}>Password</label>
            <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} style={{ width: "100%", padding: "12px 14px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surfaceSoft, color: T.ink, fontSize: 14, fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
          </div>
          {loginError && <div style={{ fontSize: 12, color: T.danger, background: T.dangerSoft, border: `1px solid ${T.dangerSoft}`, borderRadius: 8, padding: "9px 12px", marginBottom: 14 }}>{loginError}</div>}
          {loginLoading ? <div style={{ textAlign: "center", padding: "12px 0" }}><div style={{ width: 22, height: 22, border: `3px solid ${T.borderSoft}`, borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.7s linear infinite", margin: "0 auto" }} /></div>
            : <button onClick={() => doLogin(loginEmail, loginPassword)} style={{ width: "100%", padding: 13, borderRadius: 10, background: T.ink, color: T.bg, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 14, fontFamily: "inherit" }}>Sign in</button>}
        </div>
        <div style={{ marginTop: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 500, color: T.subtle, textAlign: "center", marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>Demo - quick access</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            {DEMO_ACCOUNTS.map(u => (
              <button key={u.email} onClick={() => { setLoginEmail(u.email); doLogin(u.email, DEMO_PASSWORD); }} className="card-hover" style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 10, border: `1px solid ${T.border}`, background: T.surface, cursor: "pointer", fontFamily: "inherit", textAlign: "left" }}>
                <Avatar initials={u.initials} color={u.color} size={32} />
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 12, fontWeight: 600, color: T.ink, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{u.name}</div>
                  <div style={{ fontSize: 10, color: T.muted }}>{u.subtitle}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
