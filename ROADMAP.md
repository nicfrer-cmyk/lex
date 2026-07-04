# LexTrack — pending decisions / next steps

Written 2026-07-04, after the Phase 1 (multi-tenant offices) rollout and a round of
UX/accessibility/dev-cleanup fixes. This tracks what's left, split by who needs to act.

## Action required now

Two SQL migrations still need to be run against Supabase (SQL Editor), in order:
- `supabase-schema-phase1-fix6.sql` — case-insensitive email matching for team invites
- `supabase-schema-phase1-fix7.sql` — adds `office_members.email` so the team list can
  show real emails instead of truncated user_ids

## Needs your approval / an external account — not something doable from code alone

| Item | Why it's yours |
|---|---|
| Payment processor (Stripe/Tranzila/etc.) | Business decision + real account signup |
| Custom domain | Ownership/purchase is yours |
| Real SMTP for email confirmation | External provider account; works around Supabase's free-tier send-rate limit |
| Supabase `service_role` key | Needed for admin-level operations (e.g. inviting by email directly instead of a copy-paste link) |
| End-to-end test of the team-invite flow | Needs two real users (you + an actual lawyer/secretary) — can't be simulated |
| Error monitoring (e.g. Sentry) | External account + DSN key |

## Longer-term / not urgent

- Case detail still has 5 action buttons up top — a "⋮ עוד" overflow menu would be cleaner on small phones.
- Template import still requires exact Hebrew filenames — a real upload + field-mapping UI would remove that friction for a new customer who doesn't know the convention.

## Already done (for reference — see git log for full detail)

- Phase 1: multi-tenant offices, roles, server-side AI proxy
- Mobile/accessibility audit: modal z-index bug, crowded detail-page buttons, color contrast, checkbox keyboard support
- Dashboard-blank-until-clicked bug (missing initial `.active` class)
- `persistSession:false` — every fresh app open requires signing in again (deliberate, since this holds client legal/debt data)
- Dead code removal: unused Electron/Capacitor platform shims, dead "library path" picker
- Team invite email case-sensitivity fix, team list now shows real emails
- Settings: added profile (email + password reset) + legal disclaimer; removed the "prompt caching" toggle (dev jargon, no real user trade-off)
- `test/pure-functions.test.js` (`npm test`) — regression coverage for fee/VAT/date logic
