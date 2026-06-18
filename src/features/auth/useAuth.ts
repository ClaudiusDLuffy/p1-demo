"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { signIn, signOut } from "../../lib/db";
import { supabase } from "../../lib/supabase/client";
import { DEMO_ACCOUNTS } from "../../lib/constants";

export async function changePassword(
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const sb = supabase();
  const { error } = await sb.auth.updateUser({ password: newPassword });
  if (error) return { success: false, error: error.message };
  return { success: true };
}

export default function useAuth({
  fire,
  setPage,
  setSelectedWO,
  setAiNote,
  setWorkOrders,
  setInvoices,
}: any) {
  const qc = useQueryClient();
  const [currentUser, setCurrentUser] = useState<any>(null);
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [fadeIn, setFadeIn] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const lastLoadedUserIdRef = useRef<string | null>(null);

  useEffect(() => { const t = setTimeout(() => setFadeIn(true), 50); return () => clearTimeout(t); }, []);

  const hydrateProfile = useCallback(async (userId: string) => {
    try {
      const sb = supabase();
      const { data: prof, error } = await sb
        .from("profiles").select("*").eq("id", userId).single();
      if (error) throw error;
      if (!prof) throw new Error("Profile not found for this account");
      if (lastLoadedUserIdRef.current === prof.id) return;
      lastLoadedUserIdRef.current = prof.id;
      const profAny = prof as any;
      setCurrentUser({
        id: prof.id, name: prof.name, email: prof.email, initials: prof.initials, role: prof.role,
        title: prof.title, company: prof.company, phone: prof.phone, territory: prof.territory,
        trades: prof.trades || [], color: prof.color,
        isDemo: DEMO_ACCOUNTS.some(d => d.email === prof.email),
        contractorTier: prof.contractor_tier || null,
        dispatcherId: prof.dispatcher_id || null,
        // Display cap for the WO NTE shown to this contractor. Mask applied
        // at the PortalShell boundary so this never reaches staff math or
        // the NTE-flag bucket. Falls back to 1000 pre-migration.
        contractorNteDisplay: profAny.contractor_nte_display != null ? Number(profAny.contractor_nte_display) : 1000,
        // Reserved for Phase 2 per-contractor rates — the invoice form no
        // longer reads these (rates start empty, Truck Charge defaults 60).
        defaultLaborRate: prof.default_labor_rate ?? null,
        defaultTruckRate: prof.default_truck_rate ?? null,
      });
      setPage(prof.role === "contractor" ? "my_jobs" : "dashboard");
    } catch (err: any) {
      setLoginError(err?.message || "Could not load your profile");
      if (fire) fire(err?.message || "Could not load your profile");
      throw err;
    } finally {
      setLoginLoading(false);
    }
  }, [fire, setPage]);

  // Real Supabase auth - replaces demo button login
  const doLogin = async (email: string, password: string) => {
    if (loginLoading) return;
    const v = (email || "").trim();
    if (!v) { setLoginError("Enter an email to sign in"); return; }
    setLoginError(null);
    setLoginLoading(true);
    try {
      // Clear any stale session before signing in fresh - guards against
      // wedged refresh tokens left over from a previous demo run.
      await signOut().catch(() => {});
      const data = await signIn(v, password);
      if (data?.user?.id) {
        setHasSession(true);
        await hydrateProfile(data.user.id);
      } else {
        setLoginLoading(false);
      }
    } catch (err: any) {
      setLoginError(err.message || "Sign in failed");
      setLoginLoading(false);
    }
  };
  const logout = async () => {
    await signOut();
    qc.clear();
    setHasSession(false);
    setCurrentUser(null);
    setPage("dashboard");
    setSelectedWO(null);
    setLoginEmail("");
    setAiNote(null);
  };

  // -- DATA LOADERS - fire when auth session is available ---------------
  // Single listener handles mount (INITIAL_SESSION), fresh logins (SIGNED_IN),
  // and logout (SIGNED_OUT). Profile fetch is deferred via setTimeout to
  // release the GoTrue internal lock - calling supabase-js methods directly
  // inside onAuthStateChange can deadlock and cause the spinner to hang.
  useEffect(() => {
    let mounted = true;

    const hydrate = (userId: string) => {
      setTimeout(async () => {
        if (!mounted) return;
        try {
          await hydrateProfile(userId);
        } catch (err: any) {
          if (!mounted) return;
          // hydrateProfile already surfaced the error.
        } finally {
          if (mounted) setLoginLoading(false);
        }
      }, 0);
    };

    const sb = supabase();
    const { data: { subscription } } = sb.auth.onAuthStateChange((event, session) => {
      if (!mounted) return;
      if ((event === "INITIAL_SESSION" || event === "SIGNED_IN" || event === "TOKEN_REFRESHED") && session?.user) {
        setHasSession(true);
        hydrate(session.user.id);
      } else if (event === "INITIAL_SESSION" && !session) {
        // No session on mount - make sure the spinner isn't left on.
        setHasSession(false);
        setLoginLoading(false);
      } else if (event === "SIGNED_OUT") {
        qc.clear();
        lastLoadedUserIdRef.current = null;
        setHasSession(false);
        setCurrentUser(null);
        setLoginLoading(false);
      }
    });
    return () => { mounted = false; subscription.unsubscribe(); };
  }, [hydrateProfile, qc]);

  return {
    currentUser, setCurrentUser, hasSession, loginEmail, setLoginEmail,
    loginPassword, setLoginPassword, loginLoading, loginError,
    fadeIn, doLogin, logout
  };
}
