# Questions for Jeremy — running list

Not sending this yet. Keeping it open as we build — will add/remove questions as we go and consolidate before the next round of comms with P1.

---

## Billing + rates

1. **Labor rate — is $110/hr standard across all contractors, or does it vary by company/region/trade?** Using $110 as a placeholder (from Invoice 6556 which was Pro Ops in VA) but need to know if Starnes (Dallas), Archer (Houston), etc. bill at different rates.

2. **"Ways to pay" on invoices — what payment methods do 7-Eleven use?** ACH? Check? Wire? The Invoice 6556 had this section but was cropped out of what I saw. Need to know so the portal's invoice output matches what actually gets sent.

3. **Travel rate** — Invoice 6556 billed travel at $110 per trip (same as labor rate). Is that always the case, or does travel rate vary by distance/region?

4. **Sales tax** — Invoice 6556 shows $246 tax on $4,039 subtotal (~6%). That's not VA, TX, or FL standard rates. Is 7-Eleven tax-exempt? Do some services get taxed differently? Where is tax computed from (service location state)?

5. **P1 → 7-Eleven vs Contractor → P1** — Invoice 6556 is P1 billing 7-Eleven. Do the contractor crews (Starnes, Pro Ops, etc.) ALSO send P1 a separate invoice for their portion of the work, which gets reconciled internally? Or is there a different arrangement? Impacts whether the portal should track both sides of invoicing.

6. **Invoice numbering** — 6556 is a simple sequential number (looks like QuickBooks sequence). Should the portal generate these, or are they always assigned by QuickBooks? If QB, a future integration should pull the next-available #.

---

## Contractor roster

7. **Missing phone numbers** for: Derek Starnes (Starnes Commercial Refrigeration, Dallas), Chris Archer (Archer Refrigeration, Houston), Dave Lecerda (Shecan Facility Maintenance, Dallas). Excel you sent didn't include these.

8. **Are the trade specializations I've assigned correct?** Specifically:
   - Starnes = HVAC + Refrigeration + Beverage + Ice? Or broader?
   - Archer = HVAC + Refrigeration + Ice (no beverage)?
   - Pro Ops = HVAC + Refrigeration + Ice?
   - Same Day Repair = Beverage + Ice only (no HVAC)?
   - Shecan = Hot food only?
   - Coleman Tank Solutions = Septic + Grease trap only?
   - Talneglobaltrans = Slurpee + Beverage only?
   - Anytime Plumbing = Plumbing only?
   - (Need this confirmed because it drives auto-dispatch routing.)

9. **Any contractors outside TX/VA/FL?** Roster covers Dallas, Houston, Virginia Beach, Tampa, and Orlando-ish. If a ticket comes in from Chicago or Phoenix, who takes it?

10. **Is Derek Starnes's Dallas operation also running Dallas + other TX cities?** You mentioned his crew is the biggest. Does he cover San Antonio, Austin, Fort Worth too, or just Dallas metro?

---

## 7-Eleven side

11. **Complete AFM list (even a snapshot)** — you said AFMs change jobs often but even a current list of who's active helps us pre-populate the address book. From the emails I've parsed: Jason Pulley, Greg Peterman, Marcus Holloway. Others?

12. **Sample of a "completed / invoice approved" email** — the emails you forwarded covered dispatch, SLA breach, and capital approval. Need to see what the close-out looks like on 7-Eleven's side.

13. **Sample of a "cancellation" or "rejection" email** — you mentioned these exist. Seeing one would help so we know how to handle that edge case in the portal.

14. **SLA tiers** — the breach email said "8 Hours" for Priority 1. What are the SLAs for P2 Emergency, P3 Standard, P4 Minor? I've guessed 24/72/168 hrs — please confirm.

15. **Is there an emergency escalation contact at 7-Eleven** when an SLA is about to breach? Right now the portal warns you internally but an auto-escalation-to-7-Eleven feature would be more valuable if there's a proper channel.

16. **API access** — who at 7-Eleven IT would we talk to about FSM API credentials? Not urgent (portal runs on manual input fine), but want to start that conversation in parallel.

---

## Workflow clarifications

17. **The "Functional Status" field that caused your SLA breach** — is that a field 7-Eleven syncs back from their FSM system, or is it something P1 is supposed to update on their portal? If the latter, the P1 portal should force that update on status transitions so it doesn't get missed again.

18. **Capital replacement flow** — when a tech recommends capital replacement (like the Slurpee beater motor on FWKD11234445), is the approval process always:
    (a) Tech recommends → P1 submits capital quote → 7-Eleven approves/denies → parts ordered → second visit → close out?
    Or are there variations?

19. **Multiple trips** — Invoice 6556 shows 2 travel charges + 2 labor entries (clearly 2 separate trips on same WO). Does 7-Eleven approve multiple trips in advance, or does each extra trip need its own justification/approval?

20. **Parts markup** — Invoice 6556 lists the beater motor at $1,256.25. Is that what the contractor paid, or is there markup baked in? Does P1 add markup on top of contractor pricing when billing 7-Eleven?

21. **Who signs off on an invoice before it goes out?** Does Eddie review all invoices, does the tech submit directly, is there a back-office approval step? (Informs portal workflow — who sees the "submitted" state first.)

---

## Tech / infrastructure

22. **QuickBooks** — what QB product are you using (QB Online, Desktop, Enterprise)? Important for eventual integration. Answer determines whether API integration is trivial (QBO) or painful (Desktop).

23. **Email inbox** — `service@p1pros.com` is where 7-Eleven dispatches come. Who has access? Any shared inbox setup (Google Groups / Outlook distribution list) or is it literally forwarded? Relevant for the email-ingestion fallback plan.

24. **Photo storage** — currently you have no systematic way to attach photos to tickets, right? (Contractors probably text or email pics.) Want to make sure we're replacing a real gap and not stepping on an existing process.

25. **Communication norms with AFMs** — do you prefer portal-in-portal messages, email, phone, text? Helps design how AFM-facing features eventually work.

---

## Legal / corporate

26. **Legal entity for the portal** — Invoice 6556 header says "P1 Pros (P Hospitality Repairs LLC)". Is P1 Pros literally a DBA of P Hospitality Repairs LLC? Just want to make sure I have the corporate structure right for contracts, domain ownership, billing, etc.

27. **Remit address for invoices** — 10181 Sample Rd #204, Coral Springs FL 33065 from the invoice. Is that current? Used for all billing?

---

## Format / preferences for the portal

28. **Branding** — want P1 colors/logo front-and-center, or keep it generic (since you may eventually license this to other contractor networks)?

29. **User tier access** — should back-office folks (Lynzy, Mandy, Lynette, Kim, Emily) have same access as owners, or a slightly reduced view? Same question for Landry as dispatcher.

30. **Mobile app** — once the web portal is stable, do the field techs actually want a native iOS/Android app, or is mobile web (PWA that adds to home screen) enough? Saves 2-3 months of dev time if PWA is fine.

---

*Last updated: Apr 21, 2026 — after parsing Invoice 6556*
