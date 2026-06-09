"use client";
// @ts-nocheck

import { useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { WorkReportSchema, WorkReportForm as WorkReportFormType } from "../../lib/schemas";
import { insertWorkReport } from "../../lib/db";
import { Modal } from "../../components/ui/Modal";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { Sel } from "../../components/ui/Sel";
import { TA } from "../../components/ui/TA";
import { T } from "../../lib/constants";

export default function WorkReportForm(props: any) {
  const { woId, woStore, technicianOnJob, onClose, onSuccess } = props;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<WorkReportFormType>({
    resolver: zodResolver(WorkReportSchema),
    defaultValues: {
      technicianName: technicianOnJob || "",
      arrivalTime: "",
      departureTime: "",
      workPerformed: "",
      partsUsed: [],
      resolutionCode: "",
      resolutionNotes: "",
    },
  });
  const { fields, append, remove } = useFieldArray({
    control,
    name: "partsUsed",
  });

  const onSubmit = async (data: WorkReportFormType) => {
    setSubmitError(null);
    const result = await insertWorkReport({
      workOrderId: woId,
      ...data,
      partsUsed: data.partsUsed || [],
    });
    if (!result.success) {
      const msg = result.error instanceof Error ? result.error.message : "Work report submit failed";
      setSubmitError(msg);
      return;
    }
    onSuccess();
  };

  return (
    <Modal onClose={onClose} title="Submit work report" width={560}>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>
          Work report for Store #{woStore || "-"} / {woId}
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          <Field label="Technician name">
            <Input {...register("technicianName")} placeholder="Technician name" />
          </Field>
          <div className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <Field label="Arrival time *">
              <Input type="datetime-local" {...register("arrivalTime")} />
              {errors.arrivalTime && <span style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>{errors.arrivalTime.message}</span>}
            </Field>
            <Field label="Departure time *">
              <Input type="datetime-local" {...register("departureTime")} />
              {errors.departureTime && <span style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>{errors.departureTime.message}</span>}
            </Field>
          </div>
          <Field label="Work performed *">
            <TA rows={4} {...register("workPerformed")} placeholder="Describe the completed work" />
            {errors.workPerformed && <span style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>{errors.workPerformed.message}</span>}
          </Field>
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle }}>Parts used</div>
              <button type="button" onClick={() => append({ name: "", partNumber: "", qty: 1 })} className="btn-soft" style={{ padding: "6px 10px", fontSize: 11 }}>+ Add part</button>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {fields.map((field, i) => (
                <div key={field.id} className="modal-form-row" style={{ display: "grid", gridTemplateColumns: "1fr 130px 90px auto", gap: 8 }}>
                  <Input {...register(`partsUsed.${i}.name` as const)} placeholder="Part name" />
                  <Input {...register(`partsUsed.${i}.partNumber` as const)} placeholder="Part #" />
                  <Input type="number" step="1" {...register(`partsUsed.${i}.qty` as const, { valueAsNumber: true })} placeholder="Qty" />
                  <button type="button" onClick={() => remove(i)} className="btn-soft" style={{ padding: "8px 10px", fontSize: 11 }}>Remove</button>
                </div>
              ))}
            </div>
          </div>
          <Field label="Resolution code">
            <Sel {...register("resolutionCode")}>
              <option value="">Select...</option>
              <option value="Repaired">Repaired</option>
              <option value="Parts Needed">Parts Needed</option>
              <option value="Replacement Recommended">Replacement Recommended</option>
              <option value="No Issue Found">No Issue Found</option>
            </Sel>
          </Field>
          <Field label="Resolution notes">
            <TA rows={3} {...register("resolutionNotes")} placeholder="Additional notes" />
          </Field>
        </div>
        {submitError && <div style={{ fontSize: 12, color: T.danger, marginTop: 14 }}>{submitError}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} className="btn-soft">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="btn-primary" style={{ opacity: isSubmitting ? 0.6 : 1 }}>{isSubmitting ? "Submitting..." : "Submit report"}</button>
        </div>
      </form>
    </Modal>
  );
}
