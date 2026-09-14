"use client";

import { useEffect, useId, useRef, type CSSProperties, type ReactNode } from "react";
import { T } from "../../lib/constants";
import { FieldContext, type FieldAssociation } from "./fieldContext";
export { useFieldControl } from "./fieldContext";

export type FieldProps = {
  label: ReactNode;
  children?: ReactNode;
  id?: string;
  controlId?: string;
  htmlFor?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  group?: boolean;
  style?: CSSProperties;
};
export function Field({ label, children, id, controlId, htmlFor, hint, error, required = false, group = false, style }: FieldProps) {
  const generated = useId();
  const resolvedId = controlId || htmlFor || id || `field-${generated}`;
  const labelId = `${resolvedId}-label`;
  const descriptionId = hint ? `${resolvedId}-hint` : undefined;
  const errorId = error ? `${resolvedId}-error` : undefined;
  const wrapper = useRef<HTMLDivElement & HTMLFieldSetElement>(null);
  const association: FieldAssociation = { controlId: group ? undefined : resolvedId, labelId,
    descriptionId, errorId, required, invalid: Boolean(error), group };
  useEffect(() => {
    if (process.env.NODE_ENV === "production" || group || !wrapper.current) return;
    const targets = Array.from(wrapper.current.querySelectorAll<HTMLElement>("[id]"))
      .filter(element => element.id === resolvedId);
    if (targets.length !== 1) {
      console.warn("Field has no associated control. Supply controlId/htmlFor or use a Field-aware control; use group for multiple controls.");
    }
  }, [resolvedId, group]);
  const labelStyle: CSSProperties = { fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.8,
    color: T.subtle, marginBottom: 6, display: "block" };
  const showRequiredMarker = required && !(typeof label === "string" && label.includes("*"));
  const contents = <FieldContext.Provider value={association}>
    {group ? <legend id={labelId} style={labelStyle}>{label}{showRequiredMarker && <span aria-hidden="true"> *</span>}</legend>
      : <label id={labelId} htmlFor={resolvedId} style={labelStyle}>{label}{showRequiredMarker && <span aria-hidden="true"> *</span>}</label>}
    {hint && <div id={descriptionId} style={{ color: T.muted, fontSize: 12, marginBottom: 6 }}>{hint}</div>}
    {children}
    {error && <div id={errorId} role="alert" style={{ color: T.danger, fontSize: 12, marginTop: 5 }}>{error}</div>}
  </FieldContext.Provider>;
  return group ? <fieldset ref={wrapper} aria-describedby={[descriptionId, errorId].filter(Boolean).join(" ") || undefined}
    style={{ minWidth: 0, padding: 0, margin: 0, border: 0, ...style }}>{contents}</fieldset>
    : <div ref={wrapper} style={{ minWidth: 0, ...style }}>{contents}</div>;
}
