"use client";

import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState, type CSSProperties } from "react";
import { T } from "../../lib/constants";
import { directoryItemValue, type DirectoryDomain, type DirectoryItem } from "./contracts";
import { useDirectoryPage, useDirectorySelection } from "./queries";
import { useFieldControl, type FieldControlProps } from "../../components/ui/fieldContext";

export function DirectoryPageControls({ directory }: { directory: ReturnType<typeof useDirectoryPage> }) {
  return <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 10 }}>
    <span role="status" style={{ color: T.muted, fontSize: 11 }}>
      {directory.waiting ? "Loading…" : `Page ${directory.position.page}`}
    </span>
    <span style={{ display: "flex", gap: 6 }}>
      <button type="button" className="btn-soft" disabled={directory.position.page <= 1 || directory.waiting} onClick={directory.previous}>Previous</button>
      <button type="button" className="btn-soft" disabled={!directory.data?.hasMore || directory.waiting || directory.isError} onClick={directory.next}>Next</button>
    </span>
  </div>;
}
export function DirectoryError({ directory }: { directory: { isError: boolean; error?: unknown; reset?: () => void; refetch: () => unknown } }) {
  const invalidCursor = (directory.error as { code?: string } | null)?.code === "INVALID_CURSOR";
  const invalidInput = (directory.error as { code?: string } | null)?.code === "INVALID_REQUEST";
  return directory.isError ? <div role="alert" style={{ color: T.danger, fontSize: 12, padding: 8 }}>
    {invalidInput ? "Use up to 200 characters, without control characters." : invalidCursor ? "This directory page expired." : "Directory could not be loaded."} {!invalidInput && <button type="button" className="btn-soft" onClick={() => { if (invalidCursor && directory.reset) directory.reset(); else void directory.refetch(); }}>{invalidCursor ? "Start again" : "Retry"}</button>}
  </div> : null;
}
type ChangeEvent = { target: { name?: string; value: string }; currentTarget: { name?: string; value: string }; type: "change" };
type Props = FieldControlProps & {
  domain: DirectoryDomain;
  contractorId?: string | null;
  value?: string;
  defaultValue?: string;
  name?: string;
  onChange?: (event: ChangeEvent, item: DirectoryItem | null) => void;
  onBlur?: (event: { target: { name?: string; value: string }; type: "blur" }) => void;
  emptyLabel?: string;
  emptyValue?: string;
  selectedLabel?: string;
  disabled?: boolean;
  excludedIds?: string[];
  technicianValues?: boolean;
  companyLabel?: boolean;
  style?: CSSProperties;
  "aria-label"?: string;
};
export const DirectorySelect = forwardRef<HTMLInputElement, Props>(function DirectorySelect({
  domain, contractorId = null, value, defaultValue = "", name, onChange, onBlur,
  emptyLabel = "Choose…", emptyValue = "", selectedLabel, disabled = false,
  excludedIds = [], technicianValues = false, companyLabel = false, style, "aria-label": ariaLabel, ...fieldProps
}, ref) {
  const [open, setOpen] = useState(false);
  const [internalValue, setInternalValue] = useState(defaultValue);
  const selectedValue = value ?? internalValue;
  const wrapper = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const formInput = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => {
    const input = formInput.current;
    if (!input) throw new Error("Directory form control is not mounted");
    input.focus = options => trigger.current?.focus(options);
    return input;
  }, []);
  const association = useFieldControl({ ...fieldProps, "aria-label": ariaLabel });
  const listId = useId();
  const directory = useDirectoryPage(domain, open && !disabled, contractorId);
  const legacy = technicianValues && selectedValue.startsWith("legacy:");
  const selection = useDirectorySelection(technicianValues && !legacy ? "technician_profile" : domain,
    selectedValue === emptyValue ? null : legacy ? selectedValue.slice(7) : selectedValue, contractorId);
  const historicalLabel = useDirectorySelection("profile_labels", selectedValue, null,
    !technicianValues && domain !== "company_technicians" && domain !== "technician_management" && selection.isSuccess && !selection.data);
  const selected = selection.data || directory.items.find(item => directoryItemValue(item, technicianValues) === selectedValue) || historicalLabel.data;
  const label = (item: DirectoryItem) => companyLabel ? item.company || item.name : item.name;
  const caption = selected ? label(selected) : selectedLabel
    || (selectedValue === emptyValue || !selectedValue ? emptyLabel : selection.isFetching ? "Loading selection…" : "Selected record unavailable");
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => { if (!wrapper.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  const choose = (nextValue: string, item: DirectoryItem | null) => {
    setInternalValue(nextValue);
    onChange?.({ target: { name, value: nextValue }, currentTarget: { name, value: nextValue }, type: "change" }, item);
    setOpen(false);
    directory.setSearch("");
    trigger.current?.focus({ preventScroll: true });
  };
  return <div ref={wrapper} style={{ position: "relative", width: style?.width || "100%", minWidth: 0 }}
    onKeyDown={event => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); return; }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if (!open) { if (event.key.startsWith("Arrow")) { event.preventDefault(); setOpen(true); } return; }
      if (event.target instanceof HTMLInputElement && ["Home", "End"].includes(event.key)) return;
      const choices = Array.from(wrapper.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') || []);
      if (!choices.length) return;
      event.preventDefault();
      const index = choices.indexOf(document.activeElement as HTMLButtonElement);
      const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1
        : event.key === "ArrowDown" ? Math.min(index + 1, choices.length - 1) : Math.max(index - 1, 0);
      choices[nextIndex]?.focus();
    }}>
    <input ref={formInput} type="hidden" name={name} value={selectedValue} disabled={disabled} readOnly />
    <button {...association} ref={trigger} type="button" aria-label={ariaLabel} aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
      onBlur={() => onBlur?.({ target: { name, value: selectedValue }, type: "blur" })} disabled={disabled} onClick={() => setOpen(current => !current)}
      style={{ width: "100%", minHeight: 40, padding: "9px 12px", borderRadius: 9, border: `1px solid ${T.border}`,
        background: T.surface, color: T.ink, fontFamily: "inherit", textAlign: "left", ...style }}>
      {caption} <span aria-hidden="true" style={{ float: "right" }}>▾</span>
    </button>
    {open && !disabled && <div style={{ position: "absolute", top: "calc(100% + 5px)", left: 0, right: 0, minWidth: 230,
      zIndex: 95, border: `1px solid ${T.border}`, borderRadius: 10, padding: 8, background: T.surface,
      boxShadow: "0 12px 28px #0002" }}>
      <input type="search" maxLength={200} value={directory.search} onChange={event => directory.setSearch(event.target.value)}
        aria-label={`Search ${ariaLabel || "directory"}`} placeholder="Search name or company…" autoFocus
        style={{ width: "100%", boxSizing: "border-box", minHeight: 38, padding: 8, marginBottom: 6,
          border: `1px solid ${T.border}`, borderRadius: 8 }} />
      <div role="listbox" id={listId} aria-label={ariaLabel || "Directory choices"} style={{ maxHeight: 240, overflowY: "auto" }}>
        <button type="button" role="option" aria-selected={selectedValue === emptyValue} onClick={() => choose(emptyValue, null)}
          style={{ display: "block", width: "100%", padding: 10, border: 0, textAlign: "left", background: T.surfaceSoft }}>{emptyLabel}</button>
        {directory.items.map(item => {
          const itemValue = directoryItemValue(item, technicianValues);
          return <button type="button" role="option" key={item.id} aria-selected={selectedValue === itemValue}
            disabled={excludedIds.includes(item.id)} onClick={() => choose(itemValue, item)}
            style={{ display: "block", width: "100%", padding: 10, border: 0, textAlign: "left", cursor: "pointer",
              color: T.ink, background: selectedValue === itemValue ? T.accentSoft : T.surface }}>
            {label(item)}{technicianValues && !item.profileId ? " — record only (no portal login)" : ""}
            {!companyLabel && item.company && <small style={{ display: "block", color: T.muted }}>{item.company}</small>}
          </button>;
        })}
        {!directory.waiting && !directory.isError && directory.items.length === 0 && <p role="status">No matching choices.</p>}
      </div>
      <DirectoryError directory={directory} />
      <DirectoryPageControls directory={directory} />
    </div>}
  </div>;
});
