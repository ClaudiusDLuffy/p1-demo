"use client";
// @ts-nocheck

import { useState } from "react";
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
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordForm>({
    resolver: zodResolver(ChangePasswordSchema),
    defaultValues: {
      password: "",
      confirm: "",
    },
  });

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
    <Modal onClose={onClose} title="Change password" width={420}>
      <form onSubmit={handleSubmit(onSubmit)}>
        <div style={{ display: "grid", gap: 14 }}>
          <Field label="New password">
            <Input type="password" {...register("password")} />
            {errors.password && <span style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>{errors.password.message}</span>}
          </Field>
          <Field label="Confirm new password">
            <Input type="password" {...register("confirm")} />
            {errors.confirm && <span style={{ fontSize: 11, color: T.danger, marginTop: 4 }}>{errors.confirm.message}</span>}
          </Field>
        </div>
        {submitError && <div style={{ fontSize: 12, color: T.danger, marginTop: 14 }}>{submitError}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 22, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose} className="btn-soft">Cancel</button>
          <button type="submit" disabled={isSubmitting} className="btn-primary" style={{ opacity: isSubmitting ? 0.6 : 1 }}>{isSubmitting ? "Saving..." : "Save password"}</button>
        </div>
      </form>
    </Modal>
  );
}
