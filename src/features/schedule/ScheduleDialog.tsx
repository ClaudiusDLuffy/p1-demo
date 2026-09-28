"use client";

import { DatePickerField, TimePickerField } from "../../components/ui/DateTimePicker";
import { Field } from "../../components/ui/Field";
import { Modal } from "../../components/ui/Modal";
import { timezoneForWorkOrder } from "../../lib/billingRules";
import type { WorkOrderSchedulingController } from "./useWorkOrderScheduling";

export function ScheduleDialog({ controller }: { controller: WorkOrderSchedulingController }) {
  const { close, date, error, save, saving, setDate, setTime, target, time } = controller;
  if (!target) return null;

  return (
    <Modal
      title={`Schedule ${target.id}`}
      description={(
        <p className="-mt-2.5 mb-[18px] text-[11px] leading-[1.5] text-p1-muted">
          This saves the work order ETA in the store&apos;s local time. It does not clock the technician in.
        </p>
      )}
      width={460}
      dismissDisabled={saving}
      onRequestClose={close}
    >
      <div className="grid grid-cols-1 gap-3 min-[481px]:grid-cols-2">
        <Field label="Date" required>
          <DatePickerField value={date} onChange={setDate} disabled={saving} />
        </Field>
        <Field label="Time" required>
          <TimePickerField value={time} onChange={setTime} disabled={saving} />
        </Field>
      </div>
      <div className="mt-2.5 text-[10px] text-p1-muted">Store time zone: {timezoneForWorkOrder(target)}</div>
      {error && (
        <div className="mt-3 rounded-[9px] border border-[#ebc3bc] bg-p1-danger-soft p-2.5 text-[11px] text-p1-danger" role="alert">
          {error}
        </div>
      )}
      <div className="mt-[18px] grid grid-cols-2 gap-2 border-t border-p1-border-soft pt-3.5 min-[481px]:flex min-[481px]:justify-end">
        <button type="button" className="btn-soft" onClick={close} disabled={saving}>Cancel</button>
        <button type="button" className="btn-accent" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Confirm schedule"}
        </button>
      </div>
    </Modal>
  );
}
