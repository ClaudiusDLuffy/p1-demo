import type { ModalDismissReason } from "./dismissal";

export const MAX_MODAL_DEPTH = 32;
type ModalEntry = {
  dialog: HTMLDialogElement;
  host: HTMLElement;
  requestClose: (reason: ModalDismissReason) => void;
  initialFocus: () => HTMLElement | null;
  restoreFocus: () => HTMLElement | null;
  previousFocus: HTMLElement | null;
};
type InertState = { element: HTMLElement; inert?: boolean; ariaHidden?: string | null };
type DocumentState = {
  entries: ModalEntry[];
  overflow: string | undefined;
  inert: InertState[];
  keydown: (event: KeyboardEvent) => void;
  focusin: (event: FocusEvent) => void;
};
const documents = new WeakMap<Document, DocumentState>();

function attempt(action: () => void): boolean {
  try { action(); return true; } catch { return false; }
}
function readSafely<T>(read: () => T): T | undefined {
  try { return read(); } catch { return undefined; }
}
function restoreSafely(action: () => void): void {
  if (!attempt(action)) attempt(action);
}
function focusSafely(element: HTMLElement): boolean {
  return attempt(() => element.focus({ preventScroll: true }));
}

function isElement(value: unknown, document: Document): value is HTMLElement {
  const constructor = document.defaultView?.HTMLElement;
  return Boolean(constructor && value instanceof constructor);
}
export function isUsableFocusTarget(element: HTMLElement | null): element is HTMLElement {
  return Boolean(readSafely(() => element && element.isConnected && !element.closest('[inert], [hidden], [aria-hidden="true"]')
    && !element.matches(':disabled, [aria-disabled="true"], input[type="hidden"]')
    && element.getClientRects().length));
}
export function modalFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return (readSafely(() => Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]'))) || [])
    .filter(element => element.tabIndex >= 0 && isUsableFocusTarget(element));
}
function isDestructive(element: HTMLElement): boolean {
  return element.matches('[data-destructive="true"], .btn-danger, [type="submit"]')
    || /\b(delete|discard|remove|confirm|submit|send|approve|reject)\b/i.test(element.textContent || "");
}
export function focusModal(entry: Pick<ModalEntry, "dialog" | "initialFocus">): void {
  const explicit = readSafely(entry.initialFocus) || null;
  const marked = readSafely(() => entry.dialog.querySelector<HTMLElement>('[data-modal-initial-focus="true"]')) || null;
  const safe = modalFocusableElements(entry.dialog).filter(element => !isDestructive(element));
  const target = isUsableFocusTarget(explicit) && entry.dialog.contains(explicit) ? explicit
    : isUsableFocusTarget(marked) ? marked
      : safe.find(element => element.matches('input, textarea, select, [role="combobox"]'))
        || safe.find(element => !element.classList.contains("modal-close")) || safe[0] || entry.dialog;
  if (!focusSafely(target) && target !== entry.dialog) focusSafely(entry.dialog);
}
function restoreInert(state: DocumentState): void {
  for (const previous of state.inert) {
    if (previous.inert !== undefined) restoreSafely(() => { previous.element.inert = previous.inert === true; });
    if (previous.ariaHidden === null) restoreSafely(() => previous.element.removeAttribute("aria-hidden"));
    else if (previous.ariaHidden !== undefined) restoreSafely(() => previous.element.setAttribute("aria-hidden", previous.ariaHidden || ""));
  }
  state.inert = [];
}
function updateInert(document: Document, state: DocumentState): void {
  restoreInert(state);
  const top = state.entries.at(-1);
  if (!top) return;
  for (const element of readSafely(() => Array.from(document.body.children)) || []) {
    if (!isElement(element, document) || element === top.host) continue;
    const inert = readSafely(() => element.inert);
    const ariaHidden = readSafely(() => element.getAttribute("aria-hidden"));
    state.inert.push({ element, inert, ariaHidden });
    if (inert !== undefined) attempt(() => { element.inert = true; });
    if (ariaHidden !== undefined) attempt(() => element.setAttribute("aria-hidden", "true"));
  }
}

function focusApplication(document: Document): void {
  const marked = readSafely(() => document.body.querySelector<HTMLElement>('[data-modal-restore-focus="true"]')) || null;
  if (isUsableFocusTarget(marked) && focusSafely(marked)) return;
  const safe = modalFocusableElements(document.body).find(element => !isDestructive(element));
  if (safe && focusSafely(safe)) return;
  const container = readSafely(() => document.body.querySelector<HTMLElement>('main, [role="main"]')) || document.body;
  if (!isUsableFocusTarget(container)) return;
  const priorTabIndex = readSafely(() => container.getAttribute("tabindex"));
  if (priorTabIndex === undefined) return;
  if (priorTabIndex === null) attempt(() => container.setAttribute("tabindex", "-1"));
  focusSafely(container);
  if (priorTabIndex === null) attempt(() => container.removeAttribute("tabindex"));
}
export function isTopModal(dialog: HTMLDialogElement): boolean {
  return documents.get(dialog.ownerDocument)?.entries.at(-1)?.dialog === dialog;
}
export function requestTopModalClose(reason: ModalDismissReason, document?: Document): boolean {
  const owner = document || (typeof window === "undefined" ? undefined : window.document);
  const top = owner && documents.get(owner)?.entries.at(-1);
  if (!top) return false;
  top.requestClose(reason);
  return true;
}

/** One document listener pair/scroll owner. Entries contain DOM refs, never form data. */
export function registerModal(input: Omit<ModalEntry, "previousFocus">): () => void {
  const document = input.dialog.ownerDocument;
  let state = documents.get(document);
  if (!state) {
    const next: DocumentState = { entries: [], overflow: readSafely(() => document.body.style.overflow), inert: [],
      keydown: event => {
        const top = next.entries.at(-1);
        if (!top || event.defaultPrevented) return;
        if (event.key === "Escape") {
          event.preventDefault();
          top.requestClose("escape");
        } else if (event.key === "Tab") {
          const choices = modalFocusableElements(top.dialog);
          const index = choices.indexOf(document.activeElement as HTMLElement);
          if (!choices.length) { event.preventDefault(); focusSafely(top.dialog); }
          else if (event.shiftKey && index <= 0) { event.preventDefault(); const last = choices.at(-1); if (last) focusSafely(last); }
          else if (!event.shiftKey && (index < 0 || index === choices.length - 1)) { event.preventDefault(); focusSafely(choices[0]); }
        }
      },
      focusin: event => {
        const top = next.entries.at(-1);
        if (top && isElement(event.target, document) && !top.dialog.contains(event.target)) focusModal(top);
      },
    };
    state = next;
    documents.set(document, state);
    if (state.overflow !== undefined) attempt(() => { document.body.style.overflow = "hidden"; });
    attempt(() => document.addEventListener("keydown", next.keydown));
    attempt(() => document.addEventListener("focusin", next.focusin));
  }
  if (state.entries.length >= MAX_MODAL_DEPTH) throw new Error("Modal nesting limit reached");
  const entry = { ...input, previousFocus: isElement(document.activeElement, document) ? document.activeElement : null };
  state.entries.push(entry);
  updateInert(document, state);
  try { if (!input.dialog.open) input.dialog.showModal(); }
  catch { attempt(() => input.dialog.setAttribute("open", "")); }
  focusModal(entry);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    const wasTop = state.entries.at(-1) === entry;
    state.entries = state.entries.filter(candidate => candidate !== entry);
    try { if (input.dialog.open) input.dialog.close(); }
    catch { attempt(() => input.dialog.removeAttribute("open")); }
    updateInert(document, state);
    if (!state.entries.length) {
      restoreSafely(() => document.removeEventListener("keydown", state.keydown));
      restoreSafely(() => document.removeEventListener("focusin", state.focusin));
      if (state.overflow !== undefined) restoreSafely(() => { document.body.style.overflow = state.overflow || ""; });
      documents.delete(document);
    }
    if (wasTop) {
      const top = state.entries.at(-1);
      const candidates = [readSafely(entry.restoreFocus) || null, entry.previousFocus];
      const restored = candidates.some(target => isUsableFocusTarget(target)
        && (!top || top.dialog.contains(target)) && focusSafely(target));
      if (!restored) { if (top) focusModal(top); else focusApplication(document); }
    }
  };
}

export function isBackdropRelease(startedOnBackdrop: boolean, endedOnBackdrop: boolean): boolean {
  return startedOnBackdrop && endedOnBackdrop;
}
