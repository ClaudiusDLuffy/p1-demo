# P1 Pros Mobile

`apps/mobile` is the read-only Expo React Native application for P1 Mobile Phase 1. It uses the existing hosted Supabase project and its current RLS/RPC authorization. The root Next.js portal remains in place.

## Runtime

- Node.js 22.23.2 or a compatible Expo SDK 57 runtime
- npm workspaces from the repository root
- Expo development builds for device testing

Install from the repository root:

```powershell
npm ci
```

Copy the variable names from `.env.example` into an untracked local environment and provide approved public values. Never place a service-role key or another server secret in the mobile environment.

```text
EXPO_PUBLIC_P1_APP_ENV
EXPO_PUBLIC_SUPABASE_URL
EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY
EXPO_PUBLIC_API_BASE_URL
EXPO_PUBLIC_RELEASE_SHA
```

Run local validation:

```powershell
npm run typecheck -w @p1/mobile-contracts
npm test -w @p1/mobile-contracts
npm run typecheck -w @p1/mobile
npm run lint -w @p1/mobile
npm test -w @p1/mobile
npm run doctor -w @p1/mobile
npm run export -w @p1/mobile
npm run scan:upload -w @p1/mobile
```

Start a development build session with `npm run start -w @p1/mobile`. Expo Go is not the final Phase 1 runtime.

## Phase 1 scope

Supported mobile roles are contractor report-only technicians and approved contractor company administrators. Other roles receive web-portal guidance and can log out. Mobile reads use the existing count-independent work-order, activity, visit, and photo metadata RPCs. Authentication is persisted in encrypted, versioned SecureStore chunks. User-scoped read models may be retained in AsyncStorage for at most 24 hours; they are partitioned by environment, Supabase project, user, role/access, contractor account, and organization.

Phase 1 contains no work-order, visit, assignment, note, photo, estimate, invoice, or offline-queue mutation.

The preview identifiers are provisional internal identifiers:

- iOS: `com.p1pros.portal.preview`
- Android: `com.p1pros.portal.preview`

EAS profiles are defined in `eas.json`. The `preview` Android profile produces an APK. Before any EAS build, run the upload manifest and secret scans. EAS login and project/environment configuration are currently external prerequisites; see `docs/MOBILE_PHASE_1_CLOSEOUT.md`.
