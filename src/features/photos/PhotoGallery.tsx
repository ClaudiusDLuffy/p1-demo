"use client";
// @ts-nocheck

import { useState, useEffect } from "react";
import { Ico } from "../../components/ui/Ico";
import { BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { T } from "../../lib/constants";
import { getPhotoUrl } from "../../lib/db";

export default function PhotoGallery({ woId, photos = [], totalCount, hasMore = false, onLoadMore, loadingMore = false, setImageErrors, setLightbox, doAddPhotos, doRemovePhoto, loadingStates = {} }: any) {
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [downloadingPath, setDownloadingPath] = useState<string | null>(null);
  const adding = !!loadingStates["addPhotos_" + woId];
  const removing = !!loadingStates["removePhoto_" + woId];

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
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Photos{Number(totalCount ?? photos?.length ?? 0) > 0 ? ` (${Number(totalCount ?? photos.length)})` : ""}</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
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
                              {resolving && <div style={{ textAlign: "center", padding: "12px 0", fontSize: 12, color: T.subtle }}>Loading photos...</div>}
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(110px, 1fr))", gap: 8 }}>
                                {photos.map((path: string, i: number) => {
                                  const url = signedUrls[path];
                                  return (
                                    <div key={path || i} style={{ position: "relative", aspectRatio: "1", borderRadius: 10, overflow: "hidden", border: `1px solid ${T.border}`, cursor: url ? "pointer" : "default" }} onClick={() => { if (url) setLightbox(url); }}>
                                      {url
                                        ? <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} onError={() => setImageErrors((prev: any) => ({ ...prev, [path]: true }))} />
                                        : <div style={{ width: "100%", height: "100%", background: T.surfaceSoft, color: T.subtle, fontSize: 11, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", padding: 8 }}>Photo unavailable</div>}
                                      {url && (
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
                                      <button disabled={removing} onClick={e => { e.stopPropagation(); doRemovePhoto(woId, path); }} style={{ position: "absolute", top: 4, right: 4, width: 36, height: 36, borderRadius: "50%", background: "rgba(31,30,28,0.8)", border: "none", color: "#fff", fontSize: 16, cursor: removing ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", opacity: removing ? 0.7 : 1, zIndex: 2 }}>{removing ? "..." : "x"}</button>
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
