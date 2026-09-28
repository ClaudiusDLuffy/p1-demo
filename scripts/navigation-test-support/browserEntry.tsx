import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PortalNavigation } from "../../src/components/PortalNavigation";
import { buildPortalNavigationItems, initialFocusedPortalPage, portalPageTitle } from "../../src/lib/portalNavigationItems";

// Only the real navigation is under test here. This is not an authenticated
// PortalShell or backend workflow test; no data service or environment is used.
function NavigationHarness() {
  const params = new URLSearchParams(location.search);
  const role = params.get("role") === "contractor" ? "contractor" : params.get("role") === "controller" ? "controller" : "manager";
  const [page, setPage] = useState(initialFocusedPortalPage(role, location.search));
  const [drawer, setDrawer] = useState(false);
  const items = buildPortalNavigationItems({ isManager: role === "manager", invoiceController: role === "controller",
    canInvoice: role === "contractor", canManageTeam: role === "contractor",
    counts: { capital: 60, contractorActive: 51, contractorAttention: 6, contractorInvoice: 6, history: 125, open: 100, pendingApproval: 12, staffWork: 31 } });
  const navigation = <PortalNavigation items={items} selectedPage={page} onNavigate={destination => { setPage(destination); setDrawer(false); }} />;
  const header = <header className="shrink-0 border-b border-p1-bg/10 p-5 text-p1-bg">P1 Service</header>;
  const footer = <footer className="shrink-0 border-t border-p1-bg/10 p-4 text-p1-subtle"><p>Synthetic {role}</p>
    <button className="min-h-11" type="button">Manage Account</button><br /><button className="min-h-11" type="button">Sign out</button></footer>;
  return <>
    <aside className="fixed inset-y-0 left-0 hidden w-[232px] flex-col bg-p1-ink md:flex">{header}{navigation}{footer}</aside>
    <main className="p-3 md:ml-[232px]">
      <button className="min-h-11 md:hidden" type="button" onClick={() => setDrawer(true)}>Open menu</button>
      <h1>{portalPageTitle(page, { isManager: role === "manager" })}</h1>
      <output aria-label="Current page">{page}</output>
    </main>
    {drawer && <div className="fixed inset-0 z-10 bg-black/40 md:hidden">
      <aside role="dialog" aria-label="Navigation menu" className="absolute inset-y-0 left-0 flex w-[72vw] max-w-[280px] flex-col bg-p1-ink">
        {header}{navigation}{footer}
      </aside>
    </div>}
  </>;
}
createRoot(document.getElementById("root")!).render(<NavigationHarness />);
