export type PortalNavigationRole = "controller" | "manager" | "contractor";

export type PortalNavigationItem = {
  id: string;
  label: string;
  icon: string;
  badge?: number | null;
  attentionBadge?: number | null;
  beta?: boolean;
};

type PortalNavigationOptions = {
  invoiceController: boolean;
  isManager: boolean;
  canInvoice?: boolean;
  canLeadTeam?: boolean;
  canManageTeam?: boolean;
  counts: {
    capital: number | null;
    contractorActive: number | null;
    contractorAttention: number | null;
    contractorInvoice: number | null;
    history: number | null;
    open: number | null;
    pendingApproval: number | null;
    staffWork: number | null;
  };
};

const ICONS = {
  billing: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M9 13h6M9 17h6M9 9h1",
  capital: "M2 20h20M5 20V8l7-5 7 5v12M9 20v-4h6v4",
  contractors: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75",
  dashboard: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  history: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  invoices: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM14 2v6h6M8 13h8M8 17h8",
  preview: "M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z",
  schedule: "M4 5h16v16H4zM8 3v4M16 3v4M4 10h16",
  simplified: "M4 6h16M4 12h10M4 18h7",
  staffWork: "M9 11l3 3L22 4M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11",
  team: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 1 0 7.75",
  workOrders: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
} as const;

const BOTTOM_PAGE_IDS: Record<PortalNavigationRole, readonly string[]> = {
  controller: ["dashboard", "invoices"],
  manager: ["dashboard", "simplified", "work_orders", "invoices"],
  contractor: ["my_jobs", "my_schedule", "history", "invoices"],
};

export function portalNavigationRole(options: Pick<PortalNavigationOptions, "invoiceController" | "isManager">): PortalNavigationRole {
  if (options.invoiceController) return "controller";
  if (options.isManager) return "manager";
  return "contractor";
}

/** Restore only the two focused views; never trust a URL to grant a staff page. */
export function initialFocusedPortalPage(role: PortalNavigationRole, search: string): string {
  const requested = new URLSearchParams(search).get("portal");
  if (role !== "controller" && requested === "my_schedule") return requested;
  if (role === "manager" && requested === "simplified") return requested;
  return role === "contractor" ? "my_jobs" : "dashboard";
}

function controllerItems(): PortalNavigationItem[] {
  return [
    { id: "dashboard", label: "Controller", icon: ICONS.dashboard },
    { id: "invoices", label: "Contractor bills", icon: ICONS.invoices },
  ];
}

function managerItems(counts: PortalNavigationOptions["counts"]): PortalNavigationItem[] {
  return [
    { id: "dashboard", label: "Dashboard", icon: ICONS.dashboard },
    { id: "simplified", label: "Simplified", icon: ICONS.simplified },
    { id: "staff_work", label: "My Work", icon: ICONS.staffWork, badge: counts.staffWork },
    { id: "work_orders", label: "Work orders", icon: ICONS.workOrders, badge: counts.open },
    { id: "my_schedule", label: "My Schedule", icon: ICONS.schedule, beta: true },
    { id: "capital", label: "Capital", icon: ICONS.capital, badge: counts.capital },
    { id: "invoices", label: "Contractor bills", icon: ICONS.invoices, badge: counts.pendingApproval },
    { id: "billing", label: "7-Eleven billing", icon: ICONS.billing },
    { id: "contractors", label: "Contractors", icon: ICONS.contractors },
    { id: "contractor_preview", label: "Contractor view", icon: ICONS.preview },
    { id: "history", label: "History", icon: ICONS.history, badge: counts.history },
  ];
}

function contractorItems(options: PortalNavigationOptions): PortalNavigationItem[] {
  const items: PortalNavigationItem[] = [
    {
      id: "my_jobs",
      label: "My jobs",
      icon: ICONS.workOrders,
      badge: options.counts.contractorActive,
      attentionBadge: options.counts.contractorAttention,
    },
    { id: "my_schedule", label: "My Schedule", icon: ICONS.schedule, beta: true },
    { id: "history", label: "Closed jobs", icon: ICONS.history, badge: options.counts.history },
  ];
  if (options.canLeadTeam || options.canManageTeam) {
    items.push({ id: "team_dispatch", label: "My Team", icon: ICONS.team });
  }
  if (options.canInvoice) {
    items.push({ id: "invoices", label: "Invoices", icon: ICONS.invoices, badge: options.counts.contractorInvoice });
  }
  return items;
}

const ITEM_BUILDERS: Record<PortalNavigationRole, (options: PortalNavigationOptions) => PortalNavigationItem[]> = {
  controller: () => controllerItems(),
  manager: options => managerItems(options.counts),
  contractor: contractorItems,
};

export function buildPortalNavigationItems(options: PortalNavigationOptions): PortalNavigationItem[] {
  return ITEM_BUILDERS[portalNavigationRole(options)](options);
}

export function buildBottomNavigationItems(
  items: readonly PortalNavigationItem[],
  role: PortalNavigationRole,
): PortalNavigationItem[] {
  const preferred = BOTTOM_PAGE_IDS[role]
    .map(id => items.find(item => item.id === id))
    .filter((item): item is PortalNavigationItem => Boolean(item));
  return preferred.length > 0 ? preferred : items.slice(0, 4);
}

export function portalPageTitle(
  page: string,
  options: { isManager: boolean; selectedWorkOrderTitle?: string | null },
): string {
  const workOrderListTitle = options.selectedWorkOrderTitle || "Work orders";
  const titles: Record<string, string> = {
    dashboard: "Dashboard",
    simplified: "Simplified",
    my_schedule: "My Schedule",
    staff_work: "My Work",
    work_orders: workOrderListTitle,
    invoices: options.isManager ? "Contractor bills" : "Invoices",
    billing: "7-Eleven billing",
    contractors: "Contractors",
    contractor_preview: "Contractor view",
    my_jobs: "My jobs",
    team_dispatch: "My Team",
    wo_detail: options.selectedWorkOrderTitle || "Work order",
    capital: "Capital projects",
    history: options.isManager ? "History" : "Closed jobs",
  };
  return titles[page] || "P1 Service Portal";
}
