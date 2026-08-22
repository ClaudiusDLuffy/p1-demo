"use client";

import {
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Ico } from "../../components/ui/Ico";
import { BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { T } from "../../lib/constants";
import {
  getPhotoUrl,
  loadAllWorkOrderPhotoPaths,
  loadPhotoBlob,
} from "../../lib/db";

type PhotoGalleryProps = {
  woId: string;
  photos?: string[];
  totalCount?: number | null;
  hasMore?: boolean;
  onLoadMore?: () => void | Promise<void>;
  loadingMore?: boolean;
  imageErrors?: Record<string, boolean>;
  setImageErrors: Dispatch<SetStateAction<Record<string, boolean>>>;
  setLightbox: (url: string) => void;
  doAddPhotos: (workOrderId: string, files: FileList | null) => void | Promise<unknown>;
  doRemovePhoto: (workOrderId: string, path: string) => void | Promise<unknown>;
  fire?: (message: string) => void;
  loadingStates?: Record<string, boolean>;
};

export default function PhotoGallery({ woId, photos = [], totalCount, hasMore = false, onLoadMore, loadingMore = false, setImageErrors, setLightbox, doAddPhotos, doRemovePhoto, fire, loadingStates = {} }: PhotoGalleryProps) {
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [archiveProgress, setArchiveProgress] = useState<{
    mode: "all" | "selected";
    completed: number;
    total: number;
  } | null>(null);
  const [archiveError, setArchiveError] = useState("");
  const adding = !!loadingStates["addPhotos_" + woId];
  const removing = !!loadingStates["removePhoto_" + woId];
  const archiveBusy = archiveProgress !== null;
  const photoCount = Math.max(photos.length, Number(totalCount || 0));

  useEffect(() => {
    setSelectedPaths(previous => {
      const available = new Set(photos);
      const next = new Set([...previous].filter(path => available.has(path)));
      return next.size === previous.size ? previous : next;
    });
  }, [photos]);

  const toggleSelected = (path: string) => {
    setSelectedPaths(previous => {
      const next = new Set(previous);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  const finishSelecting = () => {
    setSelecting(false);
    setSelectedPaths(new Set());
    setArchiveError("");
  };

  const downloadArchive = async (mode: "all" | "selected") => {
    if (archiveBusy) return;
    const selected = [...selectedPaths];
    if (mode === "selected" && selected.length === 0) {
      setArchiveError("Select at least one photo to download.");
      return;
    }

    setArchiveError("");
    setArchiveProgress({ mode, completed: 0, total: 0 });
    let objectUrl: string | null = null;
    try {
      const paths = mode === "all"
        ? await loadAllWorkOrderPhotoPaths(woId)
        : selected;
      if (paths.length === 0) throw new Error("There are no photos to download");

      setArchiveProgress({ mode, completed: 0, total: paths.length });
      const { buildPhotoArchive, photoArchiveFilename } = await import("../../lib/photoArchive");
      const result = await buildPhotoArchive(
        paths,
        loadPhotoBlob,
        progress => setArchiveProgress({ mode, ...progress }),
      );
      const archiveBytes = new Uint8Array(result.archive.byteLength);
      archiveBytes.set(result.archive);
      objectUrl = URL.createObjectURL(new Blob([archiveBytes.buffer], { type: "application/zip" }));
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = photoArchiveFilename(woId);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();

      const skipped = result.skippedCount > 0
        ? ` ${result.skippedCount} unavailable photo${result.skippedCount === 1 ? " was" : "s were"} skipped.`
        : "";
      fire?.(`Downloaded ${result.downloadedCount} photo${result.downloadedCount === 1 ? "" : "s"}.${skipped}`);
      if (mode === "selected") finishSelecting();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Photo download failed";
      setArchiveError(message);
      fire?.(`Photo download failed: ${message}`);
    } finally {
      if (objectUrl) {
        const completedObjectUrl = objectUrl;
        window.setTimeout(() => URL.revokeObjectURL(completedObjectUrl), 0);
      }
      setArchiveProgress(null);
    }
  };

  const downloadPhoto = async (path: string, url: string, index: number) => {
    if (!url || downloadingPath) return;
    setDownloadingPath(path);
    const extension = String(path).split("?")[0].match(/\.([a-z0-9]{2,5})$/i)?.[1] || "jpg";
    const filename = `${woId}-photo-${index + 1}.${extension}`;
    let objectUrl: string | null = null;

    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Photo download failed (${response.status})`);
      objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setDownloadingPath(null);
    }
  };

  useEffect(() => {
    if (!expanded || photos.length === 0) return;
    let mounted = true;
    const objectUrls: string[] = [];
    setResolving(true);
    const resolve = async () => {
      const urls: Record<string, string> = {};
      await Promise.all(
        photos.map(async (path: string) => {
          if (path.startsWith("http") || path.startsWith("data:")) {
            urls[path] = path;
            return;
          }
          try {
            const url = await getPhotoUrl(path);
            if (url) {
              urls[path] = url;
              if (url.startsWith("blob:")) objectUrls.push(url);
            }
          } catch {
            // Missing storage objects render as placeholders below.
          }
        })
      );
      if (mounted) {
        setSignedUrls(urls);
        setResolving(false);
      } else {
        for (const url of objectUrls) URL.revokeObjectURL(url);
      }
    };
    resolve();
    return () => {
      mounted = false;
      for (const url of objectUrls) URL.revokeObjectURL(url);
    };
  }, [expanded, photos]);

  return (
    <>
                    {/* Photos */}
                    <div className="card" style={{ padding: 22, marginBottom: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Photos{photoCount > 0 ? ` (${photoCount})` : ""}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          {photoCount > 0 && (
                            <button
                              type="button"
                              className="btn-soft"
                              disabled={archiveBusy}
                              onClick={() => void downloadArchive("all")}
                              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px", opacity: archiveBusy ? 0.7 : 1 }}
                            >
                              <Ico d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" size={13} />
                              {archiveBusy && archiveProgress?.mode === "all" ? "Preparing..." : "Download all"}
                            </button>
                          )}
                          {photoCount > 1 && !selecting && (
                            <button
                              type="button"
                              className="btn-soft"
                              disabled={archiveBusy}
                              onClick={() => {
                                setExpanded(true);
                                setSelecting(true);
                                setArchiveError("");
                              }}
                              style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "8px 12px" }}
                            >
                              <Ico d="M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" size={13} />
                              Select
                            </button>
                          )}
                          <label className="btn-soft" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: adding ? "default" : "pointer", padding: "8px 12px", opacity: adding ? 0.7 : 1 }}>
                            <Ico d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 13a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" size={13} />
                            {adding ? <><BtnSpinnerDark />Uploading...</> : "Take photo"}
                            <input type="file" accept="image/*" capture="environment" disabled={adding} style={{ display: "none" }} onChange={e => { if (adding) return; doAddPhotos(woId, e.target.files); e.target.value = ""; }} />
                          </label>
                          <label className="btn-soft" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: adding ? "default" : "pointer", padding: "8px 12px", opacity: adding ? 0.7 : 1 }}>
                            <Ico d="M4 5h16v14H4zM4 15l4-4 4 4 2-2 6 6M15 9h.01" size={13} />
                            Choose photos
                            <input type="file" accept="image/*" multiple disabled={adding} style={{ display: "none" }} onChange={e => { if (adding) return; doAddPhotos(woId, e.target.files); e.target.value = ""; }} />
                          </label>
                        </div>
                      </div>
                      {(photos || []).length === 0
                        ? <div style={{ textAlign: "center", padding: "28px 0", fontSize: 12, color: T.subtle, background: T.surfaceSoft, borderRadius: 10, border: `1px dashed ${T.border}` }}>No photos yet. Add site pics, asset tags, part numbers, completed work.</div>
                        : !expanded
                          ? <button onClick={() => setExpanded(true)} className="btn-soft" style={{ width: "100%", justifyContent: "center" }}>View photos ({photos.length} loaded{Number(totalCount || 0) > photos.length ? ` of ${totalCount}` : ""})</button>
                          : (
                            <>
                              {selecting && (
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", padding: "10px 12px", marginBottom: 12, borderRadius: 10, border: `1px solid ${T.border}`, background: T.surfaceSoft }}>
                                  <div style={{ fontSize: 11, color: T.muted, fontWeight: 700 }}>
                                    {selectedPaths.size} selected
                                  </div>
                                  <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
                                    <button
                                      type="button"
                                      className="btn-soft"
                                      disabled={archiveBusy}
                                      onClick={() => setSelectedPaths(
                                        selectedPaths.size === photos.length
                                          ? new Set()
                                          : new Set(photos),
                                      )}
                                      style={{ padding: "7px 10px", fontSize: 10 }}
                                    >{selectedPaths.size === photos.length ? "Clear loaded" : "Select loaded"}</button>
                                    <button
                                      type="button"
                                      className="btn-primary"
                                      disabled={archiveBusy || selectedPaths.size === 0}
                                      onClick={() => void downloadArchive("selected")}
                                      style={{ padding: "7px 10px", fontSize: 10, opacity: archiveBusy || selectedPaths.size === 0 ? 0.6 : 1 }}
                                    >{archiveBusy && archiveProgress?.mode === "selected" ? "Preparing..." : `Download selected (${selectedPaths.size})`}</button>
                                    <button type="button" className="btn-soft" disabled={archiveBusy} onClick={finishSelecting} style={{ padding: "7px 10px", fontSize: 10 }}>Done</button>
                                  </div>
                                </div>
                              )}
                              {archiveProgress && (
                                <div role="status" style={{ textAlign: "center", padding: "9px 0", fontSize: 11, color: T.muted }}>
                                  {archiveProgress.total > 0
                                    ? `Preparing photo ${archiveProgress.completed} of ${archiveProgress.total}...`
                                    : "Loading the complete photo list..."}
                                </div>
                              )}
                              {archiveError && (
                                <div role="alert" style={{ marginBottom: 12, padding: "9px 11px", borderRadius: 9, background: T.dangerSoft, color: T.danger, fontSize: 11 }}>
                                  {archiveError}
                                </div>
                              )}
                              {resolving && <div style={{ textAlign: "center", padding: "12px 0", fontSize: 12, color: T.subtle }}>Loading photos...</div>}
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8 }}>
                                {photos.map((path: string, i: number) => {
                                  const url = signedUrls[path];
                                  const selected = selectedPaths.has(path);
                                  return (
                                    <div
                                      key={path || i}
                                      role={url ? "button" : undefined}
                                      tabIndex={url ? 0 : undefined}
                                      aria-pressed={selecting ? selected : undefined}
                                      style={{ position: "relative", aspectRatio: "1", borderRadius: 10, overflow: "hidden", border: `2px solid ${selected ? T.accent : T.border}`, cursor: url ? "pointer" : "default" }}
                                      onClick={() => {
                                        if (!url) return;
                                        if (selecting) toggleSelected(path);
                                        else setLightbox(url);
                                      }}
                                      onKeyDown={(event) => {
                                        if (!url || (event.key !== "Enter" && event.key !== " ")) return;
                                        event.preventDefault();
                                        if (selecting) toggleSelected(path);
                                        else setLightbox(url);
                                      }}
                                    >
                                      {url
                                        ? (
                                          // Authenticated blob URLs cannot use the Next image optimizer.
                                          // eslint-disable-next-line @next/next/no-img-element
                                          <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} onError={() => setImageErrors(previous => ({ ...previous, [path]: true }))} />
                                        )
                                        : <div style={{ width: "100%", height: "100%", background: T.surfaceSoft, color: T.subtle, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 8 }}>Photo unavailable</div>}
                                      {url && selecting && (
                                        <div
                                          aria-hidden="true"
                                          style={{ position: "absolute", top: 5, left: 5, width: 30, height: 30, borderRadius: "50%", background: selected ? T.accent : "rgba(31,30,28,0.8)", border: "2px solid #fff", color: "#fff", display: "grid", placeItems: "center", zIndex: 2 }}
                                        >{selected ? <Ico d="M20 6L9 17l-5-5" size={15} color="currentColor" /> : null}</div>
                                      )}
                                      {url && !selecting && (
                                        <button
                                          type="button"
                                          disabled={downloadingPath === path}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            void downloadPhoto(path, url, i);
                                          }}
                                          title="Download photo"
                                          aria-label={`Download photo ${i + 1}`}
                                          style={{
                                            position: "absolute",
                                            top: 4,
                                            left: 4,
                                            width: 34,
                                            height: 34,
                                            borderRadius: "50%",
                                            background: "rgba(31,30,28,0.8)",
                                            border: "none",
                                            color: "#fff",
                                            cursor: downloadingPath === path ? "default" : "pointer",
                                            display: "grid",
                                            placeItems: "center",
                                            opacity: downloadingPath === path ? 0.7 : 1,
                                            zIndex: 2,
                                          }}
                                        >
                                          {downloadingPath === path
                                            ? <span style={{ fontSize: 11 }}>...</span>
                                            : <Ico d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" size={15} color="currentColor" />}
                                        </button>
                                      )}
                                      {!selecting && <button disabled={removing} onClick={e => { e.stopPropagation(); doRemovePhoto(woId, path); }} style={{ position: "absolute", top: 4, right: 4, width: 36, height: 36, borderRadius: "50%", background: "rgba(31,30,28,0.8)", border: "none", color: "#fff", fontSize: 16, cursor: removing ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", opacity: removing ? 0.7 : 1, zIndex: 2 }}>{removing ? "..." : "x"}</button>}
                                    </div>
                                  );
                                })}
                              </div>
                              {hasMore && (
                                <button
                                  type="button"
                                  className="btn-soft"
                                  disabled={loadingMore}
                                  onClick={() => onLoadMore?.()}
                                  style={{ width: "100%", justifyContent: "center", marginTop: 12 }}
                                >{loadingMore ? <><BtnSpinnerDark />Loading photos...</> : `Load more photos (${photos.length} of ${totalCount || "many"})`}</button>
                              )}
                            </>
                          )}
                    </div>


    </>
  );
}
