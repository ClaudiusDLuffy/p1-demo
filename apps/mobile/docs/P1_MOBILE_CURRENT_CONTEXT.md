# P1 mobile current context

- Branch: `feat/mobile-phase-1`; HEAD/start SHA `502513e98ce0acd07b68b8e0ff3829dbc9912e80`; work is intentionally uncommitted/unpushed.
- Expo SDK 57 app lives at `apps/mobile`; shared packages: `packages/mobile-contracts`, `packages/design-tokens`. Root Next.js layout is unchanged.
- Phase 1 read-only features are implemented: secure native Supabase auth/session restore, active-profile role gate, My Jobs/company queue, detail/activity/visits/parts/private photos, isolated 24-hour offline read cache, logout/account-switch purge.
- Supported: contractor `report_only` and approved `company_admin`; invoice-only/staff/unknown roles use web guidance. No mobile mutations exist.
- RPCs: `list_work_orders_rows_v1`, `get_portal_work_order`, `list_work_order_activities_rows_v1`, `list_work_order_visits_rows_v1`, `list_work_order_photos_rows_v1`.
- Local green gates: shared TS + 10 tests; mobile TS/lint + 27 tests; Expo Doctor 21/21; Expo Android export; import/source/bundle scans; Next build; web TypeScript; web source/artifact boundary scans.
- Existing Windows historical web suite failures are documented in `MOBILE_PHASE_1_CLOSEOUT.md`; dedicated boundaries and production build pass. Do not reopen stabilization unless a current executable failure requires it.
- EAS CLI 24.3.0 is not logged in. `build:inspect` stopped before archive/upload. No EAS project/build IDs, APK, iOS build, or physical-device results yet.
- Next safe action: approved `eas login`, bind the EAS project and five preview public variables, rerun upload scan/archive inspection, build Android preview APK, then iOS if Apple credentials permit and execute the test matrix.
- Provisional preview IDs: `com.p1pros.portal.preview` on iOS and Android. Do not treat as store-approved production IDs.
- Phase 2 has not begun.
