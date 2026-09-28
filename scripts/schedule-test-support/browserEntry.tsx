import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import MySchedule from "../../src/features/schedule/MySchedule";
import { DirectoryScopeProvider } from "../../src/features/directory/queries";
import { parseAuthProfile } from "../../src/features/auth/authProfile";

const isManager = new URLSearchParams(location.search).get("role") !== "technician";
const user = parseAuthProfile({ id: "10000000-0000-4000-8000-000000000001", role: isManager ? "manager" : "contractor", active: true, name: "Synthetic tester" },
  { contractorAccountId: "20000000-0000-4000-8000-000000000001", accessLevel: "report_only", canManageTeam: false }, [], true);
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
createRoot(document.getElementById("root")!).render(<QueryClientProvider client={client}>
  <DirectoryScopeProvider actor={user}>
    <main style={{ maxWidth: 1100, margin: "0 auto", padding: 12 }}>
      <MySchedule active currentUser={user} isManager={isManager} onOpenWorkOrder={id => { document.getElementById("opened")!.textContent = id; }} />
      <output id="opened" aria-label="Opened work order" />
    </main>
  </DirectoryScopeProvider>
</QueryClientProvider>);
