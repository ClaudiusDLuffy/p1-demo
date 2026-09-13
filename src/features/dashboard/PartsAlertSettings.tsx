"use client";

import { apiFetch } from "../../lib/errors/apiFetch";
import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import { useEffect, useState } from "react";
import { DirectorySelect } from "../directory/DirectorySelect";
import type { DirectoryItem } from "../directory/contracts";

import { T } from "../../lib/constants";
import { supabase } from "../../lib/supabase/client";
import { PARTS_RECIPIENT_LIMIT, partsSettingsResponseSchema } from "../parts-sms/settingsContract";

type Recipient = {
  profileId: string;
  phoneE164: string;
  name?: string;
  email?: string | null;
  active?: boolean;
};

async function settingsRequest(path: string, init: RequestInit = {}) {
  const sb = supabase();
  const { data } = await sb.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Your session expired. Sign in again.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const response = await apiFetch(path, { ...init, headers });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 ? "Your session expired. Sign in again."
    : response.status === 403 ? "Operational staff access is required."
      : response.status === 400 ? "Check the recipients, timezone, cutoff and enabled setting."
        : "The settings result could not be confirmed. Refresh before trying again.");
  const parsed = partsSettingsResponseSchema.safeParse(payload);
  if (!parsed.success) throw new Error("The settings result could not be confirmed. Refresh before trying again.");
  return parsed.data;
}

export default function PartsAlertSettings() {
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
  const [selectedProfile, setSelectedProfile] = useState<DirectoryItem | null>(null);
  const [phone, setPhone] = useState("");

  useEffect(() => {
    if (!expanded) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    void settingsRequest("/api/parts-order-settings")
      .then(payload => {
        if (cancelled) return;
        setEnabled(payload.enabled);
        setTimezone(payload.timezone || "America/New_York");
        setCutoffTime(payload.cutoffTime || "");
        // Runtime validation above requires these strings; explicitly project
        // them because this legacy repository also compiles with strict=false.
        setRecipients(payload.recipients.map(recipient => ({ ...recipient,
          profileId: String(recipient.profileId), phoneE164: String(recipient.phoneE164) })));
      })
      .catch((fetchError: unknown) => {
        if (!cancelled) setError(safeErrorMessage(fetchError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded]);

  const addRecipient = () => {
    if (recipients.length >= PARTS_RECIPIENT_LIMIT) {
      setError("A maximum of 25 staff recipients is supported.");
      return;
    }
    const profile = selectedProfile;
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
      active: true,
    }]);
    setSelectedProfileId("");
    setSelectedProfile(null);
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
        body: JSON.stringify({ enabled, timezone, cutoffTime: cutoffTime || null,
          recipients: recipients.map(recipient => ({ profileId: recipient.profileId,
            phoneE164: recipient.phoneE164, active: recipient.active === true })) }),
      });
      setEnabled(payload.enabled);
      setTimezone(payload.timezone || timezone);
      setCutoffTime(payload.cutoffTime || "");
      setRecipients(payload.recipients.map(recipient => ({ ...recipient,
        profileId: String(recipient.profileId), phoneE164: String(recipient.phoneE164) })));
      setSaved(true);
    } catch (saveError) {
      setError(safeErrorMessage(saveError));
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
                      <strong style={{ color: T.ink, fontSize: 11 }}>{recipient.name || "Staff member"}</strong>
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
                  <DirectorySelect domain="staff_choices" value={selectedProfileId} emptyLabel="Choose staff…"
                    excludedIds={recipients.map(recipient => recipient.profileId)}
                    onChange={(event, item) => { setSelectedProfileId(event.target.value); setSelectedProfile(item); }} />
                </label>
                <label style={{ color: T.muted, fontSize: 10 }}>
                  Mobile number (E.164)
                  <input value={phone} onChange={event => setPhone(event.target.value)} placeholder="+18135551212" style={{ display: "block", width: "100%", minHeight: 40, marginTop: 5, padding: "8px 10px", border: `1px solid ${T.border}`, borderRadius: 8, background: T.surface, color: T.ink }} />
                </label>
                <button type="button" className="btn-soft" onClick={addRecipient}>Add</button>
              </div>

              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
                <div style={{ color: T.subtle, fontSize: 10, lineHeight: 1.45 }}>
                  The scheduled worker checks the configured local cutoff. SMS stays off unless Enabled is checked. Review worker health and unresolved delivery below; provider acceptance is not handset delivery.
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
