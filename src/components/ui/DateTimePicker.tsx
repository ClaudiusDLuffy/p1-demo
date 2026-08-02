"use client";

import { type ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { DayPicker } from "react-day-picker";
import { format, parseISO } from "date-fns";
import "react-day-picker/style.css";
import { T } from "../../lib/constants";
import { getFloatingPanelPosition, type FloatingPanelPosition } from "../../lib/floatingPanel";
import { Sel } from "./Sel";

const pad = (n: number) => String(n).padStart(2, "0");
const toDateValue = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const parseDateValue = (value?: string) => {
  if (!value) return undefined;
  try {
    const parsed = parseISO(`${value}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed;
  } catch {
    return undefined;
  }
};

const formatTimeLabel = (value?: string) => {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return "";
  const [hour, minute] = value.split(":").map(Number);
  const hour12 = hour % 12 || 12;
  const suffix = hour >= 12 ? "PM" : "AM";
  return `${hour12}:${pad(minute)} ${suffix}`;
};

const timeParts = (value?: string) => {
  const valid = value && /^\d{2}:\d{2}$/.test(value) ? value : "12:00";
  const [hour24, minute] = valid.split(":").map(Number);
  return {
    hour12: hour24 % 12 || 12,
    minute,
    period: hour24 >= 12 ? "PM" : "AM",
  };
};

const toTimeValue = (hour12: number, minute: number, period: string) => {
  const hour24 = period === "PM"
    ? (hour12 === 12 ? 12 : hour12 + 12)
    : (hour12 === 12 ? 0 : hour12);
  return `${pad(hour24)}:${pad(minute)}`;
};

const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const yearOptions = Array.from({ length: 41 }, (_, i) => new Date().getFullYear() - 20 + i);

type DatePickerFieldProps = {
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  placement?: "bottom" | "top" | "right";
  mobileYOffset?: number;
  desktopYOffset?: number;
  avoidDesktopBottomCut?: boolean;
};

type TimePickerFieldProps = {
  value?: string;
  onChange: (value: string) => void;
  placeholder?: string;
};

const pickerCss = `
.p1-picker-popover {
  position: fixed;
  z-index: 220;
  max-width: calc(100vw - 32px);
  max-height: calc(100vh - 32px);
  box-sizing: border-box;
}
.p1-date-picker .rdp-root {
  --rdp-accent-color: ${T.accent};
  --rdp-accent-background-color: ${T.accentSoft};
  --rdp-day_button-border-radius: 10px;
  --rdp-selected-border: 0;
  margin: 0;
}
.p1-date-picker .rdp-months {
  max-width: 100%;
}
.p1-date-picker .rdp-month_caption {
  font-size: 14px;
  font-weight: 700;
  color: ${T.ink};
  padding: 0 0 8px;
}
.p1-date-picker .rdp-button_previous,
.p1-date-picker .rdp-button_next {
  width: 34px;
  height: 34px;
  border-radius: 10px;
  border: 1px solid ${T.borderSoft};
  color: ${T.ink};
}
.p1-date-picker .rdp-weekday {
  color: ${T.subtle};
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
.p1-date-picker .rdp-day_button {
  width: 36px;
  height: 34px;
  font-size: 12px;
  color: ${T.ink};
  display: flex;
  align-items: center;
  justify-content: center;
}
.p1-date-picker .rdp-selected .rdp-day_button {
  background: ${T.accent};
  color: #fff;
  font-weight: 700;
}
@media(max-width: 360px) {
  .p1-date-picker .rdp-day_button {
    width: 32px;
    height: 32px;
  }
}
`;

export function DatePickerField({ value, onChange, placeholder = "Select date", placement = "bottom", mobileYOffset = 0, desktopYOffset = 0 }: DatePickerFieldProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<FloatingPanelPosition | null>(null);
  const selected = parseDateValue(value);
  const [month, setMonth] = useState<Date>(selected || new Date());

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      const isMobile = window.innerWidth <= 768;
      setPos(getFloatingPanelPosition({
        trigger: rect,
        panelWidth: 318,
        panelHeight: 430,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        preferredPlacement: isMobile ? "bottom" : placement,
        offsetY: isMobile ? mobileYOffset : placement === "right" ? desktopYOffset : 0,
      }));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, placement, mobileYOffset, desktopYOffset]);

  return (
    <div ref={ref} style={{ position: "relative", width: "100%", minWidth: 0 }}>
      <style>{pickerCss}</style>
      <button
        type="button"
        onClick={() => {
          if (!open && selected) setMonth(selected);
          setOpen(current => !current);
        }}
        style={{
          width: "100%",
          minHeight: 44,
          padding: "10px 13px",
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: T.surface,
          color: value ? T.ink : T.subtle,
          fontSize: 13,
          fontFamily: "inherit",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          cursor: "pointer",
          boxSizing: "border-box",
          textAlign: "left",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected ? format(selected, "MMM d, yyyy") : placeholder}
        </span>
        <span style={{ color: T.accent, fontSize: 15 }}>Cal</span>
      </button>
      {open && pos && createPortal(
        <div
          className="p1-picker-popover p1-date-picker"
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            width: pos.width,
            left: pos.left,
            top: pos.top,
            maxHeight: pos.maxHeight,
            overflowY: "auto",
            overscrollBehavior: "contain",
            padding: 12,
            borderRadius: 14,
            border: `1px solid ${T.border}`,
            background: T.surface,
            boxShadow: "0 18px 42px rgba(31,30,28,0.18)",
            boxSizing: "border-box",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            <Sel
              value={String(month.getMonth())}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setMonth(new Date(month.getFullYear(), Number(e.target.value), 1))}
              optionAlign="center"
              valueAlign="center"
              style={{ minHeight: 38, padding: "8px 10px", borderRadius: 10, fontSize: 12 }}
            >
              {monthNames.map((name, i) => <option key={name} value={String(i)}>{name}</option>)}
            </Sel>
            <Sel
              value={String(month.getFullYear())}
              onChange={(e: ChangeEvent<HTMLSelectElement>) => setMonth(new Date(Number(e.target.value), month.getMonth(), 1))}
              optionAlign="center"
              valueAlign="center"
              style={{ minHeight: 38, padding: "8px 10px", borderRadius: 10, fontSize: 12 }}
            >
              {yearOptions.map(year => <option key={year} value={String(year)}>{year}</option>)}
            </Sel>
          </div>
          <DayPicker
            mode="single"
            month={month}
            onMonthChange={setMonth}
            selected={selected}
            onSelect={(date) => {
              if (!date) return;
              onChange(toDateValue(date));
              setOpen(false);
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button type="button" className="btn-soft" style={{ flex: 1, padding: "8px 10px", minHeight: 38 }} onClick={() => { onChange(toDateValue(new Date())); setOpen(false); }}>Today</button>
            <button type="button" className="btn-soft" style={{ flex: 1, padding: "8px 10px", minHeight: 38 }} onClick={() => { onChange(""); setOpen(false); }}>Clear</button>
          </div>
        </div>
      , document.body)}
    </div>
  );
}

export function TimePickerField({ value, onChange, placeholder = "Select time" }: TimePickerFieldProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const hourListRef = useRef<HTMLDivElement | null>(null);
  const minuteListRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<FloatingPanelPosition | null>(null);
  const { hour12, minute, period } = useMemo(() => timeParts(value), [value]);
  const displayValue = formatTimeLabel(value);
  const updatePart = (next: Partial<{ hour12: number; minute: number; period: string }>) => {
    onChange(toTimeValue(next.hour12 ?? hour12, next.minute ?? minute, next.period ?? period));
  };

  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  useEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const rect = ref.current?.getBoundingClientRect();
      if (!rect) return;
      setPos(getFloatingPanelPosition({
        trigger: rect,
        panelWidth: 320,
        panelHeight: 270,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      }));
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      hourListRef.current
        ?.querySelector<HTMLElement>('[data-active="true"]')
        ?.scrollIntoView({ block: "center" });
      minuteListRef.current
        ?.querySelector<HTMLElement>('[data-active="true"]')
        ?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, hour12, minute]);

  return (
    <div ref={ref} style={{ position: "relative", width: "100%", minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        style={{
          width: "100%",
          minHeight: 44,
          padding: "10px 13px",
          borderRadius: 10,
          border: `1px solid ${T.border}`,
          background: T.surface,
          color: displayValue ? T.ink : T.subtle,
          fontSize: 13,
          fontFamily: "inherit",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 10,
          cursor: "pointer",
          boxSizing: "border-box",
          textAlign: "left",
        }}
      >
        <span>{displayValue || placeholder}</span>
        <span style={{ color: T.accent, fontSize: 15 }}>Time</span>
      </button>
      {open && pos && createPortal(
        <div
          className="p1-picker-popover"
          onPointerDown={(e) => e.stopPropagation()}
          style={{
            width: pos.width,
            left: pos.left,
            top: pos.top,
            maxHeight: pos.maxHeight,
            overflowY: "auto",
            overflowX: "hidden",
            padding: 10,
            borderRadius: 14,
            border: `1px solid ${T.border}`,
            background: T.surface,
            boxShadow: "0 18px 42px rgba(31,30,28,0.18)",
            boxSizing: "border-box",
          }}
        >
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 72px", gap: 8 }}>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Hour</div>
              <div ref={hourListRef} style={{ maxHeight: 190, overflowY: "auto", display: "grid", gap: 4, scrollbarGutter: "stable both-edges" }}>
                {Array.from({ length: 12 }, (_, i) => i + 1).map(h => (
                  <button key={h} type="button" data-active={h === hour12 ? "true" : undefined} onClick={() => updatePart({ hour12: h })} style={{ minHeight: 34, padding: 0, borderRadius: 9, border: "none", background: h === hour12 ? T.accentSoft : T.surfaceSoft, color: h === hour12 ? T.accent : T.ink, fontSize: 13, fontWeight: h === hour12 ? 700 : 500, fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" }}>{h}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Minute</div>
              <div ref={minuteListRef} style={{ maxHeight: 190, overflowY: "auto", display: "grid", gap: 4, scrollbarGutter: "stable both-edges" }}>
                {Array.from({ length: 60 }, (_, i) => i).map(m => (
                  <button key={m} type="button" data-active={m === minute ? "true" : undefined} onClick={() => updatePart({ minute: m })} style={{ minHeight: 34, padding: 0, borderRadius: 9, border: "none", background: m === minute ? T.accentSoft : T.surfaceSoft, color: m === minute ? T.accent : T.ink, fontSize: 13, fontWeight: m === minute ? 700 : 500, fontFamily: "inherit", fontVariantNumeric: "tabular-nums", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" }}>{pad(m)}</button>
                ))}
              </div>
            </div>
            <div>
              <div style={{ fontSize: 10, fontWeight: 700, color: T.subtle, textTransform: "uppercase", letterSpacing: 0.8, marginBottom: 6 }}>Period</div>
              <div style={{ display: "grid", gap: 6 }}>
                {["AM", "PM"].map(p => (
                  <button key={p} type="button" onClick={() => updatePart({ period: p })} style={{ minHeight: 42, padding: 0, borderRadius: 10, border: "none", background: p === period ? T.accent : T.surfaceSoft, color: p === period ? "#fff" : T.ink, fontSize: 13, fontWeight: 700, fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center" }}>{p}</button>
                ))}
              </div>
            </div>
          </div>
        </div>
      , document.body)}
    </div>
  );
}
