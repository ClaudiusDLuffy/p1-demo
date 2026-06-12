"use client";
// @ts-nocheck

import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CreateWorkOrderSchema, CreateWorkOrderForm } from "../../lib/schemas";
import { Modal } from "../../components/ui/Modal";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { Sel } from "../../components/ui/Sel";
import { TA } from "../../components/ui/TA";
import { BtnSpinner } from "../../components/ui/BtnSpinner";
import { T, PRIORITY } from "../../lib/constants";

export default function WorkOrderCreateForm(props: any) {
  const {
    onClose, doCreateWO, contractorsOnly,
    setSelectedWO, setPage, setAiNote, isManager,
  } = props;
  const [createErr, setCreateErr] = useState<{ msg: string; openWoId?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateWorkOrderForm>({
    resolver: zodResolver(CreateWorkOrderSchema),
    defaultValues: {
      wot: "", incidentId: "", store: "", city: "", addr: "",
      afm: "", afmEmail: "", lineOfService: "", businessService: "",
      category: "", subCategory: "", priority: "", nte: "",
      assign: "", summary: "", description: "",
    } as any,
  });

  const onSubmit = async (data: CreateWorkOrderForm) => {
    setSubmitting(true);
    try {
    setCreateErr(null);
    const result = await doCreateWO(data);
    if (result === true || result?.ok) {
      reset();
      onClose();
      return;
    }
    if (result?.error) setCreateErr(result.error);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal onClose={onClose} title="Create Work Order" width={520}>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div style={{ fontSize: 12, color: T.muted, marginBottom: 14, lineHeight: 1.5 }}>
          Only the WOT number is required - fill in what you have; the rest takes sensible defaults.
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="WOT Number *">
              <Input {...register("wot")} placeholder="e.g. FWKD11400123" />
              {errors.wot && (
                <span style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>
                  {errors.wot.message}
                </span>
              )}
            </Field>
            <Field label="Incident ID"><Input {...register("incidentId")} placeholder="e.g. INC24890517" /></Field>
          </div>
          <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Store Number"><Input {...register("store")} placeholder="e.g. 33321" /></Field>
            <Field label="City, State"><Input {...register("city")} placeholder="e.g. Dallas, TX" /></Field>
          </div>
          <Field label="Store Address"><Input {...register("addr")} placeholder="street address" /></Field>
          <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="AFM Name"><Input {...register("afm")} placeholder="" /></Field>
            <Field label="AFM Email">
              <Input {...register("afmEmail")} placeholder="" />
              {errors.afmEmail && (
                <span style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>
                  {errors.afmEmail.message}
                </span>
              )}
            </Field>
          </div>
          <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Line of Service"><Input {...register("lineOfService")} placeholder="" /></Field>
            <Field label="Business Service"><Sel {...register("businessService")}>
              <option value="">Not set</option>
              {["Refrigeration equipment", "Frozen Beverage - Equipment", "Cold Beverage - Equipment", "HVAC", "EMS", "Plumbing", "Hot food", "Ice merchandiser", "Walk-in cooler/freezer", "Septic/Grease"].map(c => <option key={c}>{c}</option>)}
            </Sel></Field>
          </div>
          <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Category"><Input {...register("category")} placeholder="" /></Field>
            <Field label="Sub Category"><Input {...register("subCategory")} placeholder="" /></Field>
          </div>
          <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Priority"><Sel {...register("priority", { setValueAs: v => v === "" ? undefined : v })}>
              <option value="">P4 Minor (default)</option>
              {Object.entries(PRIORITY).map(([k, v]: any) => <option key={k} value={k}>{v.label}</option>)}
            </Sel></Field>
            <Field label="NTE ($)"><Input type="number" {...register("nte")} placeholder="" /></Field>
          </div>
          <Field label="Assign to contractor"><Sel {...register("assign")}>
            <option value="">Leave unassigned</option>
            {contractorsOnly.map(u => <option key={u.id} value={u.id} data-sub={u.company || ""} data-search={`${u.name || ""} ${u.company || ""}`}>{u.name}</option>)}
          </Sel></Field>
          <Field label="Short Description"><Input {...register("summary")} placeholder="one-line summary" /></Field>
          <Field label="Description"><TA rows={3} {...register("description")} placeholder="full description" /></Field>
        </div>
        {createErr && (
          <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 10, background: T.dangerSoft, border: `1px solid ${T.danger}44`, color: T.danger, fontSize: 12, fontWeight: 600, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
            <span>{createErr.msg}</span>
            {createErr.openWoId && (
              <button
                type="button"
                onClick={() => { const id = createErr.openWoId!; onClose(); reset(); setSelectedWO(id); setAiNote(null); setPage(isManager ? "work_orders" : "wo_detail"); }}
                style={{ background: T.danger, color: "#fff", border: "none", borderRadius: 8, padding: "5px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}
              >Open {createErr.openWoId}</button>
            )}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} className="btn-soft">Cancel</button>
          <button
            type="submit"
            disabled={submitting}
            className="btn-primary"
            style={{
              opacity: submitting ? 0.7 : 1,
              cursor: submitting ? "default" : "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {submitting
              ? <><BtnSpinner />Creating...</>
              : "Create"
            }
          </button>
        </div>
      </form>
    </Modal>
  );
}
