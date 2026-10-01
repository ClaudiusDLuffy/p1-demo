// Real invoice editor, draft guard and calculator; synthetic actor/HTTP only.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import BillingInvoiceCreateModal from "../../src/features/billing/BillingInvoiceCreateModal";
import FloatingProfitCalculator from "../../src/features/billing/FloatingProfitCalculator";
import { Modal } from "../../src/components/ui/Modal";
import { DirectoryScopeProvider } from "../../src/features/directory/queries";
import { parseAuthProfile } from "../../src/features/auth/authProfile";
import { activateBrowserDraftSession, draftActivationTicket } from "../../src/lib/drafts/browserDraftSession";

const user = parseAuthProfile({ id: "10000000-0000-4000-8000-000000000001", role: "manager", active: true,
  name: "Synthetic billing tester", email: "billing@example.test" }, null, [], true);
activateBrowserDraftSession(user.id, true, draftActivationTicket());
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const fmt = (value: number) => "$" + value.toLocaleString("en-US");

function Harness() {
  const [modal, setModal] = useState<string | null>(null);
  const [editorHost, setEditorHost] = useState<HTMLDivElement | null>(null);
  const [page, setPage] = useState("billing");
  const [otherDialog, setOtherDialog] = useState(false);
  const [actor, setActor] = useState("staff");
  const allowed = actor !== "contractor" && actor !== "controller";
  return <QueryClientProvider client={client}><DirectoryScopeProvider actor={user}>
    <main className="p-4">
      <h1>Local synthetic billing test</h1>
      <button className="btn-soft" onClick={() => setPage(page === "billing" ? "work-order" : "billing")}>Switch page</button>
      <output aria-label="Current page">{page}</output>
      {allowed && <button className="btn-accent" onClick={() => setModal("createBillingInvoice")}>Create invoice</button>}
      <button className="btn-soft" onClick={() => setOtherDialog(true)}>Unrelated dialog</button>
      <label>Test actor<select aria-label="Test actor" value={actor} onChange={event => setActor(event.target.value)}>
        <option value="staff">Ordinary staff</option><option value="second-staff">Second staff</option>
        <option value="contractor">Contractor</option><option value="controller">Restricted controller</option>
      </select></label>
    </main>
    {allowed && <BillingInvoiceCreateModal modal={modal} currentUser={user} onClose={() => setModal(null)}
      onCreated={() => { throw new Error("Unexpected invoice mutation"); }} fmt={fmt}
      onProfitCalculatorHostChange={setEditorHost} />}
    <FloatingProfitCalculator key={actor} visible={allowed && (page === "billing" || modal === "createBillingInvoice")}
      editorHost={editorHost} fmt={fmt} />
    {otherDialog && <Modal title="Unrelated confirmation" onClose={() => setOtherDialog(false)}>
      <button type="button" onClick={() => setOtherDialog(false)}>Return to billing</button>
    </Modal>}
  </DirectoryScopeProvider></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
