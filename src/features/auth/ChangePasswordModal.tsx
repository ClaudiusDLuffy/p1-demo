"use client";
// @ts-nocheck

import { useState } from "react";
import { useUnsavedChangesGuard } from "../../lib/forms/useUnsavedChangesGuard";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChangePasswordSchema, ChangePasswordForm } from "../../lib/schemas";
import { changePassword } from "./useAuth";
import { Modal } from "../../components/ui/Modal";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { T } from "../../lib/constants";

export default function ChangePasswordModal(props: any) {
  const { onClose, fire } = props;
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<ChangePasswordForm>({
    resolver: zodResolver(ChangePasswordSchema),
    defaultValues: {
      password: "",
      confirm: "",
    },
  });
  const dismissal = useUnsavedChangesGuard({ dirty: isDirty, busy: isSubmitting, onClose });

  const onSubmit = async (data: ChangePasswordForm) => {
    setSubmitError(null);
    const result = await changePassword(data.password);
    if (!result.success) {
      setSubmitError(result.error || "Password update failed");
      return;
    }
    fire("Password updated");
    onClose();
  };

  return (
    <Modal onRequestClose={dismissal.requestClose} dismissDisabled={isSubmitting} title="Change password" width={420}>
      {dismissal.dialog}
      <form onSubmit={handleSubmit(onSubmit)}>
        <div style={{ display: "grid", gap: 14 }}>
          <Field label="New password" required error={errors.password?.message}>
            <Input type="password" {...register("password")} />
          </Field>
          <Field label="Confirm new password" required error={errors.confirm?.message}>
            <Input type="password" {...register("confirm")} />
          </Field>
        </div>
        {submitError && <div style={{ fontSize: 12, color: T.danger, marginTop: 14 }}>{submitError}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
          <button type="button" disabled={isSubmitting} onClick={() => dismissal.requestClose("cancel_button")} className="btn-soft">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="btn-primary" style={{ opacity: isSubmitting ? 0.6 : 1 }}>{isSubmitting ? "Saving..." : "Save password"}</button>
        </div>
      </form>
    </Modal>
  );
}
