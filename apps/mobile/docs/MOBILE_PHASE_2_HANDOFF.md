# Mobile Phase 2 handoff

Phase 2 was not started in this session. Begin it only after Phase 1 produces reviewed internal binaries and the role/authorization/device matrix passes.

The Phase 1 boundaries to retain are:

- One existing hosted Supabase project; no second hosted project.
- Native Supabase client with encrypted chunked auth storage and AppState refresh.
- Exact active-profile/capability gate before protected content.
- Existing RLS/RPC authorization as the source of queue and detail scope.
- Strict unknown-result validators, opaque bounded cursors, and cancellation.
- Cache namespace by environment, project, user, capability/access, contractor account, and organization.
- Purge before identity changes and fail closed on authorization loss.
- Authenticated canonical private-object reads with no public URL or persistent photo bytes.
- Mobile/server/browser import and secret scans, strict TypeScript, lint, tests, Expo Doctor/export, and minimal EAS upload inspection.

Phase 2 program scope from the approved program definition:

- ETA and ETA correction
- Visit start, pause, resume, and completion
- Parts mutations
- Work-order assignment/reassignment where approved
- Notes and contractor messages
- Camera capture and canonical photo uploads/deletion
- Estimates and attachments
- Contractor invoicing and approved financial workflows
- Offline mutation queue with idempotency, ordering, reconciliation, conflict handling, and account isolation
- Push notifications and deeper link routing
- Pilot hardening and store release preparation

Before adding a mutation, identify the existing authoritative command/RPC, operation ID and version preconditions, retry/reconciliation contract, safe error mapping, RLS scope, cache invalidation, and offline semantics. Do not convert Phase 1 read repositories into direct table writers.

Outstanding Phase 1 prerequisites that must close first:

1. Approved Expo account login and EAS project binding.
2. Approved preview environment values.
3. Android preview APK and iOS internal build where Apple credentials permit.
4. Physical technician, company-administrator, unsupported-role, offline, denial, private-photo, session-restore, and logout-purge results.
5. Final production app identifiers remain a separate approval decision; Phase 1 identifiers are provisional.
