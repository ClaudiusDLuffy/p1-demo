"use client";
// @ts-nocheck

import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Modal } from "../../components/ui/Modal";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { TA } from "../../components/ui/TA";
import { T } from "../../lib/constants";

const CapitalFlagSchema = z.object({
  repairQuote: z.string().min(1, "Repair quote is required"),
  installQuote: z.string().min(1, "Install quote is required"),
  assetYear: z.string()
    .min(4, "Equipment year is required")
    .max(4, "Enter a 4 digit year"),
  capitalNotes: z.string().optional(),
});

export default function CapitalFlagModal(props: any) {
  const { woId, woStore, onClose, doCapitalFlag } = props;
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(CapitalFlagSchema),
    defaultValues: {
      repairQuote: "",
      installQuote: "",
      assetYear: "",
      capitalNotes: "",
    },
  });

  const onSubmit = async (data: any) => {
    await doCapitalFlag(woId, {
      repairQuote: Number(data.repairQuote),
      installQuote: Number(data.installQuote),
      assetYear: Number(data.assetYear),
      capitalNotes: data.capitalNotes || "",
    });
    onClose();
  };

  return (
    <Modal onClose={onClose} title="Flag capital replacement" width={480}>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div style={{ fontSize: 13, color: T.muted, marginBottom: 16 }}>
          Capital evaluation for Store #{woStore || "-"} / {woId}
        </div>
        <div style={{ display: "grid", gap: 14 }}>
          <Field label="Equipment year *">
            <Input type="number" {...register("assetYear")} placeholder="e.g. 2019" />
            {errors.assetYear && <span style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>{errors.assetYear.message}</span>}
          </Field>
          <Field label="Repair quote amount *">
            <Input type="number" step="0.01" {...register("repairQuote")} placeholder="e.g. 1500" />
            {errors.repairQuote && <span style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>{errors.repairQuote.message}</span>}
          </Field>
          <Field label="Installation quote amount *">
            <Input type="number" step="0.01" {...register("installQuote")} placeholder="e.g. 4200" />
            {errors.installQuote && <span style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>{errors.installQuote.message}</span>}
          </Field>
          <Field label="Capital notes / justification">
            <TA rows={4} {...register("capitalNotes")} placeholder="Reason for replacement recommendation" />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} className="btn-soft">Cancel</button>
          <button type="submit" className="btn-primary">Flag capital</button>
        </div>
      </form>
    </Modal>
  );
}
