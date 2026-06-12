"use client";
// @ts-nocheck

import { useState } from "react";
import dynamic from "next/dynamic";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { ChangePasswordSchema, ChangePasswordForm } from "../../lib/schemas";
import { changePassword } from "./useAuth";
import { Modal } from "../../components/ui/Modal";
import { Field } from "../../components/ui/Field";
import { Input } from "../../components/ui/Input";
import { T } from "../../lib/constants";

const ChangePasswordModal = dynamic(
  () => import("./ChangePasswordModal"),
  { ssr: false }
);

const roleLabel = (role: string) => ({
  manager: "Manager",
  dispatcher: "Dispatcher",
  back_office: "Back Office",
  contractor: "Contractor",
}[role] || role);

export default function ManageAccountModal(props: any) {
  const { currentUser, onClose, fire } = props;
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordForm>({
    resolver: zodResolver(ChangePasswordSchema),
    defaultValues: {
      password: "",
      confirm: "",
    },
  });

  const rows = [
    ["Name", currentUser.name],
    ["Email", currentUser.email],
    ["Company", currentUser.company || "—"],
    ["Role", roleLabel(currentUser.role)],
    ...(currentUser.territory ? [["Territory", currentUser.territory]] : []),
  ];

  const onSubmit = async (data: ChangePasswordForm) => {
    setSubmitError(null);
    const result = await changePassword(data.password);
    if (!result.success) {
      setSubmitError(result.error || "Password update failed");
      return;
    }
    fire("Password updated");
    reset();
    setShowPasswordForm(false);
  };

  return (
    <Modal onClose={onClose} title="Manage Account" width={440}>
      <div style={{ display: "grid", gap: 18 }}>
        <div style={{ border: `1px solid ${T.borderSoft}`, borderRadius: 10, background: T.surfaceSoft, overflow: "hidden" }}>
          {rows.map(([label, value], i) => (
            <div key={label} style={{ display: "grid", gridTemplateColumns: "120px 1fr", gap: 14, padding: "12px 14px", borderTop: i === 0 ? "none" : `1px solid ${T.borderSoft}`, alignItems: "center" }}>
              <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle }}>{label}</div>
              <div style={{ fontSize: 13, fontWeight: 500, color: T.ink, minWidth: 0, overflowWrap: "anywhere" }}>{value}</div>
            </div>
          ))}
        </div>

        <div>
          <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.8, color: T.subtle, marginBottom: 10 }}>Change password</div>
          {!showPasswordForm ? (
            <button onClick={() => setShowPasswordForm(true)} className="btn-soft" style={{ width: "100%" }}>
              Change Password
            </button>
          ) : (
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
              <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "center" }}>
                <button type="button" onClick={() => { reset(); setSubmitError(null); setShowPasswordForm(false); }} className="btn-soft">Cancel</button>
                <button type="submit" disabled={isSubmitting} className="btn-primary" style={{ opacity: isSubmitting ? 0.6 : 1 }}>{isSubmitting ? "Saving..." : "Save"}</button>
              </div>
            </form>
          )}
        </div>
      </div>
    </Modal>
  );
}
