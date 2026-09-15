"use client";

import { Children, isValidElement, useEffect, useId, useMemo, useRef, useState, forwardRef, useImperativeHandle,
  type ChangeEvent, type ChangeEventHandler, type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { T } from "../../lib/constants";
import { useFieldControl } from "./fieldContext";
import { MAX_SELECT_SEARCH, SELECT_TYPEAHEAD_MS, nextEnabledOption, typeaheadOption, type SelectOption } from "../../lib/forms/selectModel";
import { scrollWithinContainer } from "../../lib/forms/scrollWithinContainer";

const labelText = (value: ReactNode): string => {
  if (Array.isArray(value)) return value.map(labelText).join("");
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (isValidElement<{ children?: ReactNode }>(value)) return labelText(value.props.children);
  return "";
};

type OptionProps = { value?: string | number; children?: ReactNode; "data-sub"?: string; "data-search"?: string; disabled?: boolean };
export type SelProps = Omit<ComponentPropsWithoutRef<"button">, "value" | "defaultValue" | "onChange" | "onBlur" | "children"> & {
  value?: string | number | null;
  defaultValue?: string | number;
  children?: ReactNode;
  onChange?: ChangeEventHandler<HTMLSelectElement>;
  onBlur?: (event: { target: { name?: string; value: string }; type: "blur" }) => void;
  placeholder?: string;
  required?: boolean;
  optionAlign?: CSSProperties["textAlign"];
  valueAlign?: CSSProperties["textAlign"];
};
export const Sel = forwardRef<HTMLInputElement, SelProps>(function Sel(
  { children, value, defaultValue, onChange, onBlur, name, disabled, placeholder = "Select...", style, optionAlign = "left", valueAlign = "left", onKeyDown, ...p },
  ref
) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bridgedInput = useRef<HTMLInputElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const generated = useId();
  const listId = `${generated}-listbox`;
  const association = useFieldControl(p);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const typeahead = useRef({ text: "", at: 0 });
  const options = useMemo(() => Children.toArray(children)
    .filter((child): child is React.ReactElement<OptionProps> => isValidElement<OptionProps>(child))
    .map((child, index): SelectOption => ({
      value: String(child.props.value ?? labelText(child.props.children)),
      label: labelText(child.props.children),
      sub: child.props["data-sub"] ?? "",
      search: child.props["data-search"] ?? labelText(child.props.children),
      disabled: Boolean(child.props.disabled), index,
    })), [children]);
  const firstValue = options[0]?.value ?? "";
  const [innerValue, setInnerValue] = useState(String(defaultValue ?? firstValue));
  const controlled = value !== undefined && value !== null;
  const selectedValue = value ?? innerValue;
  const selected = options.find(o => String(o.value) === String(selectedValue));
  const searchable = options.length >= 10;
  const q = search.trim().toLowerCase();
  const visibleOptions = !searchable || !q
    ? options
    : options.filter(o => `${o.search} ${o.label} ${o.value}`.toLowerCase().includes(q));
  const activeOption = visibleOptions.find(option => option.index === activeIndex && !option.disabled);
  const optionId = (index: number) => `${generated}-option-${index}`;
  useImperativeHandle(ref, () => {
    const input = inputRef.current;
    if (!input) throw new Error("Selection form control is not mounted");
    // RHF retains its hidden input value/ref contract; focus routes to the
    // interactive trigger rather than an unfocusable successful form field.
    input.focus = options => triggerRef.current?.focus(options);
    if (!controlled && bridgedInput.current !== input) {
      // Registered uncontrolled fields are reset/setValue'd through their DOM
      // ref by RHF. Mirror that native write into the visible label as well.
      // Delegate to React/native's existing accessor rather than replacing its
      // value tracker. Install at most once per mounted input.
      const descriptor = Object.getOwnPropertyDescriptor(input, "value")
        || Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), "value");
      if (descriptor?.get && descriptor.set) {
        const read = descriptor.get;
        const write = descriptor.set;
        Object.defineProperty(input, "value", { configurable: true, enumerable: descriptor.enumerable,
          get: () => String(read.call(input)),
          set: (next: unknown) => { const text = String(next ?? ""); write.call(input, text); setInnerValue(text); },
        });
      }
      bridgedInput.current = input;
    }
    return input;
  }, [controlled]);

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    if (!open) return;
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [open]);

  useEffect(() => {
    if (open && searchable) searchRef.current?.focus({ preventScroll: true });
  }, [open, searchable]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const list = listRef.current;
      const option = list
        ?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
      scrollWithinContainer(list, option);
    });
    return () => cancelAnimationFrame(frame);
  }, [open, activeIndex]);

  const close = (restore = true) => { setOpen(false); setSearch(""); if (restore) triggerRef.current?.focus({ preventScroll: true }); };
  const selectValue = (nextValue: string) => {
    setInnerValue(nextValue);
    // Preserve the existing select-like onChange contract using a real native
    // select target; no untyped fabricated target or domain payload is retained.
    const target = document.createElement("select");
    const option = document.createElement("option"); option.value = nextValue; target.appendChild(option);
    target.name = name || ""; target.value = nextValue;
    const nativeEvent = new Event("change", { bubbles: true });
    let propagationStopped = false;
    const event: ChangeEvent<HTMLSelectElement> = { target, currentTarget: target, type: "change", nativeEvent,
      bubbles: true, cancelable: false, defaultPrevented: false, eventPhase: 0, isTrusted: false, timeStamp: nativeEvent.timeStamp,
      preventDefault: () => nativeEvent.preventDefault(), isDefaultPrevented: () => nativeEvent.defaultPrevented,
      stopPropagation: () => { propagationStopped = true; }, isPropagationStopped: () => propagationStopped, persist: () => undefined };
    onChange?.(event);
    close();
  };
  const openMenu = (direction: "first" | "last" = "first") => {
    if (disabled) return;
    setSearch("");
    setActiveIndex(selected && !selected.disabled ? selected.index : nextEnabledOption(options, -1, direction));
    setOpen(true);
  };
  const handleKey = (event: KeyboardEvent<HTMLButtonElement | HTMLInputElement>) => {
    if (disabled) return;
    if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === "Tab") { if (open) close(false); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      if (!open) { openMenu(event.key === "End" || event.key === "ArrowUp" ? "last" : "first"); return; }
      setActiveIndex(nextEnabledOption(visibleOptions, activeIndex, event.key === "ArrowDown" ? "next" : event.key === "ArrowUp" ? "previous" : event.key === "Home" ? "first" : "last"));
    } else if (event.key === "Enter" || (event.key === " " && event.currentTarget === triggerRef.current)) {
      event.preventDefault();
      if (!open) openMenu(); else if (activeOption) selectValue(activeOption.value);
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey && event.currentTarget === triggerRef.current) {
      event.preventDefault();
      const now = event.timeStamp;
      const text = (now - typeahead.current.at > SELECT_TYPEAHEAD_MS ? "" : typeahead.current.text) + event.key;
      typeahead.current = { text: text.slice(-MAX_SELECT_SEARCH), at: now };
      if (!open) setOpen(true);
      setActiveIndex(typeaheadOption(options, activeIndex, typeahead.current.text));
    }
  };

  return (
    <div
      ref={wrapRef}
      className="pretty-select"
      style={{
        position: "relative",
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
        overflow: "visible",
        boxSizing: "border-box",
        ...(style?.width ? { width: style.width } : null),
      }}
    >
      <style>{`
        .pretty-select-value,
        .pretty-select-option-value {
          min-width: 0;
          overflow: hidden;
        }
        .pretty-select-label,
        .pretty-select-option-label {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .pretty-select-sub,
        .pretty-select-option-sub {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          color: ${T.muted};
          font-weight: 500;
        }
        .pretty-select-value[data-align="center"],
        .pretty-select-option-value[data-align="center"] {
          justify-content: center;
          text-align: center;
        }
        .pretty-select-value[data-align="center"] .pretty-select-label,
        .pretty-select-option-value[data-align="center"] .pretty-select-option-label {
          text-align: center;
        }
        @media(min-width: 1201px) {
          .pretty-select-value,
          .pretty-select-option-value {
            display: flex;
            align-items: baseline;
            gap: 4px;
          }
          .pretty-select-sub::before,
          .pretty-select-option-sub::before {
            content: "- ";
          }
        }
        @media(max-width: 1200px) {
          .pretty-select-value,
          .pretty-select-option-value {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            gap: 2px;
          }
          .pretty-select-sub,
          .pretty-select-option-sub {
            display: block;
            max-width: 100%;
            font-size: 11px;
            line-height: 1.25;
          }
          .pretty-select-value[data-align="center"],
          .pretty-select-option-value[data-align="center"] {
            align-items: center;
          }
        }
      `}</style>
      <input ref={inputRef} type="hidden" name={name} value={selectedValue ?? ""} disabled={disabled} readOnly />
      <button
        {...p}
        {...association}
        ref={triggerRef}
        type="button"
        role={!searchable ? "combobox" : undefined}
        disabled={disabled}
        onBlur={() => onBlur?.({ target: { name, value: String(selectedValue ?? "") }, type: "blur" })}
        onClick={() => open ? close() : openMenu()}
        onKeyDown={event => { onKeyDown?.(event); if (!event.defaultPrevented) handleKey(event); }}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && !searchable && activeOption ? optionId(activeOption.index) : undefined}
        style={{
          width: "100%",
          minWidth: 0,
          maxWidth: "100%",
          minHeight: style?.minHeight ?? 42,
          padding: style?.padding ?? "10px 38px 10px 13px",
          borderRadius: style?.borderRadius ?? 10,
          border: style?.border ?? `1px solid ${T.border}`,
          background: style?.background ?? T.surface,
          color: style?.color ?? T.ink,
          fontSize: style?.fontSize ?? 13,
          fontFamily: style?.fontFamily ?? "inherit",
          boxSizing: "border-box",
          cursor: disabled ? "default" : "pointer",
          textAlign: valueAlign,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          opacity: disabled ? 0.6 : 1,
          overflow: "hidden",
          }}
      >
        {valueAlign === "center" && <span aria-hidden="true" style={{ width: 18, flexShrink: 0 }} />}
        <span
          className="pretty-select-value"
          data-align={valueAlign}
          style={{
            flex: 1,
            display: "flex",
            justifyContent: valueAlign === "center" ? "center" : "flex-start",
            textAlign: valueAlign,
            minWidth: 0,
          }}
        >
          <span className="pretty-select-label" style={{ flex: 1, textAlign: valueAlign }}>{selected?.label || placeholder}</span>
          {selected?.sub ? <span className="pretty-select-sub">{selected.sub}</span> : null}
        </span>
        <span aria-hidden="true" style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          background: open ? T.accentSoft : T.bgWarm,
          color: open ? T.accent : T.muted,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          fontSize: 11,
          transform: open ? "rotate(180deg)" : "rotate(0deg)",
          transition: "transform 140ms ease",
        }}>
          v
        </span>
      </button>
      {open && !disabled && (
        <div
          ref={listRef}
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: 0,
            right: 0,
            minWidth: 0,
            maxWidth: "100%",
            boxSizing: "border-box",
            zIndex: 90,
            background: T.surface,
            border: `1px solid ${T.border}`,
            borderRadius: 12,
            boxShadow: "0 14px 34px rgba(31,30,28,0.14)",
            padding: 6,
            maxHeight: 260,
            overflowY: "auto",
            overflowX: "hidden",
            scrollbarGutter: "stable both-edges",
          }}
        >
          {searchable && (
            <input
              ref={searchRef}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={true}
              aria-controls={listId}
              aria-activedescendant={activeOption ? optionId(activeOption.index) : undefined}
              aria-label={p["aria-label"] ? `Search ${p["aria-label"]}` : association["aria-labelledby"] ? undefined : "Search choices"}
              aria-labelledby={!p["aria-label"] ? association["aria-labelledby"] : undefined}
              value={search}
              maxLength={MAX_SELECT_SEARCH}
              onKeyDown={handleKey}
              onChange={e => {
                const text = e.target.value.slice(0, MAX_SELECT_SEARCH); setSearch(text);
                setActiveIndex(nextEnabledOption(options.filter(option => `${option.search} ${option.label} ${option.value}`.toLowerCase().includes(text.trim().toLowerCase())), -1, "first"));
              }}
              placeholder="Search..."
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "10px 11px",
                marginBottom: 6,
                borderRadius: 9,
                border: `1px solid ${T.borderSoft}`,
                background: T.surfaceSoft,
                color: T.ink,
                fontSize: 13,
                fontFamily: "inherit",
              }}
            />
          )}
          <div id={listId} role="listbox" aria-labelledby={association["aria-labelledby"] || association.id}>
          {visibleOptions.map(option => {
            const active = String(option.value) === String(selectedValue);
            return (
              <div
                key={option.index}
                id={optionId(option.index)}
                role="option"
                aria-selected={active}
                aria-disabled={option.disabled || undefined}
                data-option-index={option.index}
                data-active={active ? "true" : undefined}
                onPointerDown={event => event.preventDefault()}
                onPointerMove={() => { if (!option.disabled) setActiveIndex(option.index); }}
                onClick={() => !option.disabled && selectValue(option.value)}
                style={{
                  width: "100%",
                  minWidth: 0,
                  maxWidth: "100%",
                  minHeight: 38,
                  padding: "9px 10px",
                  borderRadius: 9,
                  border: "none",
                  background: active || activeIndex === option.index ? T.accentSoft : "transparent",
                  color: option.disabled ? T.subtle : active ? T.accent : T.ink,
                  cursor: option.disabled ? "default" : "pointer",
                  fontSize: 13,
                  fontFamily: "inherit",
                  fontWeight: active ? 700 : 500,
                  textAlign: optionAlign,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: optionAlign === "center" ? "center" : "space-between",
                  gap: 10,
                  opacity: option.disabled ? 0.6 : 1,
                  overflow: "hidden",
                  boxSizing: "border-box",
                }}
              >
                <span
                  className="pretty-select-option-value"
                  data-align={optionAlign}
                  style={{
                    flex: 1,
                    display: "flex",
                    justifyContent: optionAlign === "center" ? "center" : "flex-start",
                    textAlign: optionAlign,
                    minWidth: 0,
                  }}
                >
                  <span className="pretty-select-option-label" style={{ textAlign: optionAlign }}>{option.label}</span>
                  {option.sub ? <span className="pretty-select-option-sub">{option.sub}</span> : null}
                </span>
                {active && optionAlign !== "center" && <span style={{ color: T.accent, fontSize: 12, flexShrink: 0 }}>Selected</span>}
              </div>
            );
          })}
          </div>
          {visibleOptions.length === 0 && (
            <div style={{ padding: "14px 10px", color: T.subtle, fontSize: 12, textAlign: "center" }}>
              No options found
            </div>
          )}
        </div>
      )}
    </div>
  );
});
