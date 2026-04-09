export type UserRole = "manager" | "contractor";

export interface User {
  id: string;
  name: string;
  role: UserRole;
  initials: string;
  email: string;
  color: string;
  company?: string;
  territory?: string;
}

export interface WorkOrder {
  id: string;
  store: string;
  city: string;
  addr: string;
  issue: string;
  priority: "emergency" | "critical" | "routine";
  status: string;
  contractor?: string;
  nte: number;
  age: string;
  category: string;
  afm: string;
  afmPhone: string;
  startTime?: string;
  partNeeded?: string;
  partEta?: string;
  invoiceTotal?: number;
}

export interface Invoice {
  num: string;
  wot: string;
  state: "submitted" | "approved" | "rejected" | "revised";
  date: string;
  store: string;
  total: number;
  contractor: string;
  reason?: string;
}

export interface StatusConfig {
  label: string;
  color: string;
  bg: string;
  ring: string;
}

export const USERS: User[] = [
  { id: "clay", name: "Clay Lawrence", role: "manager", initials: "CL", email: "clay@p1services.com", color: "#2563eb" },
  { id: "derek", name: "Derek Morrison", role: "contractor", initials: "DM", email: "derek@dmrepairs.com", company: "DM Repair Services", territory: "Orlando / Kissimmee", color: "#0ea5e9" },
  { id: "ray", name: "Ray Torres", role: "contractor", initials: "RT", email: "ray@raytechservices.com", company: "Ray's Technical Services", territory: "Melbourne / Daytona", color: "#8b5cf6" },
  { id: "andy", name: "Andy Kim", role: "contractor", initials: "AK", email: "andy@akmaintenance.com", company: "AK Maintenance Co.", territory: "Tampa / Lakeland", color: "#0891b2" },
];

export const WORK_ORDERS: WorkOrder[] = [
  { id: "WOT0012847", store: "36190", city: "Orlando, FL", addr: "4801 S Orange Ave", issue: "HVAC unit not cooling — store temp above 80°F, customers complaining", priority: "emergency", status: "unassigned", nte: 2500, age: "2h", category: "HVAC", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012852", store: "32236", city: "Kissimmee, FL", addr: "1920 W Vine St", issue: "Walk-in cooler compressor failure — product temp rising, potential loss", priority: "emergency", status: "unassigned", nte: 3000, age: "45m", category: "Refrigeration", afm: "Robert Chen", afmPhone: "(321) 555-0198" },
  { id: "WOT0012860", store: "41005", city: "Tampa, FL", addr: "3402 W Hillsborough Ave", issue: "Front door automatic closer broken — security risk, door staying open", priority: "routine", status: "unassigned", nte: 500, age: "1d", category: "General", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012801", store: "36190", city: "Orlando, FL", addr: "4801 S Orange Ave", issue: "Beverage dispenser leaking at base — floor hazard near registers", priority: "critical", status: "assigned", contractor: "derek", nte: 1200, age: "1d", category: "Equipment", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012815", store: "32236", city: "Kissimmee, FL", addr: "1920 W Vine St", issue: "Electrical panel cover missing in back room — code violation", priority: "critical", status: "assigned", contractor: "ray", nte: 800, age: "3d", category: "Electrical", afm: "Robert Chen", afmPhone: "(321) 555-0198" },
  { id: "WOT0012822", store: "41005", city: "Tampa, FL", addr: "3402 W Hillsborough Ave", issue: "Parking lot pothole near fuel pumps — liability concern", priority: "critical", status: "assigned", contractor: "andy", nte: 1500, age: "2d", category: "General", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012779", store: "41022", city: "Lakeland, FL", addr: "2210 S Florida Ave", issue: "Slurpee machine motor replacement — unit offline 3 days", priority: "critical", status: "wip", contractor: "andy", nte: 1800, age: "2d", category: "Equipment", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134", startTime: "Apr 7, 9:15 AM" },
  { id: "WOT0012788", store: "36501", city: "Daytona Beach, FL", addr: "801 N Atlantic Ave", issue: "Grease trap overflow in kitchen — health department risk", priority: "emergency", status: "wip", contractor: "derek", nte: 2200, age: "1d", category: "Plumbing", afm: "Robert Chen", afmPhone: "(321) 555-0198", startTime: "Apr 7, 2:00 PM" },
  { id: "WOT0012756", store: "32100", city: "Melbourne, FL", addr: "1455 N Harbor City Blvd", issue: "Walk-in freezer evaporator coil — needs full replacement", priority: "critical", status: "parts", contractor: "ray", nte: 4500, age: "5d", category: "Refrigeration", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134", partNeeded: "Heatcraft BHL136BE evaporator coil", partEta: "Apr 11" },
  { id: "WOT0012771", store: "36190", city: "Orlando, FL", addr: "4801 S Orange Ave", issue: "POS terminal #3 power supply unit failure — register offline", priority: "routine", status: "parts", contractor: "andy", nte: 350, age: "4d", category: "Electrical", afm: "Robert Chen", afmPhone: "(321) 555-0198", partNeeded: "Epson PS-180 power supply", partEta: "Apr 10" },
  { id: "WOT0012745", store: "41005", city: "Tampa, FL", addr: "3402 W Hillsborough Ave", issue: "Parking lot light pole repair — 3 fixtures out, dark corner", priority: "routine", status: "completed", contractor: "derek", nte: 900, age: "6d", category: "Electrical", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012730", store: "32236", city: "Kissimmee, FL", addr: "1920 W Vine St", issue: "Emergency plumbing — burst pipe in utility room, water damage", priority: "emergency", status: "pending_invoice", contractor: "ray", nte: 3200, age: "8d", category: "Plumbing", afm: "Robert Chen", afmPhone: "(321) 555-0198" },
  { id: "WOT0012718", store: "36501", city: "Daytona Beach, FL", addr: "801 N Atlantic Ave", issue: "Roof leak repair above walk-in cooler — water dripping on product", priority: "critical", status: "pending_invoice", contractor: "derek", nte: 5000, age: "10d", category: "General", afm: "Sandra Mitchell", afmPhone: "(407) 555-0134" },
  { id: "WOT0012702", store: "32100", city: "Melbourne, FL", addr: "1455 N Harbor City Blvd", issue: "Complete HVAC system overhaul — both rooftop units failing", priority: "critical", status: "pending_approval", contractor: "andy", nte: 8500, age: "12d", category: "HVAC", afm: "Robert Chen", afmPhone: "(321) 555-0198", invoiceTotal: 7840 },
];

export const INVOICES: Invoice[] = [
  { num: "INV05000142", wot: "WOT0012702", state: "submitted", date: "Apr 6", store: "32100", total: 7840, contractor: "andy" },
  { num: "INV05000138", wot: "WOT0012698", state: "approved", date: "Apr 4", store: "36190", total: 2150, contractor: "derek" },
  { num: "INV05000135", wot: "WOT0012685", state: "rejected", date: "Apr 3", store: "41022", total: 4600, contractor: "ray", reason: "Lack of invoice detail" },
  { num: "INV05000131", wot: "WOT0012670", state: "approved", date: "Apr 1", store: "32236", total: 1280, contractor: "derek" },
  { num: "INV05000128", wot: "WOT0012660", state: "revised", date: "Mar 30", store: "36501", total: 3100, contractor: "ray" },
  { num: "INV05000125", wot: "WOT0012655", state: "approved", date: "Mar 28", store: "41005", total: 890, contractor: "andy" },
];

export const STATUS_CONFIG: Record<string, StatusConfig> = {
  unassigned: { label: "Unassigned", color: "#3b82f6", bg: "#eff6ff", ring: "#bfdbfe" },
  assigned: { label: "Assigned", color: "#f59e0b", bg: "#fffbeb", ring: "#fde68a" },
  wip: { label: "In progress", color: "#8b5cf6", bg: "#f5f3ff", ring: "#c4b5fd" },
  parts: { label: "Parts on order", color: "#ef4444", bg: "#fef2f2", ring: "#fecaca" },
  completed: { label: "Completed", color: "#22c55e", bg: "#f0fdf4", ring: "#bbf7d0" },
  pending_invoice: { label: "Pending invoice", color: "#ec4899", bg: "#fdf2f8", ring: "#fbcfe8" },
  pending_approval: { label: "Pending approval", color: "#64748b", bg: "#f1f5f9", ring: "#cbd5e1" },
};

export const PRIORITY_CONFIG: Record<string, { label: string; color: string; bg: string; icon: string; ring: string }> = {
  emergency: { label: "Emergency", color: "#dc2626", bg: "#fef2f2", icon: "⚡", ring: "#fecaca" },
  critical: { label: "Critical", color: "#f59e0b", bg: "#fffbeb", icon: "⚠", ring: "#fde68a" },
  routine: { label: "Routine", color: "#22c55e", bg: "#f0fdf4", icon: "●", ring: "#bbf7d0" },
};

export const INV_STATE_CONFIG: Record<string, { label: string; color: string; bg: string; ring: string }> = {
  submitted: { label: "Submitted", color: "#3b82f6", bg: "#eff6ff", ring: "#bfdbfe" },
  approved: { label: "Approved", color: "#22c55e", bg: "#f0fdf4", ring: "#bbf7d0" },
  rejected: { label: "Rejected", color: "#ef4444", bg: "#fef2f2", ring: "#fecaca" },
  revised: { label: "Revised", color: "#f59e0b", bg: "#fffbeb", ring: "#fde68a" },
};

export const ACTIVE_STATUSES = ["unassigned", "assigned", "wip", "parts"];
export const CLOSING_STATUSES = ["completed", "pending_invoice", "pending_approval"];

export const fmt = (n: number) => "$" + n.toLocaleString();
export const getUser = (id: string) => USERS.find(u => u.id === id);
