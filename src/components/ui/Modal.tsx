"use client";

import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { T } from "../../lib/constants";
import type { ModalDismissReason } from "../../lib/forms/dismissal";
import { isBackdropRelease, isTopModal, registerModal } from "../../lib/forms/modalRuntime";
export { requestTopModalClose } from "../../lib/forms/modalRuntime";
export type { ModalDismissReason } from "../../lib/forms/dismissal";

export type ModalProps = {
  open?: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  width?: number | string;
  contentStyle?: CSSProperties;
  closeLabel?: string;
  closeOnEscape?: boolean;
  closeOnBackdrop?: boolean;
  dismissDisabled?: boolean;
  onRequestClose?: (reason: ModalDismissReason) => void;
  onClose?: () => void;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocusRef?: RefObject<HTMLElement | null>;
};
const ModalPortalContext = createContext<HTMLElement | null>(null);
export const useModalPortalHost = () => useContext(ModalPortalContext);
export function ModalPortal({ children }: { children: ReactNode }) {
  const host = useModalPortalHost();
  return host ? createPortal(children, host) : children;
}

export function Modal(props: ModalProps) {
  return props.open === false ? null : <ModalInstance {...props} />;
}
function ModalInstance({ open = true, title, description, children, width = 480, closeLabel = "Close dialog",
  closeOnEscape = true, closeOnBackdrop = true, dismissDisabled = false, onRequestClose, onClose,
  initialFocusRef, restoreFocusRef, contentStyle }: ModalProps) {
  const titleId = useId();
  const descriptionId = `${titleId}-description`;
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [layerHost, setLayerHost] = useState<HTMLDivElement | null>(null);
  const startedOnBackdrop = useRef(false);
  const callbacks = useRef({ onRequestClose, onClose, closeOnEscape, closeOnBackdrop, dismissDisabled, initialFocusRef, restoreFocusRef });
  // Busy/identity changes must be observed before a passive effect can run.
  useLayoutEffect(() => { callbacks.current = { onRequestClose, onClose, closeOnEscape, closeOnBackdrop, dismissDisabled, initialFocusRef, restoreFocusRef }; });
  const missingTitle = title == null || typeof title === "boolean" || (typeof title === "string" && !title.trim());
  const safeTitle = missingTitle ? "Dialog" : title;
  const safeCloseLabel = closeLabel.trim() || "Close dialog";
  useEffect(() => {
    const emptyHeading = heading.current !== null && !heading.current.textContent?.trim();
    if (process.env.NODE_ENV !== "production" && (missingTitle || emptyHeading || !closeLabel.trim())) {
      console.warn("Modal requires a non-empty accessible title and close label.");
    }
    // A rich title component can render no text. Keep that runtime case named
    // without logging its contents or replacing the caller's visual content.
    if (emptyHeading) { dialog.current?.setAttribute("aria-label", "Dialog"); dialog.current?.removeAttribute("aria-labelledby"); }
    else { dialog.current?.removeAttribute("aria-label"); dialog.current?.setAttribute("aria-labelledby", titleId); }
  });
  const request = useCallback((reason: ModalDismissReason) => {
    const current = callbacks.current;
    if (current.dismissDisabled || (reason === "escape" && !current.closeOnEscape) || (reason === "backdrop" && !current.closeOnBackdrop)) return;
    if (current.onRequestClose) current.onRequestClose(reason);
    else current.onClose?.();
  }, []);
  const mountHost = useCallback((anchor: HTMLSpanElement | null) => {
    if (!anchor) return;
    const element = anchor.ownerDocument.createElement("div");
    element.dataset.modalHost = "true";
    anchor.ownerDocument.body.appendChild(element);
    setHost(element);
    return () => { element.remove(); };
  }, []);
  useEffect(() => {
    const element = dialog.current;
    if (!open || !host || !element || !host.isConnected) return;
    return registerModal({ dialog: element, host, requestClose: request,
      initialFocus: () => callbacks.current.initialFocusRef?.current || null,
      restoreFocus: () => callbacks.current.restoreFocusRef?.current || null });
  }, [open, host, request]);
  return <><span hidden ref={mountHost} data-modal-anchor="true" />{host && createPortal(<dialog ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}
    aria-describedby={description ? descriptionId : undefined} aria-busy={dismissDisabled || undefined}
    tabIndex={-1} className="modal-overlay"
    onCancel={event => { event.preventDefault(); if (dialog.current && isTopModal(dialog.current)) request("escape"); }}
    onPointerDown={event => { startedOnBackdrop.current = event.target === event.currentTarget; }}
    onPointerUp={event => {
      const dismiss = isBackdropRelease(startedOnBackdrop.current, event.target === event.currentTarget);
      startedOnBackdrop.current = false;
      if (dismiss && dialog.current && isTopModal(dialog.current)) request("backdrop");
    }}
    onPointerCancel={() => { startedOnBackdrop.current = false; }}
    style={{ position: "fixed", inset: 0, margin: 0, border: 0, width: "100%", height: "100%", maxWidth: "none", maxHeight: "none", background: "rgba(31,30,28,0.45)", backdropFilter: "blur(4px)", alignItems: "center", justifyContent: "center", zIndex: 50, padding: 16, boxSizing: "border-box" }}>
    <style>{`.modal-overlay[open]{display:flex}.modal-overlay::backdrop{background:transparent}.modal-overlay :focus-visible{outline:3px solid ${T.accent};outline-offset:3px}@media(prefers-reduced-motion:reduce){.modal-inner{animation:none!important}}`}</style>
    <div className="modal-inner" style={{ background: T.surface, borderRadius: 20, width: "90%", maxWidth: width, padding: 28, animation: "fadeUp 0.25s", boxShadow: "0 20px 60px rgba(31,30,28,0.22)", maxHeight: "90vh", overflowY: "auto", overflowX: "hidden", overscrollBehavior: "contain", border: `1px solid ${T.borderSoft}`, ...contentStyle }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <h2 ref={heading} id={titleId} className="display" style={{ fontSize: 22, fontWeight: "inherit", margin: 0, color: T.ink }}>{safeTitle}</h2>
        <button type="button" className="modal-close" aria-label={safeCloseLabel} disabled={dismissDisabled} onClick={() => request("close_button")} style={{ width: 44, height: 44, borderRadius: "50%", border: `1px solid ${T.border}`, background: T.bgWarm, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", fontSize: 18, color: T.muted, flexShrink: 0 }}><span aria-hidden="true">x</span></button>
      </div>
      {description && <div id={descriptionId}>{description}</div>}
      <ModalPortalContext.Provider value={layerHost}>{children}</ModalPortalContext.Provider>
    </div>
    <div ref={setLayerHost} data-modal-owned-layer="true" />
  </dialog>, host)}</>;
}
