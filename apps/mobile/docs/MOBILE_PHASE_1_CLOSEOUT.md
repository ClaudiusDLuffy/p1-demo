# Mobile Phase 1 closeout

## Status

Local Phase 1 implementation is complete. Internal binaries and physical-device validation are blocked before source upload because EAS CLI has no authenticated Expo account in this environment.

- Branch: `feat/mobile-phase-1`
- Starting Git SHA: `502513e98ce0acd07b68b8e0ff3829dbc9912e80`
- Final Git HEAD SHA: `502513e98ce0acd07b68b8e0ff3829dbc9912e80` (working tree intentionally uncommitted)
- Minimum certified ancestor: `d70fdc304b109c69ff724b1643b329e391f12c48`, verified in `origin/main`
- No commit, push, merge, tag, deployment, store submission, EAS Update, hosted database mutation, or migration occurred.

## Foundation and versions

The app is an npm workspace at `apps/mobile`; shared packages are `packages/mobile-contracts` and `packages/design-tokens`. The Next.js application remains at the repository root.

- Node.js 22.23.2
- Expo SDK / `expo` 57.0.22
- Expo Router 57.0.21
- React Native 0.86.3
- React 19.2.4
- Supabase JS 2.116.0
- TanStack Query persistence 5.102.8
- Jest / Jest Expo 29.7.0 / 57.0.5
- Expo Doctor 1.20.4
- EAS CLI used for the blocked archive attempt: 24.3.0

Expo SDK 57 recommends React 19.2.3. The workspace keeps the root portal's existing React 19.2.4 patch and declares Expo's documented single-package install-check exclusion to avoid two React runtimes. Expo Doctor passes 21/21 checks and the web production build passes.

## Application identity

- Display name: P1 Pros
- Slug: `p1-pros-mobile`
- Scheme: `p1pros`
- Orientation: portrait
- iOS preview bundle identifier: `com.p1pros.portal.preview`
- Android preview application ID: `com.p1pros.portal.preview`

Both identifiers are provisional and internal-only. They are not approved production store identifiers.

No EAS project ID or build ID exists in the repository. EAS project initialization did not occur because the CLI stopped at login.

## Environment contract

Only these mobile public values are accepted, and partial/malformed input fails closed:

- `EXPO_PUBLIC_P1_APP_ENV`
- `EXPO_PUBLIC_SUPABASE_URL`
- `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
- `EXPO_PUBLIC_API_BASE_URL`
- `EXPO_PUBLIC_RELEASE_SHA`

Labels are `development`, `preview`, and `production`. The contract requires HTTPS, derives and validates the Supabase project reference, supports an expected-project comparison, rejects server-secret names, and never accepts a service-role key. `.env.example` contains placeholders only; value-bearing `.env` files are excluded from EAS source.

## Authentication and profile gate

The native Supabase client is separate from the browser client and sets `persistSession`, `autoRefreshToken`, and disabled URL session detection. React Native AppState starts refresh in foreground and stops it in background.

Auth state is stored through Expo SecureStore using a versioned generation manifest and 1,800-character encrypted chunks. A generation is published only after all chunks are written; replaced and removed generations are deleted. Tokens are excluded from Query cache, routes, diagnostics, and logs.

Every restored session is checked through `auth.getUser()`. Every authenticated identity resolves its exact RLS-scoped `profiles` row and `get_my_contractor_scope`. Identity, active state, role, access level, contractor account, and organization must validate before protected content renders. Missing, inactive, malformed, mismatched, unsupported, revoked, and expired states fail closed. Identity transitions purge all persisted read caches and private photo files before another profile renders.

Email/password sign-in, local logout, reset request, recovery deep link, password update, session restoration, and safe error mapping are implemented. Public sign-up is absent.

## Capabilities

| Profile | Mobile capability | Home | Server scope |
| --- | --- | --- | --- |
| Active contractor with `report_only` | Technician | My Jobs | Existing current-assignment RLS/RPC scope |
| Active contractor with `company_admin` and team authority | Company administrator | Company Queue | Existing current active-company RLS/RPC scope |
| Invoice-only contractor | Unsupported | Web portal guidance | No mobile queue |
| P1 staff, controller, QuickBooks, unknown role | Unsupported | Web portal guidance | No mobile queue |
| Missing, inactive, or malformed profile | Denied | Inactive/access screen | No mobile queue |

The app never broadens a server result or filters an all-company response to simulate authorization. Staff-only activity rows fail validation for contractor mobile capabilities.

## Read contracts

Injected native repositories retain the stabilized RPC names and arguments:

- `list_work_orders_rows_v1`
- `get_portal_work_order`
- `list_work_order_activities_rows_v1`
- `list_work_order_visits_rows_v1`
- `list_work_order_photos_rows_v1`

All raw results are decoded and validated as unknown. Pages retain opaque cursors, count-independent continuation, bounded sizes (25 queue, 30 activity/visits, 24 photos; maximum 100), exact parent checks, assignment/lifecycle versions, current RLS behavior, and cancellation. Internal work-order identity is retained for reads while the existing duplicate-root rule supplies the visible external WOT identity.

Screens include sign-in, forgot/reset password, protected role home, My Jobs, Company Queue, work-order detail, Account, unsupported role, inactive profile, and profile error. Detail includes location, status/functional status, priority/SLA, authorized technician summary, service description, parts, activity, visits, and photo metadata/private previews. No Phase 2 mutation control is present.

## Private photos

The native adapter accepts only canonical `photos` bucket paths under `wo/<authorized-work-order>/`, obtains the current matching user session, and downloads with authenticated Storage headers. It never creates public URLs. Concurrency is capped at three requests; screen exit aborts stale work and deletes temporary files. Expo Image uses memory-only caching, and logout/account change purges the dedicated photo directory. Photo bytes are never persisted in the Query cache.

## Offline read cache

TanStack Query persists only successful Phase 1 read queries. Cache keys include cache schema version, app environment, Supabase project reference, user ID, capability, access level, organization, and contractor account. Maximum retention is 24 hours.

Caches are purged on logout, account switch, inactive/profile failure, namespace mismatch, and schema-version mismatch. Private photo bytes and auth tokens are never persisted. NetInfo and AppState drive online/focus state. An authorization error hides cached rows/details immediately; a successful empty refresh replaces stale assignment data. There is no mutation queue.

## Security and verification

Passing mobile/shared gates:

- Shared strict TypeScript: pass
- Shared contract tests: 10 passed, 0 failed/cancelled/skipped/todo
- Mobile strict TypeScript: pass
- Mobile Expo lint: pass with zero warnings/errors
- Mobile Jest tests: 27 passed, 0 failed/skipped
- Expo Doctor: 21/21 passed
- Expo public config: pass
- Android Expo/Metro export: pass, 1 Hermes bundle and 27 assets
- Mobile import boundary: 58 source files passed
- Mobile source secret scan: 83 files passed after final documentation and asset cleanup
- Bundle secret scan: 29 exported files passed
- EAS allowlist manifest: 85 approved files, recorded in `EAS_UPLOAD_MANIFEST.txt`

The 37 tests use synthetic identifiers and `.invalid` addresses only. They cover environment rejection, role/profile gates, password reset parsing, sign-in/restoration/revocation, AppState refresh, secure chunking, logout/account-switch purge, cache namespace/version isolation, offline/access-removal UI, bounded pagination, identity mapping, staff-only activity rejection, visit/photo mapping, cancellation, former-assignment denial, safe API behavior, role routing, screen states, and accessible primary controls. Static executable scans enforce no browser/server-only imports, service-role imports, or raw-token logging.

Web compatibility results after workspace changes:

- `npm ci`: pass
- `npm ls --depth=0`: exit 0; npm reports pre-existing optional WASM helper packages as extraneous on Windows
- Root TypeScript: pass
- Next.js webpack production build: pass; 28 pages generated
- Server/client import scan: pass (100 client roots, 258 modules)
- Browser-secret source scan: pass (100 roots, 353 files)
- Browser artifact secret scan: pass (84 artifacts)
- `git diff --check`: pass, with local CRLF conversion notices for three root metadata files
- `npm audit --json`: 24 advisories (2 low, 17 moderate, 4 high, 1 critical). The direct critical advisory is on existing Next 16.2.3 and reports Next 16.3.5 as a fix. Phase 1 did not upgrade the web framework.
- Required historical Node test command: executed. It does not pass on this Windows checkout. Concurrent execution changes process working directories across test files; serial execution still exposes existing hardcoded POSIX path and LF migration-hash assumptions plus historical server-only harness failures. Production files remain present and unmodified, the dedicated boundaries pass, and the production build passes. The user-owned CRLF portability commit `c4ede687933b28e7f3570b189f7765124dc5bb02` remains on `dev` and was not cherry-picked or absorbed into this main-based Phase 1 branch.

## Build and device status

The Android preview profile requests internal distribution and `buildType: apk`. The iOS preview profile requests internal distribution. The production profile is configuration-only.

`eas build:inspect --platform android --stage archive --profile preview` stopped before archive creation or upload with: `An Expo user account is required to proceed.` No source was sent to Expo. The subsequent authorized `eas build --platform android --profile preview --non-interactive` attempt stopped at the same account prerequisite. The Android APK build was therefore not started. The common Expo login/project prerequisite also prevents checking iOS/Apple signing availability, so no iOS build or TestFlight/ad hoc action occurred.

No physical-device tests were run because no internal binary was produced and no approved test credentials/device session were available. No customer payload was recorded.

Smallest safe next action:

1. Authenticate EAS CLI with the approved Expo account (`eas login`) and make an approved EAS project ID available without adding credentials to source.
2. Configure the five approved public variables in the EAS `preview` environment and, if used, bind the expected single Supabase project reference.
3. Rerun `npm run scan:upload -w @p1/mobile`, generate/inspect the EAS archive, and confirm it contains only the allowlisted repository files.
4. Run `eas build --platform android --profile preview --non-interactive` to produce the APK.
5. When the approved Apple Developer account and registered internal devices are available, run the iOS preview build.
6. Execute the physical-device matrix in `MOBILE_PHASE_1_TEST_MATRIX.md` with approved test users.

## Phase 2

Phase 2 has not begun. Its mutation, upload, offline queue, push/deep-link pilot, invoicing, and release work is recorded separately in `MOBILE_PHASE_2_HANDOFF.md`.
