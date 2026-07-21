# LexTrack — pending decisions / next steps

Last updated 2026-07-21. Payment processor: Meshulam/Grow (existing account). Plan: ₪97/month, 20GB storage, 14-day free trial, no card required at signup — payment only required once the trial actually ends (product decision, 2026-07-05).

## 2026-07-21 — general legal CRM repositioning, batch upload, e-filing prep, document viewer/editing, full audit + polish

Two work sessions, both pushed live:

**Session A — repositioning + 4 new/changed features:**
- **General legal CRM, not collection-only.** New `case.caseType` ('debt'|'general') drives which stage list and field labels show (`CASE_STAGES`/`getCaseStages()` — was a hardcoded 7-value collection pipeline in ~5 places). Debtor name is no longer a hard-required field. Finance/dashboard/AI-agent copy relabeled neutrally. Fully backward-compatible — existing cases default to `caseType:'debt'`.
- **Case-detail redesign**: יומן טיפול (diary) is now the default/first tab with edit/delete; דיונים moved later; docs tab got sort (added/last-opened/type) + type filter.
- **New נט המשפט e-filing tab** per case: mark files as main/attachment, reorder/auto-number, generate per-attachment cover pages + a TOC docx (>5 attachments) per the Courts Administrator's actual document-format directive, keeping attachments as separate files (per Israel Bar guidance — never merged into one PDF).
- **Batch document upload**: pick many files at once, step through each with a live preview (PDF/image/docx) + editable name/category/case, plus a one-click "add all as-is."
- Removed the redundant "מסמכים משפטיים" status card from case-detail (the "⋮ עוד" menu already generates the same documents — was taking up space for a workflow the owner doesn't use, by his own call).
- New "ניתוח משרד" (office analytics) tab: period selector, 6 KPIs, two weekly trend charts, a "needs attention" list (stuck/neglected cases, overdue tasks, upcoming hearings), and office performance stats. Needed two new fields (`case.closedAt`, `task.completedAt`) that don't exist for pre-existing closed cases/completed tasks — those won't show up retroactively in the stats, only from now on.
- Fixed a bug from earlier this same session: the dashboard's "stage breakdown" card was showing all ~10 possible stages (debt+general combined) unconditionally, pushing the whole dashboard into needing a scroll — now only shows stages that actually have a case in them.

**Session B — document viewer/editing + full audit + UX pass:**
- **Documents now open in an in-app viewer** (PDF/image inline, docx via mammoth) instead of forcing an immediate download. Every document has a "⋮" menu: open/preview, rename, duplicate, download, **update version**, email, WhatsApp, delete.
- **Editing loop, honestly scoped**: a browser tab cannot detect that a separate native app (Word) closed a file it doesn't control — no browser exposes that. So "open → edit → save → back in the system" is a real two-step loop: "פתח לעריכה" downloads and opens the file in whatever app is associated with it (typically Word); "עדכן גרסה" (always shown right next to it) re-uploads the saved file onto the *same* document row (same id/name/category/case — no duplicate). This is explained to the user in-app, not just here.
- **Full bug-audit sweep** (3 parallel reviewers: frontend logic, HTML/UX/mobile, database security/RLS) over everything built this session. Real bugs found and fixed, most severe first:
  - Diary edit-in-progress state (`diaryEditIndex`) was a global that didn't track *which case* it belonged to — editing an entry in case A, then navigating away without saving and adding a new note in case B, could silently overwrite an unrelated entry in B. Fixed (now tracks case id too, and resets on every case-detail render, which already wipes the visible edit state anyway).
  - Same variable also desynced if a lower-index diary entry was deleted while a higher-index edit was in progress — fixed.
  - The in-case docs tab's sort/filter was a global, not scoped per case — switching cases could leave a filter silently hiding documents in the new case with only an easy-to-miss dropdown value as evidence. Now resets when switching to a different case.
  - Re-running "הכן להגשה" (prepare e-filing bundle) after adding one more attachment left the *previous* run's cover-page/TOC files sitting in the docs list alongside the new ones, indistinguishable — real risk of e-filing the wrong cover page. Fixed: old generated set is purged before regenerating.
  - Power-of-attorney "subject" text was hardcoded as debt-collection wording ("גבייה מ...") gated only on whether a debtor-name field was filled — since a *general*-type case reuses that same field for "צד קשור," a general matter could generate a POA that literally says "debt collection from X." Fixed to gate on `caseType` explicitly.
  - Two mobile bugs: the per-document "⋮" menu (reused in many more places than its original single use) anchored the wrong edge and could render off-screen on a phone; the e-filing tab's per-item row (role select + 4 buttons) overflowed unwrapped on a phone — both fixed, the e-filing row now also collapses into a "⋮" menu.
  - Case-detail grew to 7 tabs; wrapping (the default) pushed content down by 2-3 lines on mobile — now a single horizontally-scrollable row instead.
  - Added a lightweight audit stamp (`lastSharedAt`/`lastSharedVia`) when generating a share link, since it's a week-long-valid unauthenticated bearer URL.
  - Independent RLS/security re-check: no cross-tenant leak, no RLS recursion, no `auth.users` permission trap in any of this session's new Platform methods (`getViewUrl`/`getShareUrl`/`downloadFileBytes`/`pickFiles`) — every one only ever operates on a `filePath` sourced from the office's own already-loaded data, never user-supplied, with Storage RLS as a second backstop either way.
- Everything verified in real Chromium via Playwright (not just jsdom) — including at a real 390×844 phone viewport — with `saveDB` stubbed to avoid touching the live Supabase project (no separate dev/staging environment exists for this account).

## Status

- [x] `fix15.sql`/`fix16.sql` — run. Push notification tables exist and the
      daily reminder check is scheduled via `pg_cron`/`pg_net` at 06:00 UTC
      (~09:00 Israel in summer). Still genuinely untested against a real
      subscribed device — see below.
- [x] **Push notifications — hearing reminders (day before), tasks due today,
      stuck-case alerts (14+ days no diary activity).** Works in the browser and
      as an installed PWA (Add to Home Screen); does NOT work in the currently
      installed Android APK (same root cause as Google sign-in — it's a bare
      WebView, not a real browser context). Toggle is in Settings, visible to
      every user (reminders are personal). The actual send function
      (`check-and-send-reminders`) is deployed and smoke-tested live — it runs
      correctly end to end. Uses a Deno-native Web Push library
      (`@negrel/webpush`) I couldn't test an actual delivery with (no
      subscribed device tested against yet, now that fix15/16 are run) — if the
      very first real reminder fails, that library's own README is the first
      place to check.
- [x] Removed the temporary trial-expiry test button (`testExpireTrialNow`) and
      its `temp-admin-set-trial` Edge Function after confirming the paywall
      genuinely blocks the app once a trial expires.
- [x] SQL migrations fix6–fix9 — run
- [x] Google Cloud OAuth app — configured (per you)
- [x] `fix10.sql` — run. Fixed the "infinite recursion" error (office_members'
      own RLS policies were self-referencing — a classic Postgres trap).
- [x] `fix11.sql` — run. Fixed "permission denied for table users" (a regression
      I introduced in fix6.sql — see git log for the full story).
- [x] Google sign-in in the **installed Android app**: given up on, by decision —
      Google blocks OAuth inside an embedded WebView (which the installed app's
      "remote URL" shell is), forcing it out to the system browser with no way
      back into the native app without native deep-link work. The Google button
      is now hidden automatically when running inside the installed app;
      email/password still works there, and Google sign-in still works fine for
      anyone using the site in a normal mobile/desktop browser.
- [x] Pricing decided: **₪97/month, up to 20GB storage per office.** Enforced on
      every document/template upload (rejects with a clear message once an office
      would exceed 20GB), and set as the real charge amount in create-payment-page.
- [x] Real signup screen: clicking "משתמש חדש? הרשמה" on the login screen now opens
      a full registration form (name, office name, phone, email, address, password)
      — separate screen from login, not just the old bare email+password toggle.
      The plan (₪97/month, 20GB, 14-day free trial) is shown there, not on the
      login screen every returning user sees. Name/phone are saved to the user's
      profile (shown read-only in Settings) and the office is created with the
      real name typed in, not the old hardcoded "המשרד שלי" default.
- [x] `fix12.sql`/`fix13.sql`/`fix14.sql` — all run. All SQL migrations to date are applied.
- [x] **Trial-expiry enforcement.** You asked "what actually happens after the 14
      days?" — good catch, the honest answer was "nothing." Fixed: the app now
      shows a paywall (blocks the app, not the login) once a trial has genuinely
      expired or the subscription is past_due/canceled. Owners see the upgrade
      button; team members see a message to contact their office owner. Still
      needs real Grow credentials (below) before "שדרג מנוי" actually does
      anything — until then, an expired trial has no way to actually be paid off,
      which only matters once someone's own 14 days are close to running out.
- [x] Legal: drafted Terms of Service + Privacy Policy (`src/legal-content.js`)
      describing LexTrack's actual data flows (Supabase/Anthropic/Grow) —
      **first draft, needs your own review as the actual attorney before real
      customers rely on it**, especially the liability clauses. Viewable from
      the signup screen and Settings; signup now requires checking "קראתי
      ואני מסכים/ה..." before an account is created.
- [x] Account deletion: real self-service "מחיקת חשבון" in Settings (owner
      only, requires typing the exact office name) — deletes all Storage
      files, all data, and the owner's login, permanently. New `delete-account`
      Edge Function, already deployed. Needs fix13.sql (above) to not error.
- [x] **Discovered this machine has an authenticated Supabase CLI session already
      linked to the real project** ("yarin-law"). You confirmed (2026-07-05) I can
      use it to deploy code AND manage secrets directly — no more manual
      dashboard copy-pasting for these. Used it to:
  - Deploy `create-payment-page`, `grow-webhook` (`--no-verify-jwt`), and
    `send-invite-email` — all three are now live (`supabase functions list`
    confirms `ACTIVE`), alongside the already-deployed `ai-proxy`.
  - Confirmed `SUPABASE_SERVICE_ROLE_KEY` (and `SUPABASE_URL`/`SUPABASE_ANON_KEY`)
    are **already set automatically** by Supabase's platform for every Edge
    Function — the "go find and paste this yourself" step from the old
    instructions below is no longer needed at all.
  - Generated and set `GROW_WEBHOOK_SECRET` myself (a random string — proves a
    payment notification really came from Grow, since Grow doesn't sign its
    callbacks) — no need for you to invent/paste one either.
- [ ] **Only real blocker left for payment: `GROW_USER_ID` and `GROW_PAGE_CODE`**
      from your Grow/Meshulam dashboard (Settings/API, or their onboarding email).
      Once you have them, tell me and I'll set them as secrets myself — no
      dashboard work needed on your end at all anymore.
- [x] Fixed "שדרג מנוי" showing a raw technical error instead of a real message
      — `supabase.functions.invoke()` was never unwrapping the actual error body
      the function returns. Now every Edge Function call shows the real Hebrew
      message, and `create-payment-page` returns a specific "סליקה עדיין לא
      הוגדרה" until the Grow credentials above are set.
- [ ] Email (Resend) — still needs you to create the account (see below);
      I can't sign up for a third-party service on your behalf.

## Email — Resend (fast, works without your own domain)

1. Go to https://resend.com → sign up (free tier).
2. Dashboard → **API Keys** → create one → copy it.
3. You do NOT need your own domain for now — Resend lets you send from their shared
   `onboarding@resend.dev` address to start.
4. Tell me the API key (or set it yourself — see below) and I'll configure Supabase's
   SMTP settings and turn on email confirmation via the CLI, no dashboard steps
   needed from you beyond creating the Resend account itself.
5. Already drafted: see **EMAIL_TEMPLATES.md** — ready-to-paste HTML for the 3 emails
   LexTrack actually sends (confirm signup, invite user, reset password). These still
   go through the Dashboard's Email Templates screen specifically (not something the
   CLI manages) — Authentication → Email Templates, paste each in.

## Grow (Meshulam) payment — code deployed, needs your account details

Found Grow's actual field names (their docs site only shows them through search, not
a normal browsable page) and rewrote both functions correctly — form-encoded requests
(not JSON, which I had wrong at first), the real recurring-payment fields, and the
real webhook payload shape. **Both functions are now deployed and live.**

**What I still need from you** (from your Grow/Meshulam dashboard, Settings/API, or
their onboarding email):
- Your `userId`
- Your `pageCode`
- Confirm: does your account use just `pageCode`, or `userId`+`pageCode` together?
  (Grow's docs weren't fully clear on this — a quick look at their API settings page,
  or asking their support, would settle it.)

Send me these and I'll set them as secrets myself immediately — nothing further for
you to configure.

**Before charging anyone for real**: test with a sandbox transaction first (the code
currently points at `sandbox.meshulam.co.il`) and confirm in Settings that the
subscription status actually flips to "פעיל" afterward. Two small details are still
genuinely unconfirmed even with the better docs — whether the response from creating
a payment page has the exact shape my code expects, and `ApproveTransaction`'s exact
required fields — a real sandbox attempt will surface either problem immediately if
something's off, and I'll fix it from the actual error.

## Not relevant right now — keep in mind for later

- End-to-end test of the team-invite flow with two real users (you + an actual lawyer/secretary).
- Custom domain — also unlocks a properly branded sending address for email (section 1, "later, real" option).

## Miscellaneous / worth a look

- There's an unreadable/unowned-looking file `_debug-test.mjs` at the project root
  (untracked, not something I created) that both `cat` and this session's file-read
  tool failed to open with odd errors — possibly a lock from antivirus or another
  running process. Worth checking what created it; excluded from `npm test`'s glob so
  it doesn't interfere, but not touched/deleted since I don't know what it is.

## Longer-term / not urgent

- Template import still requires exact Hebrew filenames — a real upload + field-mapping UI would remove that friction for a new customer who doesn't know the convention.

## 2026-07-05 full-project bug audit

Dispatched 4 parallel review agents (frontend logic, HTML/UX structure, database
security/RLS, edge-functions+platform layer) to go over the entire project. Verified
every finding myself before fixing (2 were false positives from incomplete
briefing on my part — noted, not hidden). Real bugs found and fixed, most severe first:

- **Documents could silently overwrite unrelated documents from other cases** if two
  happened to share a filename (very plausible — "תביעה.docx" — in any law firm).
  Opening one could return the other's content. Fixed.
- **The AI agent's "what's stuck/neglected" detection was silently broken** for any
  case with diary history (a date-parsing bug) — it could never flag a stale case
  that had any diary entries at all, which is most of them. Fixed, with a test.
- **Fee-type display (percent/fixed/both/hourly) was duplicated in 3 places** with
  different bugs each time — 'both' cases and 'hourly' cases showed wrong numbers on
  the finance screen and to the AI agent. Consolidated into one function.
- The AI agent's financial answers used a cached running total instead of computing
  fresh like every human-facing screen already does — currently correct, but one
  missed update away from silently disagreeing with what you see on screen. Fixed.
- Two mobile bugs from this session's own earlier work: the "⋮ עוד" menu on case
  detail was rendering off the edge of the screen (3 buttons unreachable on phone),
  and the AI agent's floating button overlapped its own open chat panel. Both fixed.
- Storage-usage counting (the 20GB quota) and account deletion both had no
  pagination past 1000 files, and account deletion silently discarded any cleanup
  errors — hardened both.
- Independent security pass confirmed: no live RLS recursion, no `auth.users`
  permission-denied risk, and no cross-tenant data leak anywhere in the current
  schema (both historical regressions from earlier this session are fully resolved).
  One genuinely unused function found and removed (`fix14.sql`, above).

## Already done (see git log for full detail)

- Phase 1: multi-tenant offices, roles, server-side AI proxy
- Mobile/accessibility audit: modal z-index bug, crowded detail-page buttons, color contrast, checkbox keyboard support
- Dashboard-blank-until-clicked bug (missing initial `.active` class)
- `persistSession:false` — every fresh app open requires signing in again
- Dead code removal: unused Electron/Capacitor platform shims, dead "library path" picker
- Team invite email case-sensitivity fix, team list shows real emails
- Settings: profile (email + password reset), legal disclaimer, subscription status section
- Case detail's 4 secondary buttons collapsed into a "⋮ עוד" overflow menu (reusable `.overflow-menu` pattern)
- EMAIL_TEMPLATES.md — ready-to-paste Hebrew HTML for Supabase's 3 auth emails
- Removed the "prompt caching" toggle (dev jargon, no real user trade-off)
- `test/pure-functions.test.js` (`npm test`) — regression coverage for fee/VAT/date logic
- Self-hosted error log (`client_errors` table + Settings viewer) — no third-party account needed
- Google sign-in button + generalized "first login gets a solo office" bootstrap
- Subscription schema + payment/webhook Edge Functions with real Grow field names (this update — needs your account details + a sandbox test, see section 3)
- Invite-by-email Edge Function scaffold (needs service_role + SMTP, see sections 1/2)
