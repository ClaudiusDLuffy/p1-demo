"use client";

import { Children, isValidElement, useEffect, useMemo, useRef, useState, forwardRef } from "react";
import { T } from "../../lib/constants";

const labelText = (value: any): string => {
  if (Array.isArray(value)) return value.map(labelText).join("");
  if (value == null || typeof value === "boolean") return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (isValidElement(value)) return labelText((value.props as any).children);
  return String(value);
};

export const Sel = forwardRef<HTMLInputElement, any>(function Sel(
  { children, value, defaultValue, onChange, onBlur, name, disabled, placeholder = "Select...", style, optionAlign = "left", valueAlign = "left", ...p },
  ref
) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const options = useMemo(() => Children.toArray(children)
    .filter(isValidElement)
    .map((child: any) => ({
      value: child.props.value ?? labelText(child.props.children),
      label: labelText(child.props.children),
      sub: child.props["data-sub"] ?? "",
      search: child.props["data-search"] ?? labelText(child.props.children),
      disabled: child.props.disabled,
    })), [children]);
  const firstValue = options[0]?.value ?? "";
  const [innerValue, setInnerValue] = useState(defaultValue ?? firstValue);
  const selectedValue = value ?? innerValue;
  const selected = options.find(o => String(o.value) === String(selectedValue));
  const searchable = options.length >= 10;
  const q = search.trim().toLowerCase();
  const visibleOptions = !searchable || !q
    ? options
    : options.filter(o => `${o.search} ${o.label} ${o.value}`.toLowerCase().includes(q));

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      listRef.current
        ?.querySelector<HTMLElement>('[data-active="true"]')
        ?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, selectedValue, visibleOptions]);

  const selectValue = (nextValue: any) => {
    setInnerValue(nextValue);
    onChange?.({
      target: { name, value: nextValue },
      currentTarget: { name, value: nextValue },
      type: "change",
    });
    setOpen(false);
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
      <input ref={ref} type="hidden" name={name} value={selectedValue ?? ""} readOnly />
      <button
        type="button"
        disabled={disabled}
        onBlur={onBlur}
        onClick={() => setOpen(v => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
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
          outline: "none",
          cursor: disabled ? "default" : "pointer",
          textAlign: valueAlign,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          opacity: disabled ? 0.6 : 1,
          overflow: "hidden",
          }}
          {...p}
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
        <span style={{
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
      {open && (
        <div
          ref={listRef}
          role="listbox"
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
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search..."
              autoFocus
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
                outline: "none",
              }}
            />
          )}
          {visibleOptions.map(option => {
            const active = String(option.value) === String(selectedValue);
            return (
              <button
                key={`${option.value}-${option.label}`}
                type="button"
                role="option"
                aria-selected={active}
                data-active={active ? "true" : undefined}
                disabled={option.disabled}
                onClick={() => !option.disabled && selectValue(option.value)}
                style={{
                  width: "100%",
                  minWidth: 0,
                  maxWidth: "100%",
                  minHeight: 38,
                  padding: "9px 10px",
                  borderRadius: 9,
                  border: "none",
                  background: active ? T.accentSoft : "transparent",
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
              </button>
            );
          })}
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
