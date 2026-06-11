"use client";
// @ts-nocheck

import { useState, useEffect } from "react";
import { Ico } from "../../components/ui/Ico";
import { BtnSpinnerDark } from "../../components/ui/BtnSpinner";
import { T } from "../../lib/constants";
import { getPhotoUrl } from "../../lib/db";

export default function PhotoGallery({ woId, photos = [], imageErrors, setImageErrors, setLightbox, doAddPhotos, doRemovePhoto, loadingStates = {} }: any) {
  const [signedUrls, setSignedUrls] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState(false);
  const [resolving, setResolving] = useState(false);
  const adding = !!loadingStates["addPhotos_" + woId];
  const removing = !!loadingStates["removePhoto_" + woId];

  useEffect(() => {
    if (!expanded || photos.length === 0) return;
    let mounted = true;
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
            if (url) urls[path] = url;
          } catch {
            // Missing storage objects render as placeholders below.
          }
        })
      );
      if (mounted) {
        setSignedUrls(urls);
        setResolving(false);
      }
    };
    resolve();
    return () => { mounted = false; };
  }, [expanded, photos]);

  return (
    <>
                    {/* Photos */}
                    <div className="card" style={{ padding: 22, marginBottom: 16 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                        <div style={{ fontSize: 14, fontWeight: 700, color: T.ink }}>Photos{(photos?.length || 0) > 0 ? ` (${photos.length})` : ""}</div>
                        <label className="btn-soft" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: adding ? "default" : "pointer", padding: "8px 14px", opacity: adding ? 0.7 : 1 }}>
                          <Ico d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2zM12 13a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" size={13} />
                          {adding ? <><BtnSpinnerDark />Uploading...</> : "Add photos"}
                          <input type="file" accept="image/*" multiple capture="environment" disabled={adding} style={{ display: "none" }} onChange={e => { if (adding) return; doAddPhotos(woId, e.target.files); e.target.value = ""; }} />
                        </label>
                      </div>
                      {(photos || []).length === 0
                        ? <div style={{ textAlign: "center", padding: "28px 0", fontSize: 12, color: T.subtle, background: T.surfaceSoft, borderRadius: 10, border: `1px dashed ${T.border}` }}>No photos yet. Add site pics, asset tags, part numbers, completed work.</div>
                        : !expanded
                          ? <button onClick={() => setExpanded(true)} className="btn-soft" style={{ width: "100%", justifyContent: "center" }}>View {photos.length} photo{photos.length !== 1 ? "s" : ""}</button>
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
                                      <button disabled={removing} onClick={e => { e.stopPropagation(); doRemovePhoto(woId, path); }} style={{ position: "absolute", top: 4, right: 4, width: 22, height: 22, borderRadius: "50%", background: "rgba(31,30,28,0.8)", border: "none", color: "#fff", fontSize: 12, cursor: removing ? "default" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", opacity: removing ? 0.7 : 1 }}>{removing ? "..." : "x"}</button>
                                    </div>
                                  );
                                })}
                              </div>
                            </>
                          )}
                    </div>


    </>
  );
}
