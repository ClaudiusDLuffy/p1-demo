"use client";

import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { T } from "../../lib/constants";
import {
  parseBillingTaxRuleList,
  type BillingTaxRule,
} from "../../lib/billingTaxRules";
import { supabase } from "../../lib/supabase/client";
import {
  BILLING_TAX_RULES_KEY,
  useBillingTaxRulesQuery,
} from "./queries";

type TaxRuleForm = {
  name: string;
  priority: string;
  equipmentKeywords: string;
  lineTypes: string;
  descriptionKeywords: string;
  taxable: boolean;
  active: boolean;
};

const emptyForm = (): TaxRuleForm => ({
  name: "",
  priority: "100",
  equipmentKeywords: "",
  lineTypes: "",
  descriptionKeywords: "",
  taxable: false,
  active: true,
});

const formFromRule = (rule: BillingTaxRule): TaxRuleForm => ({
  name: rule.name,
  priority: String(rule.priority),
  equipmentKeywords: rule.equipmentKeywords.join(", "),
  lineTypes: rule.lineTypes.join(", "),
  descriptionKeywords: rule.descriptionKeywords.join(", "),
  taxable: rule.taxable,
  active: rule.active,
});

const matchSummary = (rule: BillingTaxRule) => [
  rule.equipmentKeywords.length > 0
    ? `equipment: ${rule.equipmentKeywords.join(", ")}`
    : "",
  rule.lineTypes.length > 0
    ? `line type: ${rule.lineTypes.join(", ")}`
    : "",
  rule.descriptionKeywords.length > 0
    ? `description: ${rule.descriptionKeywords.join(", ")}`
    : "",
].filter(Boolean).join(" · ");

const ruleKeyForName = (name: string) => {
  const slug = name.toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48) || "rule";
  return `custom_${slug}_${Date.now().toString(36)}`;
};

export default function BillingTaxRulePanel({
  enabled,
  fire,
}: {
  enabled: boolean;
  fire?: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TaxRuleForm>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const qc = useQueryClient();
  const query = useBillingTaxRulesQuery(enabled);
  const rules = useMemo(() => query.data ?? [], [query.data]);
  const activeCount = useMemo(
    () => rules.filter(rule => rule.active).length,
    [rules],
  );

  const beginCreate = () => {
    setEditingId("new");
    setForm(emptyForm());
    setFormError("");
  };

  const beginEdit = (rule: BillingTaxRule) => {
    setEditingId(rule.id);
    setForm(formFromRule(rule));
    setFormError("");
  };

  const stopEditing = () => {
    setEditingId(null);
    setForm(emptyForm());
    setFormError("");
  };

  const save = async () => {
    const priority = Number(form.priority);
    const equipmentKeywords = parseBillingTaxRuleList(form.equipmentKeywords);
    const lineTypes = parseBillingTaxRuleList(form.lineTypes);
    const descriptionKeywords = parseBillingTaxRuleList(form.descriptionKeywords);
    if (!form.name.trim()) {
      setFormError("Enter a rule name.");
      return;
    }
    if (!Number.isInteger(priority) || priority < 0 || priority > 100000) {
      setFormError("Priority must be a whole number between 0 and 100,000.");
      return;
    }
    if (equipmentKeywords.length + lineTypes.length + descriptionKeywords.length === 0) {
      setFormError("Add at least one equipment, line-type, or description match.");
      return;
    }

    setSaving(true);
    setFormError("");
    try {
      const sb = supabase();
      const values = {
        name: form.name.trim(),
        priority,
        equipment_keywords: equipmentKeywords,
        line_types: lineTypes,
        description_keywords: descriptionKeywords,
        taxable: form.taxable,
        is_active: form.active,
      };
      const result = editingId === "new"
        ? await sb.from("billing_tax_rules").insert({
            ...values,
            rule_key: ruleKeyForName(form.name),
          })
        : await sb.from("billing_tax_rules").update(values).eq("id", editingId);
      if (result.error) throw result.error;
      await qc.invalidateQueries({ queryKey: BILLING_TAX_RULES_KEY });
      fire?.(editingId === "new" ? "Tax rule added" : "Tax rule updated");
      stopEditing();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "Tax rule could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const toggleRule = async (rule: BillingTaxRule) => {
    try {
      const { error } = await supabase()
        .from("billing_tax_rules")
        .update({ is_active: !rule.active })
        .eq("id", rule.id);
      if (error) throw error;
      await qc.invalidateQueries({ queryKey: BILLING_TAX_RULES_KEY });
      fire?.(`${rule.name} ${rule.active ? "disabled" : "enabled"}`);
    } catch (error) {
      fire?.(`Tax rule update failed: ${error instanceof Error ? error.message : error}`);
    }
  };

  if (!enabled) return null;

  return (
    <section className="card" aria-label="Billing tax rules" style={{ marginBottom: 14, overflow: "hidden" }}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls="billing-tax-rules-panel"
        onClick={() => setExpanded(value => !value)}
        style={{ width: "100%", border: 0, background: T.surface, padding: "13px 15px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, textAlign: "left", cursor: "pointer", fontFamily: "inherit" }}
      >
        <span>
          <span style={{ display: "block", color: T.ink, fontSize: 13, fontWeight: 800 }}>Automatic taxability rules</span>
          <span style={{ display: "block", marginTop: 3, color: T.subtle, fontSize: 10 }}>First matching active rule wins. Every change is audited.</span>
        </span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, color: T.accent, fontSize: 11, fontWeight: 750 }}>
          {activeCount} active <span aria-hidden="true">{expanded ? "▾" : "▸"}</span>
        </span>
      </button>

      {expanded && (
        <div id="billing-tax-rules-panel" style={{ borderTop: `1px solid ${T.borderSoft}`, padding: 14 }}>
          {query.isLoading && <div style={{ color: T.muted, fontSize: 11 }}>Loading tax rules…</div>}
          {query.isError && (
            <div role="alert" style={{ color: T.danger, background: T.dangerSoft, borderRadius: 8, padding: 10, fontSize: 11 }}>
              Tax rules could not be loaded. Confirm migration 0088 is applied.
            </div>
          )}

          {!query.isLoading && !query.isError && (
            <div style={{ display: "grid", gap: 8 }}>
              {rules.map(rule => (
                <div key={rule.id} style={{ display: "grid", gridTemplateColumns: "70px minmax(180px, 1fr) auto auto", gap: 10, alignItems: "center", padding: "10px 11px", border: `1px solid ${T.borderSoft}`, borderRadius: 9, opacity: rule.active ? 1 : 0.58 }}>
                  <span className="mono" style={{ color: T.subtle, fontSize: 10 }}>#{rule.priority}</span>
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", color: T.ink, fontSize: 11, fontWeight: 750 }}>{rule.name}</span>
                    <span style={{ display: "block", marginTop: 3, color: T.subtle, fontSize: 9, overflowWrap: "anywhere" }}>{matchSummary(rule)}</span>
                  </span>
                  <span style={{ padding: "4px 8px", borderRadius: 999, color: rule.taxable ? T.danger : T.success, background: rule.taxable ? T.dangerSoft : T.successSoft, fontSize: 9, fontWeight: 800 }}>
                    {rule.taxable ? "Taxable" : "Exempt"}
                  </span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button type="button" className="btn-soft" onClick={() => beginEdit(rule)} style={{ padding: "5px 8px", fontSize: 9 }}>Edit</button>
                    <button type="button" className="btn-soft" onClick={() => void toggleRule(rule)} style={{ padding: "5px 8px", fontSize: 9 }}>{rule.active ? "Disable" : "Enable"}</button>
                  </span>
                </div>
              ))}
              {rules.length === 0 && <div style={{ color: T.subtle, fontSize: 11 }}>No rules are configured.</div>}
            </div>
          )}

          {editingId ? (
            <div style={{ marginTop: 12, padding: 13, borderRadius: 10, border: `1px solid ${T.accentRing}`, background: T.surfaceSoft }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: T.ink, marginBottom: 10 }}>{editingId === "new" ? "Add tax rule" : "Edit tax rule"}</div>
              <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 1fr) 100px 120px", gap: 9, marginBottom: 9 }}>
                <label style={{ fontSize: 10, color: T.muted }}>Name<input value={form.name} onChange={event => setForm(value => ({ ...value, name: event.target.value }))} style={{ width: "100%", marginTop: 5, padding: 8, borderRadius: 7, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }} /></label>
                <label style={{ fontSize: 10, color: T.muted }}>Priority<input type="number" min="0" max="100000" value={form.priority} onChange={event => setForm(value => ({ ...value, priority: event.target.value }))} style={{ width: "100%", marginTop: 5, padding: 8, borderRadius: 7, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }} /></label>
                <label style={{ fontSize: 10, color: T.muted }}>Result<select value={form.taxable ? "taxable" : "exempt"} onChange={event => setForm(value => ({ ...value, taxable: event.target.value === "taxable" }))} style={{ width: "100%", marginTop: 5, padding: 8, borderRadius: 7, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }}><option value="exempt">Exempt</option><option value="taxable">Taxable</option></select></label>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 9 }}>
                <label style={{ fontSize: 10, color: T.muted }}>Equipment keywords<input value={form.equipmentKeywords} onChange={event => setForm(value => ({ ...value, equipmentKeywords: event.target.value }))} placeholder="vault, slurpee" style={{ width: "100%", marginTop: 5, padding: 8, borderRadius: 7, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }} /></label>
                <label style={{ fontSize: 10, color: T.muted }}>Line types<input value={form.lineTypes} onChange={event => setForm(value => ({ ...value, lineTypes: event.target.value }))} placeholder="labor, travel" style={{ width: "100%", marginTop: 5, padding: 8, borderRadius: 7, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }} /></label>
                <label style={{ fontSize: 10, color: T.muted }}>Description keywords<input value={form.descriptionKeywords} onChange={event => setForm(value => ({ ...value, descriptionKeywords: event.target.value }))} placeholder="compressor, refrigerant" style={{ width: "100%", marginTop: 5, padding: 8, borderRadius: 7, border: `1px solid ${T.border}`, background: T.surface, color: T.ink }} /></label>
              </div>
              <label style={{ display: "inline-flex", alignItems: "center", gap: 7, marginTop: 10, fontSize: 10, color: T.muted }}><input type="checkbox" checked={form.active} onChange={event => setForm(value => ({ ...value, active: event.target.checked }))} />Active</label>
              {formError && <div role="alert" style={{ marginTop: 9, color: T.danger, fontSize: 10 }}>{formError}</div>}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: 7, marginTop: 11 }}>
                <button type="button" className="btn-soft" disabled={saving} onClick={stopEditing}>Cancel</button>
                <button type="button" className="btn-primary" disabled={saving} onClick={() => void save()}>{saving ? "Saving…" : "Save rule"}</button>
              </div>
            </div>
          ) : (
            <button type="button" className="btn-soft" onClick={beginCreate} style={{ marginTop: 11 }}>+ Add rule</button>
          )}
        </div>
      )}
    </section>
  );
}
