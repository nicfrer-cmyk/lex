# LexTrack — pending decisions / next steps

Last updated 2026-07-05. Payment processor: Meshulam/Grow (existing account). Plan: ₪97/month, 20GB storage.

## Status

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
- [ ] **`supabase-schema-phase1-fix12.sql` — run this now** (adds
      `subscriptions.storage_limit_gb`, default 20 — supporting column for the
      quota enforcement above).
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
