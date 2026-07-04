# LexTrack — Phase 0 Audit (commercial SaaS readiness)

Written before any Phase 1 code changes. See the project's plan history for how each claim below was verified (direct file reads/greps against `src/app.js`, `src/app.html`, `supabase-schema.sql` — not assumed from the original brief).

## 1. Actual current architecture

- **Codebase**: `src/app.html` (markup+CSS) + `src/app.js` (~2650 lines, business logic) + `src/auth.js` + `src/platform.web.js` (Supabase client) + `src/template-manager.js`. Bundled by `build.mjs` (esbuild) into `dist/`, deployed to Netlify, auto-deploying on push to `github.com/nicfrer-cmyk/lex`.
- **Auth/data**: Supabase Auth (email+password; email confirmation currently disabled — see §3). Postgres, not localStorage — multi-device sync works today by construction.
- **Data model is single-user, not multi-tenant**: one table, `public.app_data (user_id uuid primary key, data jsonb, updated_at)`, RLS `auth.uid() = user_id`. No "office" concept exists yet — this is Phase 1's real starting point.
- **Storage**: bucket `documents`, private, path-scoped `${user.id}/...`, same single-tenant scoping.
- **Electron + Android**: both thin shells (`loadURL`/`server.url`) pointing at the live Netlify site — no bundled app code in either. A working debug APK already exists in remote-URL mode.

## 2. Feature inventory (feature-parity baseline — nothing here should regress)

| Area | Present today |
|---|---|
| Dashboard | KPI stats (active cases, debt in progress, collected this month, open tasks, hours), stage breakdown, urgent tasks, upcoming hearings, recent cases |
| Cases | Table + Kanban toggle, 7 stages (איסוף מסמכים→התראה ראשונה→גישור→כתב תביעה→דיון→הוצאה לפועל→סגור), status/stage filters, search, debtor-info tab, fee-structure tab (percent/fixed/both/hourly) |
| Clients | Grid view, avatar/initials, client detail w/ linked cases |
| Tasks | Priority (urgent/normal/low), due date, linked case, open/done split |
| Calendar | Month grid, event types (דיון/קדם משפט/הוצאה לפועל/בוררות/פגישת לקוח/מועד אחרון/אחר), linked case |
| Finance | Payment log (debt/retainer/expense), 6-month collection chart, per-case fee report, export |
| Docs | Upload+categorize, linked case, search |
| Templates | ATF + POA generation via docx/pizzip/docxtemplater merge; cloud Template Manager screen |
| Timer | Floating pill, start/stop, save-to-case |
| AI Agent | Chat panel, tool-calling (create case/client/task, draft ATF/POA, list/read library docs, generate report), file upload for extraction, session cost display, Haiku/Sonnet auto-routing |

## 3. Verified tech debt / bugs

- **VAT**: label hardcoded `+17%` (outdated — Israel moved to 18% on 2025-01-01), and no downstream calculation actually consumes `feeVat` in a fee-total computation today. Two issues: fix/config the rate, *and* build the fee-with-VAT total that doesn't exist yet.
- **Anthropic API key stored & used client-side**: `#settings-api-key` saved into the user's `app_data` blob; `app.js` calls `api.anthropic.com` directly from the browser with it. Blocks subscription sales (each customer needs their own paid Anthropic account) and is a security smell. Fix: Supabase Edge Function proxy with a server-side secret.
- **Developer-facing AI UX in the product**: `#agent-session-cost` / `#settings-session-cost-modal` show live USD cost; raw Haiku/Sonnet picker in Settings. Needs to become plan-based credits, not dollars/model names.
- **Template import requires exact filenames**: `app.js` hardcodes `טמפלט_הסכם_שכר_טרחה.docx` / `טמפלט_ייפוי_כוח.docx`; the Template Manager screen tells users to name files exactly that. Needs a real upload + field-mapping UI.
- **Email confirmation disabled** (workaround for Supabase's free-tier email rate limit hit during testing); no password-reset flow exists yet either.
- **No office/tenant concept, no roles** — the Phase 1 headline item.

## 4. Migration recommendation: stay vanilla-modular (no React/TypeScript/Vite/Tailwind rewrite)

- `app.js` is ~2650 lines of already-debugged, already-deployed, RLS-verified business logic covering every row in §2 — a framework rewrite means reimplementing all of it before any commercial feature work starts, with a large regression surface (this project hit one real production bug — an orphaned `async` keyword — from a far smaller mechanical edit than a full rewrite would be).
- Execution here is one agent across sessions, not a team with dedicated QA — raises rewrite risk further, not lower.
- The actual Phase 2 asks (unified components, empty states, WCAG AA) don't require React — they're CSS/structure asks, and the `:root` design-token system already covers what a Tailwind config would provide.
- **Recommended instead**: split `app.js` into ES modules by domain (`cases.js`/`clients.js`/`tasks.js`/`calendar.js`/`finance.js`/`docs.js`/`agent.js`/`ui.js`), esbuild bundles them with zero new tooling; incremental JSDoc + `// @ts-check` for type safety without a TS build step; small reusable render-helpers (`renderBadge`, `renderEmptyState`, `renderCard`) as the "component system" instead of a framework. Revisit React only if a future screen genuinely needs complex reactive state that DOM updates make painful.

## Open questions before Phase 1 can start

1. **Data model direction**: rekey the existing "one JSON blob" pattern to `office_id` (fast, minimal code change) vs. normalize into real relational tables now (bigger lift, enables real SQL filtering/reporting later). Needs an explicit decision before touching schema.
2. **Payment processor**: not yet chosen/credentialed — can build the generic adapter + one concrete implementation, but no live sandbox charge until real credentials exist.
3. Still needed: Supabase service key (for admin operations like inviting users by email), custom domain (if any), which processor.
