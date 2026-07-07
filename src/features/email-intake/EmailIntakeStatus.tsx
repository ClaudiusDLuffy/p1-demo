"use client";

import { useEffect, useState } from "react";
import { supabase } from "../../lib/supabase/client";
import { T } from "../../lib/constants";

type LogRow = {
  id: string;
  subject: string | null;
  action: "created" | "updated" | "skipped" | "failed" | string;
  work_order_id: string | null;
  parse_confidence: "high" | "medium" | "low" | string | null;
  contractor_assigned: string | null;
  processed_at: string | null;
};

const actionColor = (action: string) => {
  if (action === "created") return { bg: "#e8f5ee", color: "#137a45" };
  if (action === "updated") return { bg: "#e8f0fb", color: "#1d5f9f" };
  if (action === "failed") return { bg: "#fbe9e8", color: "#a83226" };
  return { bg: "#f0efec", color: T.muted };
};

const confidenceColor = (confidence: string | null) => {
  if (confidence === "high") return "#137a45";
  if (confidence === "medium") return "#a66b00";
  if (confidence === "low") return "#a83226";
  return T.muted;
};

export default function EmailIntakeStatus() {
  const [rows, setRows] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const loadRows = async () => {
    setLoading(true);
    const { data, error } = await (supabase() as any)
      .from("email_intake_log")
      .select("id,subject,action,work_order_id,parse_confidence,contractor_assigned,processed_at")
      .order("processed_at", { ascending: false })
      .limit(20);

    if (!error) setRows(data || []);
    setLoading(false);
  };

  useEffect(() => {
    loadRows();
  }, []);

  const runNow = async () => {
    setRunning(true);
    setMessage(null);
    try {
      const res = await fetch("/api/email-intake", { method: "POST" });
      const data = await res.json();
      setMessage(data.message || (data.success ? `Processed ${data.processed} emails` : data.error || "Intake failed"));
      await loadRows();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Intake failed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <section style={{ background: T.surface, border: `1px solid ${T.borderSoft}`, borderRadius: 12, padding: 18 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18, color: T.ink }}>Email intake</h2>
          <p style={{ margin: "4px 0 0", fontSize: 12, color: T.muted }}>Recent 7-Eleven dispatch email processing.</p>
        </div>
        <button className="btn-primary" onClick={runNow} disabled={running}>
          {running ? "Running..." : "Run intake now"}
        </button>
      </div>
      {message && <div style={{ fontSize: 12, color: T.muted, marginBottom: 10 }}>{message}</div>}
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: T.subtle, textAlign: "left" }}>
              <th style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}` }}>Time</th>
              <th style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}` }}>Subject</th>
              <th style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}` }}>Action</th>
              <th style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}` }}>WO Created</th>
              <th style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}` }}>Confidence</th>
              <th style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}` }}>Contractor</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={6} style={{ padding: 18, color: T.muted }}>Loading intake log...</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={6} style={{ padding: 18, color: T.muted }}>No intake activity yet.</td></tr>
            )}
            {rows.map(row => {
              const action = actionColor(row.action);
              return (
                <tr key={row.id}>
                  <td style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}`, color: T.muted }}>
                    {row.processed_at ? new Date(row.processed_at).toLocaleString() : "-"}
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}`, color: T.ink }}>
                    {row.subject || "-"}
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}` }}>
                    <span style={{ background: action.bg, color: action.color, borderRadius: 999, padding: "3px 8px", fontWeight: 700 }}>
                      {row.action}
                    </span>
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}`, color: T.ink }}>{row.work_order_id || "-"}</td>
                  <td style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}`, color: confidenceColor(row.parse_confidence), fontWeight: 700 }}>
                    {row.parse_confidence || "-"}
                  </td>
                  <td style={{ padding: "10px 8px", borderBottom: `1px solid ${T.borderSoft}`, color: T.muted }}>{row.contractor_assigned || "-"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
