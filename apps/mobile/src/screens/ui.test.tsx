import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react-native";
import { capabilityHome } from "../navigation/capabilityRoute";
import { SignInScreen } from "./SignInScreen";
import { JobsScreen } from "./JobsScreen";
import { WorkOrderDetailScreen } from "./WorkOrderDetailScreen";
import { AccountScreen } from "./AccountScreen";
import { StatePanel } from "../components/StatePanel";

const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock("expo-router", () => ({
  Link: ({ children }: { children: React.ReactNode }) => jest.requireActual<typeof import("react")>("react").createElement(jest.requireActual<typeof import("react-native")>("react-native").Text, null, children),
  router: { push: mockPush, replace: mockReplace },
  useLocalSearchParams: () => ({ id: "WOT000001" }),
}));
const mockSignIn = jest.fn();
const mockSignOut = jest.fn();
jest.mock("../auth/AuthProvider", () => ({ useAuth: () => ({
  status: "active", session: null,
  profile: { userId: "00000000-0000-4000-8000-000000000001", name: "Synthetic User",
    email: "user@example.invalid", role: "contractor", active: true, capability: "technician",
    contractorAccountId: "00000000-0000-4000-8000-000000000002",
    organizationId: "00000000-0000-4000-8000-000000000003", organizationName: "Synthetic Company",
    accessLevel: "report_only" },
  message: null, signIn: mockSignIn, signOut: mockSignOut,
  requestPasswordReset: jest.fn(), updatePassword: jest.fn(),
}) }));
let mockOffline = false;
jest.mock("@react-native-community/netinfo", () => ({
  useNetInfo: () => ({ isConnected: !mockOffline, isInternetReachable: !mockOffline }),
}));
const emptyPage = { pages: [{ items: [], nextCursor: null, hasMore: false, totalCount: null }] };
let mockWorkOrders: Record<string, unknown>;
let mockWorkOrder: Record<string, unknown>;
let mockActivity: Record<string, unknown>;
let mockVisits: Record<string, unknown>;
let mockPhotos: Record<string, unknown>;
jest.mock("../data/queries", () => ({
  useWorkOrders: () => mockWorkOrders,
  useWorkOrder: () => mockWorkOrder,
  useActivity: () => mockActivity,
  useVisits: () => mockVisits,
  usePhotos: () => mockPhotos,
}));
jest.mock("../components/PrivatePhoto", () => ({ PrivatePhoto: () => null }));
jest.mock("../data/environment", () => ({ getMobileEnvironment: () => ({
  EXPO_PUBLIC_RELEASE_SHA: "abcdef1", EXPO_PUBLIC_P1_APP_ENV: "preview",
}) }));

const workOrder = { id: "WOT000001", externalWorkOrderId: "WOT000001", status: "assigned", priority: "p1",
  functionalStatus: "Dispatched", storeNumber: "100", city: "Test City", address: "100 Test Ave",
  state: "TX", postalCode: "00000", summary: "Synthetic service", description: "Synthetic description",
  contractorId: "00000000-0000-4000-8000-000000000002", technicianName: "Synthetic Tech",
  technicianProfileId: "00000000-0000-4000-8000-000000000001", assignmentVersion: 3,
  lifecycleVersion: 4, partsTotal: 2, partsReceived: 1, createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z", dispatchedAt: null, slaStartedAt: null,
  responseBreachAt: null, resolutionBreachAt: null, nte: 100, partNeeded: "Synthetic part", partEta: null };

beforeEach(() => {
  jest.clearAllMocks(); mockOffline = false;
  mockWorkOrders = { data: emptyPage, isPending: false, isError: false, isRefetching: false,
    refetch: jest.fn(), hasNextPage: false, isFetchingNextPage: false, fetchNextPage: jest.fn(), dataUpdatedAt: Date.now() };
  mockWorkOrder = { data: workOrder, isPending: false, isError: false, refetch: jest.fn() };
  const section = { data: emptyPage, isPending: false, hasNextPage: false, isFetchingNextPage: false, fetchNextPage: jest.fn() };
  mockActivity = section; mockVisits = section; mockPhotos = section;
});

describe("Phase 1 native UI", () => {
  it("renders accessible loading and recoverable error states", async () => {
    const view = await render(<StatePanel title="Loading assigned work" busy />);
    expect(screen.getByLabelText("Loading")).toBeTruthy();
    await view.rerender(<StatePanel title="Unable to load work" actionLabel="Retry" onAction={jest.fn()} />);
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
  it("signs in and maps credential failures without exposing provider detail", async () => {
    mockSignIn.mockRejectedValueOnce({ message: "private provider detail" });
    await render(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText("Email"), "user@example.invalid");
    await fireEvent.changeText(screen.getByLabelText("Password"), "synthetic-password");
    await fireEvent.press(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(mockSignIn).toHaveBeenCalledWith("user@example.invalid", "synthetic-password"));
    expect(await screen.findByText("The request could not be completed.")).toBeTruthy();
  });
  it("shows empty and offline queue states", async () => {
    mockOffline = true;
    await render(<JobsScreen title="My Jobs" />);
    expect(screen.getByText("My Jobs")).toBeTruthy();
    expect(screen.getByText("Offline - showing previously loaded work")).toBeTruthy();
    expect(screen.getByText("No current work orders")).toBeTruthy();
  });
  it("renders queue rows and invokes bounded continuation", async () => {
    const next = jest.fn();
    mockWorkOrders = { ...mockWorkOrders, data: { pages: [{ ...emptyPage.pages[0], items: [workOrder],
      nextCursor: "opaque", hasMore: true }] }, hasNextPage: true, fetchNextPage: next };
    await render(<JobsScreen title="Company Queue" />);
    expect(screen.getByLabelText(/Open work order WOT000001/)).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Load more work orders" }));
    expect(next).toHaveBeenCalledTimes(1);
  });
  it("routes supported capabilities and rejects unknown workflows", async () => {
    expect(capabilityHome("technician")).toBe("/jobs");
    expect(capabilityHome("company_admin")).toBe("/company");
    expect(capabilityHome("unsupported")).toBe("/unsupported-role");
  });
  it("renders the complete read-only work-order detail sections", async () => {
    await render(<WorkOrderDetailScreen />);
    for (const label of ["WOT000001", "Location", "Service", "Parts summary", "Activity", "Visits", "Photos"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText("1 of 2 received")).toBeTruthy();
    expect(screen.queryByText(/Upload|Delete photo|Start visit|Complete work/)).toBeNull();
  });
  it("renders forbidden detail state without stale content", async () => {
    mockWorkOrder = { data: workOrder, isPending: false, isError: true, error: { code: "forbidden" }, refetch: jest.fn() };
    await render(<WorkOrderDetailScreen />);
    expect(screen.getByText("Access denied")).toBeTruthy();
    expect(screen.queryByText("Synthetic service")).toBeNull();
  });
  it("removes cached queue rows when refreshed authorization is denied", async () => {
    mockWorkOrders = { ...mockWorkOrders, data: { pages: [{ ...emptyPage.pages[0], items: [workOrder] }] },
      isError: true, error: { code: "forbidden" } };
    await render(<JobsScreen title="My Jobs" />);
    expect(screen.getByText("Access denied")).toBeTruthy();
    expect(screen.queryByText("WOT000001")).toBeNull();
  });
  it("shows account release context and performs logout", async () => {
    await render(<AccountScreen />);
    expect(screen.getByText("Release: abcdef1")).toBeTruthy();
    expect(screen.getByText("Access: technician")).toBeTruthy();
    await fireEvent.press(screen.getByRole("button", { name: "Log out" }));
    expect(mockSignOut).toHaveBeenCalledTimes(1);
  });
});
