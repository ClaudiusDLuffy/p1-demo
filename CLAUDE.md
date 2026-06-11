# P1 Service Portal — Project Context

## This is LIVE PRODUCTION
- Production URL: p1prosportal.com
- The client (P1 Pros) is actively using this app daily. Never push to main.
- All work happens on branches. Vercel auto-generates preview URLs per branch.

## Infrastructure (client-owned, we administer)
- Vercel: P1's team account (auto-deploys main → p1prosportal.com)
- Supabase: P1's account — NEW project, the old project ref bzeozpierssjyyagpwyl is DEAD. Never reference it.
- DNS: GoDaddy (client-managed, not our concern in code)
- GitHub: this repo, ClaudiusDLuffy/p1-demo

## Migration rule (critical)
Migrations are applied MANUALLY in the Supabase SQL editor BEFORE any dependent code merges. Never assume a migration is applied. Always output migration SQL separately and flag it.

## Working style
- Tight, surgical changes. No redesigns, no drive-by refactors.
- Match 7-Eleven labels exactly where specified.
- Use the existing dbCall pattern — no silent failures.
- Five-section invoice structure (Labor / Truck Charge / Parts / Shipping / Other) is fixed.
