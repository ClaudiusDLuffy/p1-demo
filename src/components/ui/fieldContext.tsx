"use client";

import { createContext, useContext, useId, type AriaAttributes } from "react";

export type FieldAssociation = {
  controlId?: string;
  labelId: string;
  descriptionId?: string;
  errorId?: string;
  required: boolean;
  invalid: boolean;
  group: boolean;
};
export const FieldContext = createContext<FieldAssociation | null>(null);
export type FieldControlProps = Pick<AriaAttributes, "aria-label" | "aria-labelledby" | "aria-describedby" | "aria-invalid" | "aria-required"> & {
  id?: string;
  required?: boolean;
};
export function mergeDescriptionIds(...values: (string | undefined)[]): string | undefined {
  const ids = Array.from(new Set(values.flatMap(value => value?.split(/\s+/).filter(Boolean) || [])));
  return ids.length ? ids.join(" ") : undefined;
}
export function useFieldControl(props: FieldControlProps = {}) {
  const field = useContext(FieldContext);
  const generatedId = useId();
  return {
    id: props.id || field?.controlId || `control-${generatedId}`,
    "aria-label": props["aria-label"],
    "aria-labelledby": props["aria-labelledby"] || (!props["aria-label"] && !field?.group ? field?.labelId : undefined),
    "aria-describedby": mergeDescriptionIds(props["aria-describedby"], field?.descriptionId, field?.errorId),
    "aria-invalid": props["aria-invalid"] ?? (field?.invalid || undefined),
    "aria-required": props["aria-required"] ?? (props.required || field?.required || undefined),
    required: props.required ?? field?.required ?? false,
  };
}
