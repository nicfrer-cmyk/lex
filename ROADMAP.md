# LexTrack — pending decisions / next steps

Last updated 2026-07-04. Payment processor: Meshulam/Grow (existing account).

## Status

- [x] SQL migrations fix6–fix9 — run
- [x] Google Cloud OAuth app — configured (per you)
- [ ] Grow payment — code rewritten with real field names, needs your credentials + a sandbox test
- [ ] Email (Resend, temporary) — next up
- [ ] `service_role` key — next up

## How to set secrets (no command line needed)

Every item below needs one or more "secrets" (API keys) set so the server-side code
can use them. All of them go in the same place — **no terminal/CLI required**:

**Supabase Dashboard → your project → Edge Functions → Secrets** (or **Manage secrets** —
the exact label may vary slightly). Add each one as a Name/Value pair and save.

## 1. Email — Resend (fast, temporary — per your choice)

1. Go to https://resend.com → sign up (free tier).
2. Dashboard → **API Keys** → create one → copy it.
3. You do NOT need your own domain for now — Resend lets you send from their shared
   `onboarding@resend.dev` address to start.
4. Supabase Dashboard → **Authentication → Emails → SMTP Settings** (may be named
   "Custom SMTP") → turn it on, and enter:
   - Host: `smtp.resend.com`
   - Port: `465` (or `587` — either works)
   - Username: `resend`
   - Password: *the API key you copied*
   - Sender email: `onboarding@resend.dev`
   - Sender name: `LexTrack`
5. Supabase Dashboard → **Authentication → Providers → Email** → turn ON "Confirm email".
6. Already drafted for you: see **EMAIL_TEMPLATES.md** — ready-to-paste HTML for the
   3 emails LexTrack actually sends (confirm signup, invite user, reset password).
   Paste each into **Authentication → Email Templates**, per the instructions there.

## 2. `service_role` key (needed for auto-sent team invites)

1. Supabase Dashboard → **Settings → API** → find `service_role` → click **Reveal**.
2. Copy it, then go set it as a secret (see "How to set secrets" above):
   Name: `SUPABASE_SERVICE_ROLE_KEY`, Value: *the key you copied*.
3. **Do not paste this key to me in chat** — it's a master password to your whole
   database (bypasses every access rule in the project). The secrets screen is the
   only place it should go.
4. Also deploy `send-invite-email` — this one step does need the CLI (`supabase functions
   deploy send-invite-email`); if you don't have the Supabase CLI installed, tell me and
   I'll walk you through installing it, or we can hold this specific step until then.

## 3. Grow (Meshulam) payment — real field names found, needs your account details

Good news: I found Grow's actual field names (their docs site only shows them through
search, not a normal browsable page, so it took a few tries) and rewrote both functions
correctly — form-encoded requests (not JSON, which I had wrong at first), the real
recurring-payment fields, and the real webhook payload shape.

**What I still need from you** (all from your Grow/Meshulam dashboard, under
Settings/API or from their onboarding email):
- Your `userId`
- Your `pageCode`
- Confirm: does your account use just `pageCode`, or `userId`+`pageCode` together?
  (Grow's docs weren't fully clear on this — a quick look at their API settings page,
  or asking their support, would settle it.)

Then, as secrets: `GROW_USER_ID`, `GROW_PAGE_CODE`, and `GROW_WEBHOOK_SECRET` (this
last one you invent yourself — any random long string, e.g. generate one at
https://1password.com/password-generator/ — it's how the webhook proves a payment
notification really came from Grow, since Grow doesn't sign its callbacks).

Once those are set, deploying both functions needs the CLI too
(`supabase functions deploy create-payment-page` and
`supabase functions deploy grow-webhook --no-verify-jwt`) — same note as above if you
don't have it installed yet.

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
