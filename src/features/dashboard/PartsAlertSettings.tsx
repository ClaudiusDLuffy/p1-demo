"use client";

import { useEffect, useMemo, useState } from "react";

import { T } from "../../lib/constants";
import { supabase } from "../../lib/supabase/client";

type Recipient = {
  profileId: string;
  phoneE164: string;
  name?: string;
  email?: string | null;
  active?: boolean;
};

type StaffProfile = {
  id: string;
  name: string;
  email?: string | null;
  active?: boolean | null;
};

async function settingsRequest(path: string, init: RequestInit = {}) {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in again.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "Parts alert request failed");
  return payload;
}

export default function PartsAlertSettings({ staffProfiles = [] }: { staffProfiles: StaffProfile[] }) {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [timezone, setTimezone] = useState("America/New_York");
  const [cutoffTime, setCutoffTime] = useState("");
  const [recipients, setRecipients] = useState<Recipient[]>([]);
  const [selectedProfileId, setSelectedProfileId] = useState("");
  const [phone, setPhone] = useState("");

  const staffById = useMemo(
    () => new Map(staffProfiles.map(profile => [profile.id, profile])),
    [staffProfiles],
  );
  const availableStaff = useMemo(
    () => staffProfiles.filter(profile =>
      profile.active !== false
      && !recipients.some(recipient => recipient.profileId === profile.id),
    ),
    [recipients, staffProfiles],
  );

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void settingsRequest("/api/parts-order-settings")
      .then(payload => {
        if (cancelled) return;
        setEnabled(Boolean(payload.enabled));
        setTimezone(payload.timezone || "America/New_York");
        setCutoffTime(payload.cutoffTime || "");
        setRecipients(payload.recipients || []);
      })
      .catch(fetchError => {
        if (!cancelled) setError(fetchError.message || "Could not load settings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded]);

  const addRecipient = () => {
    const profile = staffById.get(selectedProfileId);
    const normalizedPhone = phone.replace(/[\s()-]/g, "");
    if (!profile) {
      setError("Choose a staff member");
      return;
    }
    if (!/^\+[1-9][0-9]{7,14}$/.test(normalizedPhone)) {
      setError("Use E.164 format, such as +18135551212");
      return;
    }
    setRecipients(current => [...current, {
      profileId: profile.id,
      phoneE164: normalizedPhone,
      name: profile.name,
      email: profile.email,
      active: true,
    }]);
    setSelectedProfileId("");
    setPhone("");
    setError("");
    setSaved(false);
  };

  const save = async () => {
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const payload = await settingsRequest("/api/parts-order-settings", {
        method: "PATCH",
        body: JSON.stringify({ enabled, timezone, cutoffTime: cutoffTime || null, recipients }),
      });
      setEnabled(Boolean(payload.enabled));
      setTimezone(payload.timezone || timezone);
      setCutoffTime(payload.cutoffTime || "");
      setRecipients(payload.recipients || []);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save settings");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="card" style={{ marginTop: 12, overflow: "hidden" }}>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(value => !value)}
        style={{ width: "100%", border: 0, background: T.surface, padding: "13px 15px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, cursor: "pointer", textAlign: "left", fontFamily: "inherit" }}
      >
        <span>
          <span style={{ color: T.ink, fontSize: 12, fontWeight: 800 }}>P1 parts SMS alert</span>
          <span style={{ display: "block", marginTop: 3, color: T.subtle, fontSize: 10 }}>
            Eastern-time settings and recipients are editable without a deployment.
          </span>
        </span>
        <span aria-hidden="true" style={{ color: T.subtle, fontSize: 18, transform: expanded ? "rotate(90deg)" : "none" }}>›</span>
      </button>

      {expanded && (
        <div style={{ borderTop: `1px solid ${T.borderSoft}`, padding: 15 }}>
          {loading ? (
            <div style={{ color: T.muted, fontSize: 11 }}>Loading settings…</div>
          ) : (
            <>
              <div className="parts-alert-settings-grid" style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) minmax(140px, .7fr) auto", gap: 10, alignItems: "end" }}>
                <label style={{ color: T.muted, fontSize: 10 }}>
                  Timezone
                  <input value={timezone} onChange={event => { setTimezone(event.target.value); setSaved(false); }} style={{ display: "block", width: "100%", minHeight: 40, marginTop: 5, padding: "8px 10px", border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.ink }} />
                </label>
                <label style={{ color: T.muted, fontSize: 10 }}>
                  Daily cutoff
                  <input type="time" value={cutoffTime} onChange={event => { setCutoffTime(event.target.value); setSaved(false); }} style={{ display: "block", width: "100%", minHeight: 40, marginTop: 5, padding: "8px 10px", border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.ink }} />
                </label>
                <label style={{ minHeight: 40, display: "flex", alignItems: "center", gap: 7, color: T.ink, fontSize: 11 }}>
                  <input type="checkbox" checked={enabled} onChange={event => { setEnabled(event.target.checked); setSaved(false); }} />
                  Enabled
                </label>
              </div>

              <div style={{ marginTop: 14, color: T.ink, fontSize: 11, fontWeight: 750 }}>Recipients</div>
              <div style={{ display: "grid", gap: 7, marginTop: 7 }}>
                {recipients.map(recipient => (
                  <div key={recipient.profileId} style={{ padding: "9px 10px", border: `1px solid ${T.borderSoft}`, borderRadius: 8, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ minWidth: 0 }}>
                      <strong style={{ color: T.ink, fontSize: 11 }}>{recipient.name || staffById.get(recipient.profileId)?.name || "Staff member"}</strong>
                      <span className="mono" style={{ marginLeft: 8, color: T.muted, fontSize: 10 }}>{recipient.phoneE164}</span>
                    </span>
                    <button type="button" className="btn-soft" onClick={() => { setRecipients(current => current.filter(item => item.profileId !== recipient.profileId)); setSaved(false); }} style={{ minHeight: 32, padding: "5px 9px", color: T.danger, fontSize: 10 }}>Remove</button>
                  </div>
                ))}
                {recipients.length === 0 && <div style={{ color: T.subtle, fontSize: 10 }}>No recipients configured yet.</div>}
              </div>

              <div className="parts-alert-settings-grid" style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) minmax(180px, 1fr) auto", gap: 8, alignItems: "end", marginTop: 11 }}>
                <label style={{ color: T.muted, fontSize: 10 }}>
                  Staff member
                  <select value={selectedProfileId} onChange={event => setSelectedProfileId(event.target.value)} style={{ display: "block", width: "100%", minHeight: 40, marginTop: 5, padding: "8px 10px", border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.ink }}>
                    <option value="">Choose staff…</option>
                    {availableStaff.map(profile => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
                  </select>
                </label>
                <label style={{ color: T.muted, fontSize: 10 }}>
                  Mobile number (E.164)
                  <input value={phone} onChange={event => setPhone(event.target.value)} placeholder="+18135551212" style={{ display: "block", width: "100%", minHeight: 40, marginTop: 5, padding: "8px 10px", border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.ink }} />
                </label>
                <button type="button" className="btn-soft" onClick={addRecipient}>Add</button>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
                <div style={{ color: T.subtle, fontSize: 10, lineHeight: 1.45 }}>
                  The endpoint is wired but no scheduler is installed until Jeremy confirms the cutoff. SMS stays off unless Enabled is checked.
                </div>
                <button type="button" className="btn-primary" onClick={save} disabled={saving} style={{ opacity: saving ? 0.6 : 1 }}>
                  {saving ? "Saving…" : "Save alert settings"}
                </button>
              </div>
              {error && <div role="alert" style={{ marginTop: 9, color: T.danger, fontSize: 10 }}>{error}</div>}
              {saved && !error && <div role="status" style={{ marginTop: 9, color: T.success, fontSize: 10 }}>Parts alert settings saved.</div>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
