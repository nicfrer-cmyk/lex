# LexTrack — pending decisions / next steps

Last updated 2026-07-04. Tracks what's left, split by who needs to act. Payment
processor decision: Meshulam/Grow (you already have an account).

## 1. SQL migrations to run now (Supabase SQL Editor, in order)

- `supabase-schema-phase1-fix6.sql` — case-insensitive email matching for team invites
- `supabase-schema-phase1-fix7.sql` — adds `office_members.email` (real names in team list)
- `supabase-schema-phase1-fix8.sql` — `client_errors` table (Settings > error log)
- `supabase-schema-phase1-fix9.sql` — `subscriptions` table + trial bootstrap trigger

## 2. Google sign-in — needs a Google Cloud OAuth app (I can't create this for you)

1. https://console.cloud.google.com → new (or existing) project → **APIs & Services →
   Credentials → Create Credentials → OAuth client ID** → type **Web application**.
2. Authorized redirect URI: your Supabase project's `https://<project-ref>.supabase.co/auth/v1/callback`
   (find `<project-ref>` in the Supabase dashboard URL).
3. Copy the **Client ID** and **Client Secret** it gives you.
4. Supabase Dashboard → **Authentication → Providers → Google** → paste both in, enable it.
5. That's it — the "🔵 המשך עם Google" button on the login screen already calls the
   right code (`Platform.signInWithGoogle()` in `src/platform.web.js`); it just does
   nothing useful until the provider above is enabled.

## 3. Payment (Meshulam/Grow) — code scaffold exists, needs finishing with real details

I could not get field-level detail from Grow's docs site (grow-il.readme.io renders
its API reference client-side, which this environment can't scrape) — so
`supabase/functions/create-payment-page/index.ts` and `supabase/functions/grow-webhook/index.ts`
are built with the *confirmed* parts (server-side-only `userId`+`pageCode` auth, a
hosted payment page URL response, a webhook callback pattern) but have clearly marked
`TODO` comments for:
- The exact request fields for a **recurring** (not one-off) charge
- The real monthly price
- Your real success/cancel redirect URLs
- Grow's actual webhook payload shape + how to verify a webhook really came from them

**What I need from you**: log into your Grow/Meshulam dashboard, find the
CreatePaymentProcess / recurring-payment API reference and the webhook/callback docs,
and paste the relevant page content here (or a link, if a plain fetch happens to work
for you) — then I can finish the exact field wiring correctly instead of guessing.

Once that's done:
- `supabase secrets set GROW_USER_ID=... GROW_PAGE_CODE=...`
- `supabase functions deploy create-payment-page`
- `supabase functions deploy grow-webhook --no-verify-jwt`
- Put the `grow-webhook` function's URL into Grow's dashboard wherever it asks for a callback/webhook URL.

## 4. Real SMTP for email confirmation + auto-sent invites

Supabase's own mailer is free-tier rate-limited (why email confirmation on signup is
currently disabled, and why the invite-by-email Edge Function I built
(`supabase/functions/send-invite-email`) won't actually send anything yet). You said
you want this done *well*, not perfunctory — that pulls in one real constraint: a
properly-branded "from" address (e.g. `noreply@lextrack.co.il`) needs a domain, and
you said the domain can wait. Two honest options:
- **Now, temporary**: sign up for a provider with a free tier that works without your
  own domain (e.g. Resend — sends from their own shared subdomain to start), configure
  it as custom SMTP in Supabase Dashboard → Authentication → SMTP Settings. Good
  enough to unblock this; not the "quality/invested" version yet.
  Re-enable email confirmation there too once it's set up (Authentication → Providers → Email).
  Hebrew email copy (confirmation/invite/reset) is *not* in this repo — it's edited
  directly in the Supabase Dashboard's Email Templates screen — happy to draft the
  actual Hebrew wording for you to paste in there.
- **Later, real**: once the domain is bought, redo this with a branded sending
  address + DKIM/SPF on that domain. This is the version worth waiting for if "quality"
  matters more than having it working today.
Your call which order to do these in.

## 5. Supabase `service_role` key

Needed for `send-invite-email` (section 4) to actually call `auth.admin.inviteUserByEmail`.
Get it from Supabase Dashboard → Settings → API → `service_role` (click reveal).
**Set it as a function secret** (`supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...`),
don't paste it in chat — treat it like a master password to your whole database (it
bypasses every RLS policy in the project).

## 6. Not relevant right now — keep in mind for later

- End-to-end test of the team-invite flow with two real users (you + an actual lawyer/secretary).
- Custom domain (also blocks section 4's "real" branded email option).

## Miscellaneous / worth a look

- There's an unreadable/unowned-looking file `_debug-test.mjs` at the project root
  (untracked, not something I created) that both `cat` and this session's file-read
  tool failed to open with odd errors — possibly a lock from antivirus or another
  running process. Worth checking what created it; I excluded it from `npm test`'s
  glob so it doesn't interfere, but didn't touch/delete it since I don't know what it is.

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
- Settings: profile (email + password reset), legal disclaimer, subscription status section
- Removed the "prompt caching" toggle (dev jargon, no real user trade-off)
- `test/pure-functions.test.js` (`npm test`) — regression coverage for fee/VAT/date logic
- Self-hosted error log (`client_errors` table + Settings viewer) — no third-party account needed
- Google sign-in button + generalized "first login gets a solo office" bootstrap (now works for OAuth, not just email/password signup)
- Subscription schema (`subscriptions` table, RLS locked to server-side-only writes) + payment/webhook Edge Function scaffolds (see section 3 — not finished)
- Invite-by-email Edge Function scaffold (see section 4/5 — not finished)
