# QuickBooks Online sandbox foundation

This integration deliberately keeps P1's two accounting workflows separate:

| Owner | Portal workflow | Accounting direction | Current handoff |
| --- | --- | --- | --- |
| Emily | Contractor bills | Accounts payable | Source PDFs plus a reference-only manifest |
| Lynzy's team | P1 invoices to 7-Eleven | Accounts receivable | Existing SaasAnt customer-invoice CSV |

The contractor-bill package is not a QuickBooks import file. The SaasAnt CSV is
only for P1 receivable invoices and must never be used to create contractor
bills.

## What this phase enables

- Authorized accounting staff can start the Intuit OAuth authorization-code
  flow for a sandbox company.
- The callback validates a short-lived, one-time state bound to the initiating
  staff profile.
- The portal reads CompanyInfo to verify the selected sandbox realm.
- Access and refresh tokens are encrypted with AES-256-GCM before server-only
  storage. Browser clients and client roles cannot query the credential tables.
- Disconnect revokes the Intuit token before encrypted credentials are erased.
- Disconnect first claims and locks the connection, so reconnect cannot replace
  credentials while Intuit revocation is in flight. An uncertain external
  response remains fail-closed and can be resumed safely after a short claim
  lease. Concurrent disconnect requests never revoke the same credential at the
  same time.
- Starting authorization is serialized and is refused while a company is active
  or disconnecting. Disconnect invalidates outstanding authorization URLs, and
  the database rejects any callback initiated before the completed disconnect,
  including delayed callbacks that target a different QuickBooks realm.
- An expired refresh token or Intuit's definitive `invalid_grant` response is
  treated as already inactive; every other revocation error remains fail-closed.
- Sandbox and production configuration, API bases, realms, and tokens are kept
  separate.

Automatic Bill creation, payment creation, vendor matching, account/class
mapping, tax-source imports, and custom-field writes are intentionally disabled.

## Required sandbox configuration

Create an Intuit development app and add this exact redirect URI in its sandbox
settings:

```text
https://YOUR-PORTAL-HOST/api/quickbooks/callback
```

Configure these server-only environment variables:

```text
QUICKBOOKS_ENVIRONMENT=sandbox
QUICKBOOKS_SANDBOX_CLIENT_ID=...
QUICKBOOKS_SANDBOX_CLIENT_SECRET=...
QUICKBOOKS_SANDBOX_REDIRECT_URI=https://YOUR-PORTAL-HOST/api/quickbooks/callback
QUICKBOOKS_TOKEN_ENCRYPTION_KEY=...
QUICKBOOKS_TOKEN_KEY_VERSION=1
```

Generate the encryption key with a cryptographically secure 32-byte value, for
example `openssl rand -base64 32`. Do not prefix any of these variables with
`NEXT_PUBLIC_`, commit their values, paste them into tickets, or log them.

Never replace an encryption key without incrementing its version. During a key
rotation, retain each prior key needed by an existing connection as
`QUICKBOOKS_TOKEN_ENCRYPTION_KEY_VN` (for example,
`QUICKBOOKS_TOKEN_ENCRYPTION_KEY_V1`). The stored SHA-256 key fingerprint is
checked before decryption, and reconnect is blocked while an active connection
uses a different key. Retired keys may be removed only after their connections
have been revoked or re-encrypted.

Apply `0116_private_quickbooks_sandbox_connection.sql` before deploying the
application routes. Run its matching audit and require `all_checks_pass = true`.
The audit deliberately fails while any row remains in the deprecated plaintext
`qbo_tokens` table. Reconcile and revoke those legacy authorizations, then remove
their rows through an approved database maintenance step before enabling this
connector.

## Contractor-bill handoff rollout order

The immutable contractor-bill package uses an explicit expand/deploy/contract
rollout. Do not apply migrations 0117 and 0118 together:

1. Apply `0117_immutable_contractor_bill_handoff_packages.sql` and run its
   matching 0117 audit. Require `all_checks_pass = true`. This is the expand
   phase: both the legacy and revision-bound server RPCs remain usable, so the
   currently deployed app continues working.
2. Deploy the revision-bound application and verify package creation,
   re-download, confirmation, cancellation, and recovery in the deployed
   environment.
3. Let every old application instance drain and keep observing the new version
   until it is stable.
4. Close the rollback window for the old application. This is a stricter gate
   than instance drain: do not apply 0118 while rollback could restore an app
   version that calls the legacy RPCs.
5. Apply `0118_contract_immutable_contractor_bill_handoff.sql`, then run its
   matching 0118 audit and require `all_checks_pass = true`. This preserves
   legacy audit rows and storage objects, cancels only unverified pending
   packages, enforces verified pending packages, and disables both legacy
   staging signatures. Its cutoff lock has a five-second timeout; if the
   migration times out behind in-flight traffic, no contract changes commit,
   so retry it during the controlled window.

If the new application is unhealthy before step 4, roll back the application
while 0117 compatibility is still active. After 0118, roll forward with the new
application; do not roll back to a legacy caller.

The connector requests only `com.intuit.quickbooks.accounting`. Do not add
OpenID or premium custom-field scopes in this phase.

## Inputs still required from Emily

- Chart of Accounts and the exact Accounts Payable account.
- Approved expense-account mapping by portal line category.
- QuickBooks Class list and the rule for selecting a class.
- Contractor-to-Vendor mapping, using QuickBooks entity IDs rather than fuzzy
  name matching.
- Custom-field screenshots/definitions and confirmation of which fields apply
  to Bills.
- The authoritative tax-rate source, first source table, refresh terms, and
  stable location identifiers.
- Confirmation whether direct Bill creation is acceptable. The public
  Accounting API creates a real A/P transaction; it does not expose Emily's
  current Receipts "For review" queue as a documented staging endpoint.

Sandbox IDs cannot be reused in production. Production remains locked until a
separate mapping set, controlled pilot, and explicit approval exist.

## Implementation references

- [Intuit OAuth client and endpoint behavior](https://github.com/intuit/oauth-jsclient)
- [Intuit sandbox/get-started sample](https://intuitdeveloper.github.io/getstarted/)
- [Intuit Bill workflow sample](https://github.com/IntuitDeveloper/QBOConceptsTutorial-DotNet/blob/master/MvcCodeFlowClientManual/Controllers/BillingController.cs)
- [Intuit Attachable upload documentation](https://developer.intuit.com/app/developer/qbo/docs/api/accounting/all-entities/attachable#upload-a-file)
