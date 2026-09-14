"use client";

import { useState } from "react";

import { Avatar } from "../../components/ui/Avatar";
import { Modal } from "../../components/ui/Modal";
import { T } from "../../lib/constants";
import { useDirectoryPage, useDirectorySelection } from "../directory/queries";
import { DirectoryError, DirectoryPageControls } from "../directory/DirectorySelect";
import type { DirectoryItem } from "../directory/contracts";

function ContactRow({ entry, expanded, onToggle }: { entry: DirectoryItem; expanded: boolean; onToggle: () => void }) {
  // Contact addresses are an explicit single-record read, not list payload.
  const detail = useDirectorySelection("contact_detail", entry.id, null, expanded);
  const contact = expanded && !detail.isError ? detail.data : null;
  return (
  <div className="address-book-row" style={{ display: "grid", gridTemplateColumns: "38px minmax(140px, 1fr) minmax(170px, 1.2fr)", gap: 10, alignItems: "center", padding: "11px 0", borderBottom: `1px solid ${T.borderSoft}` }}>
    <Avatar initials={entry.initials} color={entry.color} size={34} />
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: T.ink }}>{entry.name}</div>
      <div style={{ fontSize: 10, color: T.subtle, marginTop: 2 }}>{entry.title || entry.company || "—"}</div>
    </div>
    <div className="address-book-contact" style={{ minWidth: 0, fontSize: 11, lineHeight: 1.6 }}>
      <button type="button" className="btn-soft" aria-expanded={expanded} onClick={onToggle}>{expanded ? "Hide contact" : "View contact"}</button>
      {expanded && detail.isFetching && <span role="status">Loading contact…</span>}
      {expanded && <DirectoryError directory={detail} />}
      {contact && <>
        {contact.email ? <a href={`mailto:${contact.email}`} style={{ display: "block", color: T.accent, overflowWrap: "anywhere" }}>{contact.email}</a> : <span style={{ color: T.subtle }}>No email</span>}
        {contact.phone ? <a href={`tel:${contact.phone}`} style={{ display: "block", color: T.muted }}>{contact.phone}</a> : <span style={{ display: "block", color: T.subtle }}>No phone</span>}
      </>}
      {expanded && !detail.isFetching && !detail.isError && !contact && <span role="status">Contact is no longer available.</span>}
    </div>
  </div>
  );
}

export default function AddressBookModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const directory = useDirectoryPage("contacts", open);

  if (!open) return null;

  return (
    <Modal onClose={onClose} title="Address book" width={760}>
      <div style={{ color: T.muted, fontSize: 11, marginTop: -8, marginBottom: 14 }}>
        Staff-only directory populated from current portal records.
      </div>
      <input
        type="search"
        value={directory.search}
        onChange={event => { setExpanded(null); directory.setSearch(event.target.value); }}
        placeholder="Search name, company, title, email, or phone"
        aria-label="Search address book"
        autoFocus
        style={{ width: "100%", minHeight: 42, padding: "9px 12px", borderRadius: 9, border: `1px solid ${T.border}`, color: T.ink, background: T.surface, fontFamily: "inherit" }}
      />
      <DirectoryError directory={directory} />
      <section aria-label="Staff and contractor contacts" style={{ marginTop: 18 }}>
        <div style={{ color: T.subtle, fontSize: 10 }}>{directory.isError ? 0 : directory.items.length} shown on this page</div>
        <div style={{ maxHeight: 420, overflowY: "auto", borderTop: `1px solid ${T.borderSoft}` }}>
          {!directory.isError && directory.items.map(entry => <ContactRow key={entry.id} entry={entry}
            expanded={expanded === entry.id} onToggle={() => setExpanded(current => current === entry.id ? null : entry.id)} />)}
          {!directory.waiting && !directory.isError && directory.items.length === 0 && <div role="status" style={{ padding: "18px 0", color: T.subtle, fontSize: 11 }}>No matching contacts on this page.</div>}
        </div>
        <DirectoryPageControls directory={directory} />
      </section>
    </Modal>
  );
}
