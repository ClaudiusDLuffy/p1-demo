"use client";

import { useMemo, useState } from "react";

import { Avatar } from "../../components/ui/Avatar";
import { Modal } from "../../components/ui/Modal";
import { T } from "../../lib/constants";

type AddressBookEntry = {
  id: string;
  name: string;
  active?: boolean | null;
  color?: string | null;
  company?: string | null;
  email?: string | null;
  initials?: string | null;
  phone?: string | null;
  title?: string | null;
};

const matches = (entry: AddressBookEntry, query: string) => [
  entry.name,
  entry.company,
  entry.title,
  entry.email,
  entry.phone,
]
  .filter(Boolean)
  .join(" ")
  .toLowerCase()
  .includes(query);

const ContactRow = ({ entry }: { entry: AddressBookEntry }) => (
  <div className="address-book-row" style={{ display: "grid", gridTemplateColumns: "38px minmax(140px, 1fr) minmax(170px, 1.2fr)", gap: 10, alignItems: "center", padding: "11px 0", borderBottom: `1px solid ${T.borderSoft}` }}>
    <Avatar initials={entry.initials} color={entry.color} size={34} />
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.ink }}>{entry.name}</div>
      <div style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>{entry.title || entry.company || "—"}</div>
    </div>
    <div className="address-book-contact" style={{ minWidth: 0, fontSize: 11, lineHeight: 1.6 }}>
      {entry.email ? <a href={`mailto:${entry.email}`} style={{ display: "block", color: T.accent, overflowWrap: "anywhere" }}>{entry.email}</a> : <span style={{ color: T.subtle }}>No email</span>}
      {entry.phone ? <a href={`tel:${entry.phone}`} style={{ display: "block", color: T.muted }}>{entry.phone}</a> : <span style={{ display: "block", color: T.subtle }}>No phone</span>}
    </div>
  </div>
);

export default function AddressBookModal({
  open,
  onClose,
  staff,
  contractors,
}: {
  open: boolean;
  onClose: () => void;
  staff: AddressBookEntry[];
  contractors: AddressBookEntry[];
}) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const sections = useMemo(() => [
    {
      id: "staff",
      label: "P1 staff",
      rows: staff.filter(entry => entry.active !== false && matches(entry, normalizedQuery)),
    },
    {
      id: "contractors",
      label: "Contractors",
      rows: contractors.filter(entry => entry.active !== false && matches(entry, normalizedQuery)),
    },
  ], [contractors, normalizedQuery, staff]);

  if (!open) return null;

  return (
    <Modal onClose={onClose} title="Address book" width={760}>
      <div style={{ color: T.muted, fontSize: 11, marginTop: -8, marginBottom: 14 }}>
        Staff-only directory populated from current portal records.
      </div>
      <input
        type="search"
        value={query}
        onChange={event => setQuery(event.target.value)}
        placeholder="Search name, company, email, or phone"
        aria-label="Search address book"
        autoFocus
        style={{ width: "100%", minHeight: 42, padding: "9px 12px", borderRadius: 9, border: `1px solid ${T.border}`, color: T.ink, background: T.surface, fontFamily: "inherit" }}
      />
      <div style={{ display: "grid", gap: 18, marginTop: 18 }}>
        {sections.map(section => (
          <section key={section.id}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <h3 style={{ margin: 0, color: T.ink, fontSize: 13 }}>{section.label}</h3>
              <span style={{ color: T.subtle, fontSize: 10 }}>{section.rows.length}</span>
            </div>
            <div style={{ maxHeight: 250, overflowY: "auto", borderTop: `1px solid ${T.borderSoft}` }}>
              {section.rows.map(entry => <ContactRow key={entry.id} entry={entry} />)}
              {section.rows.length === 0 && <div style={{ padding: "18px 0", color: T.subtle, fontSize: 11 }}>No matching contacts.</div>}
            </div>
          </section>
        ))}
      </div>
    </Modal>
  );
}
