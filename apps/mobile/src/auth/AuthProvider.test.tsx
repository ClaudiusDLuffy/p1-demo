import React from "react";
import { Pressable, Text } from "react-native";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { AuthProvider, useAuth } from "./AuthProvider";
import { CACHE_PREFIX } from "../storage/readCache";

jest.mock("expo-linking", () => ({
  addEventListener: () => ({ remove: jest.fn() }), getInitialURL: async () => null,
}));
jest.mock("../data/privatePhotos", () => ({ purgePhotoFiles: jest.fn(async () => undefined) }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const session = (userId: string) => ({ access_token: "synthetic-access", refresh_token: "synthetic-refresh",
  expires_in: 3600, token_type: "bearer", user: { id: userId } }) as unknown as Session;
const scope = { contractorAccountId: id(2), organizationId: id(3), organizationName: "Synthetic Company",
  accessLevel: "report_only", canInvoice: false, canManageTeam: false };

function fakeClient(options: { restored?: Session | null; verified?: boolean; profile?: unknown; signIn?: Session | null }) {
  let listener: ((event: string, session: Session | null) => void) | undefined;
  const signOut = jest.fn(async () => ({ error: null }));
  const auth = {
    startAutoRefresh: jest.fn(), stopAutoRefresh: jest.fn(),
    getSession: jest.fn(async () => ({ data: { session: options.restored ?? null }, error: null })),
    getUser: jest.fn(async () => options.verified === false
      ? ({ data: { user: null }, error: { message: "revoked" } })
      : ({ data: { user: options.restored?.user ?? null }, error: null })),
    onAuthStateChange: jest.fn((callback: typeof listener) => { listener = callback; return { data: { subscription: { unsubscribe: jest.fn() } } }; }),
    signInWithPassword: jest.fn(async () => options.signIn
      ? ({ data: { session: options.signIn }, error: null })
      : ({ data: { session: null }, error: { message: "provider detail" } })),
    signOut, resetPasswordForEmail: jest.fn(async () => ({ error: null })),
    updateUser: jest.fn(async () => ({ error: null })),
    setSession: jest.fn(async () => ({ error: null })),
  };
  const profile = options.profile;
  const client = {
    auth,
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: profile, error: null }) }) }) }),
    rpc: async () => ({ data: scope, error: null }),
  } as unknown as SupabaseClient;
  return { client, auth, emit: (event: string, next: Session | null) => listener?.(event, next) };
}
function Probe() {
  const auth = useAuth();
  return <><Text>{auth.status}</Text><Text>{auth.profile?.userId ?? "no-user"}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="test sign in"
      onPress={() => void auth.signIn("user@example.invalid", "password").catch(() => undefined)}><Text>Sign in</Text></Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel="test logout" onPress={() => void auth.signOut()}><Text>Logout</Text></Pressable></>;
}
const profile = { id: id(1), role: "contractor", active: true, name: "Synthetic", email: "user@example.invalid" };

describe("auth provider lifecycle", () => {
  beforeEach(async () => { await AsyncStorage.clear(); });
  it("restores and verifies an active session before rendering profile data", async () => {
    const fake = fakeClient({ restored: session(id(1)), profile });
    await render(<AuthProvider client={fake.client}><Probe /></AuthProvider>);
    expect(await screen.findByText("active")).toBeTruthy();
    expect(screen.getByText(id(1))).toBeTruthy();
  });
  it("fails an expired or revoked restored session back to signed out", async () => {
    const fake = fakeClient({ restored: session(id(1)), verified: false, profile });
    await render(<AuthProvider client={fake.client}><Probe /></AuthProvider>);
    expect(await screen.findByText("signed_out")).toBeTruthy();
    expect(fake.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
  it("denies missing and inactive profiles", async () => {
    const missing = fakeClient({ restored: session(id(1)), profile: null });
    const first = await render(<AuthProvider client={missing.client}><Probe /></AuthProvider>);
    expect(await screen.findByText("error")).toBeTruthy();
    await first.unmount();
    const inactive = fakeClient({ restored: session(id(1)), profile: { ...profile, active: false } });
    await render(<AuthProvider client={inactive.client}><Probe /></AuthProvider>);
    expect(await screen.findByText("inactive")).toBeTruthy();
  });
  it("routes unsupported authenticated roles without a queue capability", async () => {
    const fake = fakeClient({ restored: session(id(1)), profile: { ...profile, role: "manager" } });
    await render(<AuthProvider client={fake.client}><Probe /></AuthProvider>);
    expect(await screen.findByText("unsupported")).toBeTruthy();
  });
  it("handles sign-in success and generic failure", async () => {
    const success = fakeClient({ restored: null, signIn: session(id(1)), profile });
    const view = await render(<AuthProvider client={success.client}><Probe /></AuthProvider>);
    expect(await screen.findByText("signed_out")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "test sign in" }));
    expect(await screen.findByText("active")).toBeTruthy();
    await view.unmount();
    const failure = fakeClient({ restored: null, signIn: null, profile });
    await render(<AuthProvider client={failure.client}><Probe /></AuthProvider>);
    expect(await screen.findByText("signed_out")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "test sign in" }));
    await waitFor(() => expect(failure.auth.signInWithPassword).toHaveBeenCalledTimes(1));
    expect(screen.getByText("signed_out")).toBeTruthy();
  });
  it("purges cached user data before logout and account switch", async () => {
    await AsyncStorage.setItem(CACHE_PREFIX + "old-user", "cached");
    const fake = fakeClient({ restored: session(id(1)), profile });
    await render(<AuthProvider client={fake.client}><Probe /></AuthProvider>);
    expect(await screen.findByText("active")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "test logout" }));
    expect(await screen.findByText("signed_out")).toBeTruthy();
    expect(await AsyncStorage.getItem(CACHE_PREFIX + "old-user")).toBeNull();
  });
});
