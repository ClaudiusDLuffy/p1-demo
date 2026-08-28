"use client";

import { T } from "../../lib/constants";
import type { WorkOrderTableSortColumn } from "../../lib/db";

export type WorkOrderSortOption = {
  value: WorkOrderTableSortColumn;
  label: string;
};

export default function WorkOrderSortControls({
  column,
  direction,
  options,
  onColumnChange,
  onDirectionChange,
}: {
  column: WorkOrderTableSortColumn;
  direction: "asc" | "desc";
  options: WorkOrderSortOption[];
  onColumnChange: (column: WorkOrderTableSortColumn) => void;
  onDirectionChange: (direction: "asc" | "desc") => void;
}) {
  return (
    <div
      aria-label="Work order sorting"
      style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}
    >
      <label style={{ fontSize: 11, fontWeight: 700, color: T.muted }}>
        Sort by
        <select
          aria-label="Sort work orders by"
          value={column}
          onChange={event => onColumnChange(event.target.value as WorkOrderTableSortColumn)}
          style={{
            marginLeft: 7,
            padding: "9px 30px 9px 10px",
            borderRadius: 8,
            border: `1px solid ${T.border}`,
            background: T.surface,
            color: T.ink,
            fontFamily: "inherit",
            fontSize: 12,
          }}
        >
          {options.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className="btn-soft"
        aria-label={`Sort ${direction === "asc" ? "descending" : "ascending"}`}
        title={direction === "asc" ? "Ascending" : "Descending"}
        onClick={() => onDirectionChange(direction === "asc" ? "desc" : "asc")}
        style={{ padding: "9px 11px", minWidth: 42 }}
      >
        {direction === "asc" ? "↑" : "↓"}
      </button>
    </div>
  );
}
