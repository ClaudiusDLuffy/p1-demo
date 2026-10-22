"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { safeErrorMessage } from "../../lib/errors/normalizeUnknown";
import { T } from "../../lib/constants";
import { Input } from "../../components/ui/Input";
import { Modal } from "../../components/ui/Modal";
import { firstCursorPosition, nextCursorPosition, previousCursorPosition, type CursorPosition } from "../../lib/cursorPagination";
import { loadVaCoordinatorPhoto } from "./data/vaCoordinatorPhotoRepository";
import {
  useTransferTechnicianNote,
  useVaCoordinatorAttachments,
  useVaCoordinatorTechnicianNotes,
  useVaCoordinatorWorkOrder,
  useVaCoordinatorWorkOrders,
  vaCoordinatorQueryKeys,
} from "./queries";
import { canTransferTechnicianNote } from "./technicianNoteTransfer";
import { VA_COORDINATOR_LABEL, VA_COORDINATOR_SEARCH_LIMIT, type VaCoordinatorNote } from "./contracts";

type Actor = Readonly<{ id: string; name: string; email: string; initials: string | null; active: boolean }>;

export default function VaCoordinatorWorkspace({ actor, onSignOut }: {
  actor: Actor;
  onSignOut: () => Promise<void>;
}) {
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState<CursorPosition>(firstCursorPosition);
  const [selectedWorkOrderId, setSelectedWorkOrderId] = useState<string | null>(null);
  const [photoUrls, setPhotoUrls] = useState<Record<string, string>>({});
  const [photoLoadingId, setPhotoLoadingId] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState("");
  const [notice, setNotice] = useState("");
  const [transferCandidate, setTransferCandidate] = useState<VaCoordinatorNote | null>(null);
  const [transferConfirmed, setTransferConfirmed] = useState(false);
  const photoUrlsRef = useRef(new Set<string>());
  const queryClient = useQueryClient();
  const workOrdersQuery = useVaCoordinatorWorkOrders(actor, search, position.cursor);
  const workOrderQuery = useVaCoordinatorWorkOrder(actor, selectedWorkOrderId);
  const notesQuery = useVaCoordinatorTechnicianNotes(actor, selectedWorkOrderId);
  const attachmentsQuery = useVaCoordinatorAttachments(actor, selectedWorkOrderId);
  const transfer = useTransferTechnicianNote(actor, selectedWorkOrderId);
  const workOrders = workOrdersQuery.data;
  const workOrder = workOrderQuery.data;
  const notes = notesQuery.data || [];
  const attachments = attachmentsQuery.data || [];

  useEffect(() => () => photoUrlsRef.current.forEach(url => URL.revokeObjectURL(url)), []);

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSearch(searchInput.trim());
    setPosition(firstCursorPosition());
    setSelectedWorkOrderId(null);
    setNotice("");
  };

  const openPhoto = async (id: string, path: string) => {
    setPhotoLoadingId(id);
    setPhotoError("");
    try {
      const url = URL.createObjectURL(await loadVaCoordinatorPhoto(path));
      photoUrlsRef.current.add(url);
      setPhotoUrls(current => {
        const prior = current[id];
        if (prior) { URL.revokeObjectURL(prior); photoUrlsRef.current.delete(prior); }
        return { ...current, [id]: url };
      });
    } catch (cause) {
      setPhotoError(safeErrorMessage(cause));
    } finally {
      setPhotoLoadingId(null);
    }
  };

  const confirmTransferred = async (note: VaCoordinatorNote) => {
    if (!canTransferTechnicianNote(note) || transfer.isPending) return;
    if (!transferConfirmed) return;
    setNotice("");
    try {
      await transfer.mutateAsync({ note, confirmed: transferConfirmed });
      setNotice("Transfer recorded under your account.");
      setTransferCandidate(null);
      setTransferConfirmed(false);
    } catch (cause) {
      setNotice(safeErrorMessage(cause));
      await queryClient.invalidateQueries({ queryKey: vaCoordinatorQueryKeys.notes(actor.id, selectedWorkOrderId || "") });
    }
  };

  const requestTransfer = (note: VaCoordinatorNote) => {
    if (!canTransferTechnicianNote(note) || transfer.isPending) return;
    setTransferCandidate(note);
    setTransferConfirmed(false);
  };

  const pageStatus = workOrdersQuery.isPending ? "Loading team work orders…"
    : workOrdersQuery.isError ? safeErrorMessage(workOrdersQuery.error)
      : search ? "Search results" : "Team work orders";

  return <div className="app-root" style={{ minHeight: "100vh", background: T.bg, color: T.ink }}>
    <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16,
      padding: "16px clamp(16px, 4vw, 40px)", background: T.sidebar, color: T.surface }}>
      <div><div style={{ fontSize: 17, fontWeight: 700 }}>P1 Portal</div>
        <div style={{ color: T.sidebarText, fontSize: 12 }}>{VA_COORDINATOR_LABEL} · {actor.name}</div></div>
      <button type="button" className="btn-soft" onClick={() => void onSignOut()}>Sign out</button>
    </header>
    <main style={{ maxWidth: 1280, margin: "0 auto", padding: "24px clamp(16px, 4vw, 40px)" }}>
      <div className="va-coordinator-grid" style={{ display: "grid", gridTemplateColumns: "minmax(300px, .9fr) minmax(320px, 1.4fr)", gap: 20 }}>
        <section aria-label="Team work orders" style={panelStyle}>
          <h1 style={headingStyle}>Team work orders</h1>
          <form onSubmit={submitSearch} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
            <Input aria-label="Search team work orders" value={searchInput} maxLength={VA_COORDINATOR_SEARCH_LIMIT}
              onChange={event => setSearchInput(event.target.value)} placeholder="Work order, store, city, or summary" />
            <button type="submit" className="btn-primary">Search</button>
          </form>
          <p role={workOrdersQuery.isError ? "alert" : "status"} style={mutedStyle}>{pageStatus}</p>
          {workOrders?.items.length === 0 && <p style={mutedStyle}>No work orders are assigned to your team.</p>}
          <div style={{ display: "grid", gap: 8 }}>
            {workOrders?.items.map(item => <button key={item.id} type="button"
              onClick={() => { setSelectedWorkOrderId(item.id); setPhotoError(""); setNotice(""); }}
              aria-current={selectedWorkOrderId === item.id ? "true" : undefined}
              style={{ ...rowStyle, borderColor: selectedWorkOrderId === item.id ? T.accent : T.border,
                background: selectedWorkOrderId === item.id ? T.accentSoft : T.surface }}>
              <span style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                <strong>{item.id}</strong><span style={mutedStyle}>{item.functionalStatus || item.status || ""}</span>
              </span>
              <span style={{ display: "block", marginTop: 5 }}>{item.summary || "Work order"}</span>
              <span style={{ display: "block", marginTop: 5, ...mutedStyle }}>Store {item.storeNumber || "—"} · {[item.city, item.state].filter(Boolean).join(", ") || "Location unavailable"}</span>
            </button>)}
          </div>
          <div className="work-order-pagination" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 16 }}>
            <button type="button" className="btn-soft" disabled={position.page <= 1 || workOrdersQuery.isFetching}
              onClick={() => setPosition(previousCursorPosition)}>Previous</button>
            <span style={mutedStyle}>Page {position.page}</span>
            <button type="button" className="btn-soft" disabled={!workOrders?.hasMore || !workOrders.nextCursor || workOrdersQuery.isFetching}
              onClick={() => setPosition(current => nextCursorPosition(current, workOrders?.nextCursor || null))}>Next</button>
          </div>
        </section>

        <section aria-label="Selected work order details" style={panelStyle}>
          {!selectedWorkOrderId && <p style={{ ...mutedStyle, textAlign: "center", padding: 40 }}>Select a team work order to review its equipment, technician notes, and photos.</p>}
          {workOrderQuery.isPending && selectedWorkOrderId && <p role="status">Loading work-order details…</p>}
          {workOrderQuery.isError && <p role="alert" style={errorStyle}>{safeErrorMessage(workOrderQuery.error)}</p>}
          {workOrder && <>
            <header style={{ borderBottom: `1px solid ${T.border}`, paddingBottom: 16, marginBottom: 16 }}>
              <div style={mutedStyle}>WORK ORDER</div><h2 style={{ ...headingStyle, marginTop: 4 }}>{workOrder.id}</h2>
              <div style={{ fontWeight: 600 }}>{workOrder.summary || "Work order"}</div>
              <div style={{ ...mutedStyle, marginTop: 6 }}>Store {workOrder.storeNumber || "—"} · {[workOrder.city, workOrder.state].filter(Boolean).join(", ")}</div>
              {workOrder.address && <div style={{ ...mutedStyle, marginTop: 3 }}>{workOrder.address}</div>}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 12 }}>
                {[ ["Status", workOrder.functionalStatus || workOrder.status], ["Assigned technician", workOrder.technicianName], ["Priority", workOrder.priority] ]
                  .filter((entry): entry is [string, string] => Boolean(entry[1]))
                  .map(([label, value]) => <span key={label} style={pillStyle}>{label}: {value}</span>)}
              </div>
            </header>
            <section style={subsectionStyle}>
              <h3 style={subheadingStyle}>Equipment</h3>
              <dl style={definitionGridStyle}>
                <dt>Make</dt><dd>{workOrder.assetMake || "—"}</dd><dt>Model</dt><dd>{workOrder.assetModel || "—"}</dd>
                <dt>Serial</dt><dd>{workOrder.assetSerial || "—"}</dd><dt>Year</dt><dd>{workOrder.assetYear ?? "—"}</dd>
              </dl>
              {workOrder.description && <p style={{ whiteSpace: "pre-wrap", margin: "12px 0 0" }}>{workOrder.description}</p>}
            </section>
            <section style={subsectionStyle}>
              <h3 style={subheadingStyle}>Technician notes</h3>
              {notesQuery.isPending && <p role="status">Loading notes…</p>}
              {notesQuery.isError && <p role="alert" style={errorStyle}>{safeErrorMessage(notesQuery.error)}</p>}
              {!notesQuery.isPending && notes.length === 0 && <p style={mutedStyle}>No technician notes are available.</p>}
              <div style={{ display: "grid", gap: 10 }}>{notes.map(note => <article key={note.id} style={noteStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, ...mutedStyle }}><span>{note.authorName}</span><time>{formatDate(note.createdAt)}</time></div>
                <p style={{ whiteSpace: "pre-wrap", margin: "8px 0" }}>{note.text}</p>
                {note.requiresSevenElevenSync && (note.syncedToSevenElevenAt
                  ? <p role="status" style={{ color: T.success, fontSize: 12 }}>Transferred by {note.syncedByName || "portal user"} · {formatDate(note.syncedToSevenElevenAt)}</p>
                  : <button type="button" className="btn-soft" disabled={transfer.isPending}
                    onClick={() => requestTransfer(note)}>Mark copied to 7-Eleven</button>)}
              </article>)}</div>
            </section>
            <section style={subsectionStyle}>
              <h3 style={subheadingStyle}>Photos</h3>
              {attachmentsQuery.isPending && <p role="status">Loading photos…</p>}
              {attachmentsQuery.isError && <p role="alert" style={errorStyle}>{safeErrorMessage(attachmentsQuery.error)}</p>}
              {attachments.length === 0 && !attachmentsQuery.isPending && <p style={mutedStyle}>No photos are available.</p>}
              {photoError && <p role="alert" style={errorStyle}>{photoError}</p>}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 10 }}>
                {attachments.map(photo => <article key={photo.id} style={noteStyle}>
                  {photoUrls[photo.id] ? <img src={photoUrls[photo.id]} alt={photo.caption || "Work-order photo"} style={{ width: "100%", maxHeight: 190, objectFit: "contain" }} />
                    : <div style={{ minHeight: 56, ...mutedStyle }}>{photo.caption || "Work-order photo"}</div>}
                  <div style={{ ...mutedStyle, fontSize: 11, margin: "6px 0" }}>{photo.uploaderName || ""} · {formatDate(photo.createdAt)}</div>
                  <button type="button" className="btn-soft" disabled={photoLoadingId === photo.id}
                    onClick={() => void openPhoto(photo.id, photo.storagePath)}>{photoLoadingId === photo.id ? "Loading…" : photoUrls[photo.id] ? "Reload photo" : "View photo"}</button>
                </article>)}
              </div>
            </section>
          </>}
          {notice && <p role="status" style={noticeStyle}>{notice}</p>}
        </section>
      </div>
    </main>
    {transferCandidate && <Modal title="Confirm transfer to 7-Eleven" width={480}
      description="Only record this after you have successfully copied the technician note into 7-Eleven."
      dismissDisabled={transfer.isPending} onRequestClose={() => { setTransferCandidate(null); setTransferConfirmed(false); }}>
      <div style={{ display: "grid", gap: 16 }}>
        <blockquote style={{ ...noteStyle, margin: 0, whiteSpace: "pre-wrap", maxHeight: 180, overflow: "auto" }}>
          {transferCandidate.text}
        </blockquote>
        <label style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
          <input type="checkbox" checked={transferConfirmed} disabled={transfer.isPending}
            onChange={event => setTransferConfirmed(event.target.checked)} />
          <span>I confirm I successfully copied this note into 7-Eleven.</span>
        </label>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button type="button" className="btn-soft" disabled={transfer.isPending}
            onClick={() => { setTransferCandidate(null); setTransferConfirmed(false); }}>Cancel</button>
          <button type="button" className="btn-primary" disabled={!transferConfirmed || transfer.isPending}
            onClick={() => void confirmTransferred(transferCandidate)}>{transfer.isPending ? "Recording…" : "Record transfer"}</button>
        </div>
      </div>
    </Modal>}
  </div>;
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
}

const panelStyle = { background: T.surface, border: `1px solid ${T.border}`, borderRadius: 12, padding: 18, alignSelf: "start" as const };
const headingStyle = { fontSize: 21, lineHeight: 1.25, margin: "0 0 14px" };
const subheadingStyle = { fontSize: 16, margin: "0 0 10px" };
const mutedStyle = { color: T.muted, fontSize: 12 };
const errorStyle = { color: T.danger, background: T.dangerSoft, border: `1px solid ${T.border}`, padding: 10, borderRadius: 8 };
const noticeStyle = { color: T.success, marginTop: 12 };
const rowStyle = { textAlign: "left" as const, border: "1px solid", borderRadius: 9, padding: 12, cursor: "pointer", color: T.ink };
const noteStyle = { border: `1px solid ${T.border}`, borderRadius: 9, padding: 12, background: T.surfaceSoft };
const pillStyle = { background: T.bgWarm, borderRadius: 999, padding: "5px 9px", color: T.inkSoft, fontSize: 12 };
const subsectionStyle = { borderBottom: `1px solid ${T.border}`, paddingBottom: 16, marginBottom: 16 };
const definitionGridStyle = { display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 14px", margin: 0 };
