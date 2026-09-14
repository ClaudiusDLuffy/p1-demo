# Mobile Phase 1 test matrix

Automated fixtures are synthetic. Physical validation must use approved test users and safe test work orders on the single hosted Supabase project. Do not record customer payloads.

## Automated and local

| Area | Result | Evidence |
| --- | --- | --- |
| Environment/profile/shared contracts | Pass | 10/10 shared tests; 0 skipped |
| Auth, storage, repositories, cache security | Pass | Included in 27/27 mobile Jest tests |
| Native screens and accessibility names | Pass | Included in 27/27 mobile Jest tests |
| Mobile strict TypeScript | Pass | `npm run typecheck -w @p1/mobile` |
| Shared strict TypeScript | Pass | `npm run typecheck -w @p1/mobile-contracts` |
| Mobile lint | Pass | Zero errors and warnings |
| Expo Doctor | Pass | 21/21 checks |
| Expo Android export | Pass | Hermes bundle exported |
| Source/import/bundle secret scans | Pass | No finding |
| Next.js production build | Pass | 28 routes/pages generated |
| Web import and browser-secret scans | Pass | Source and 84 built artifacts |
| Historical web Node suite | Existing Windows baseline failure | Concurrent CWD, POSIX path, LF hash, and server-only harness assumptions; see closeout |

## Physical internal beta

Status: blocked pending Expo login, EAS project/environment setup, and internal binaries.

Record only device/build metadata in the result columns.

| Role | Scenario | Expected | Device / OS / network | Build ID | Result |
| --- | --- | --- | --- | --- | --- |
| Technician/report-only | Login and restore after restart | My Jobs restores without another user's data | Pending | Pending | Not run |
| Technician/report-only | Current assigned queue/detail | Only current assignments; WOT, activity, visits, parts, photo metadata visible | Pending | Pending | Not run |
| Technician/report-only | Private photo read | Authenticated private preview; no public URL | Pending | Pending | Not run |
| Technician/report-only | Other-company/former-assignment access | Denied; no cached content remains | Pending | Pending | Not run |
| Technician/report-only | Offline restart | Previously loaded assigned reads show offline/last-updated state | Pending | Pending | Not run |
| Technician/report-only | Logout | Session, read cache, and photo files removed | Pending | Pending | Not run |
| Company administrator | Login and company queue | Only current active-company work is visible | Pending | Pending | Not run |
| Company administrator | In-company detail | Authorized activity, visits, parts, and photos visible | Pending | Pending | Not run |
| Company administrator | Outside-company access | Denied; no stale detail | Pending | Pending | Not run |
| Company administrator | Offline cached read and logout | Isolated cached reads; purge on logout | Pending | Pending | Not run |
| Unsupported role | Authentication | Web-portal guidance, no queue, logout available | Pending | Pending | Not run |
| Inactive/malformed profile | Restoration | Fail-closed screen, no queue/cache | Pending | Pending | Not run |
| Revoked/expired session | Restoration | Signed-out state and local cleanup | Pending | Pending | Not run |
| Password recovery | Approved deep link | Reset screen only for valid `p1pros` recovery link | Pending | Pending | Not run |

## Metadata template

- Physical device model:
- OS version:
- Network type:
- App build ID:
- Tester role:
- Scenario result:
- Safe diagnostic/correlation ID, if any:
