# LexTrack — Auth email templates (ready to paste)

Not part of the app's code — Supabase hosts and sends these itself. Paste each HTML
block into **Supabase Dashboard → Authentication → Email Templates → [the matching
template]**, replacing the default content entirely, then Save. Do this once real
SMTP (see ROADMAP.md) is configured, since Supabase's own mailer is heavily
rate-limited on the free tier.

Each `{{ .ConfirmationURL }}` is a real Supabase template variable — don't edit it,
it gets filled in automatically per email sent.

---

## 1. Confirm signup

**Supabase screen**: Authentication → Email Templates → **Confirm signup**

```html
<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;background:#ffffff">
  <div style="background:#0f2a4a;padding:20px 24px;border-radius:8px 8px 0 0">
    <span style="color:#ffffff;font-size:20px;font-weight:bold">⚖ LexTrack</span>
  </div>
  <div style="padding:28px 24px;border:1px solid #e2e6ed;border-top:none">
    <h2 style="color:#0f1729;font-size:18px;margin:0 0 12px">אימות כתובת האימייל</h2>
    <p style="color:#4b5768;font-size:14px;line-height:1.7;margin:0 0 20px">
      תודה שנרשמת ל-LexTrack. כדי להשלים את ההרשמה ולהתחיל לנהל את התיקים שלך, יש
      לאשר את כתובת האימייל שלך.
    </p>
    <div style="text-align:center;margin:24px 0">
      <a href="{{ .ConfirmationURL }}" style="background:#2563eb;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block">אישור כתובת האימייל</a>
    </div>
    <p style="color:#8a94a6;font-size:12px;line-height:1.6;margin:20px 0 0">
      אם לא נרשמת ל-LexTrack, אפשר להתעלם מהודעה זו בבטחה.
    </p>
  </div>
</div>
```

---

## 2. Invite user (team invites)

**Supabase screen**: Authentication → Email Templates → **Invite user**

```html
<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;background:#ffffff">
  <div style="background:#0f2a4a;padding:20px 24px;border-radius:8px 8px 0 0">
    <span style="color:#ffffff;font-size:20px;font-weight:bold">⚖ LexTrack</span>
  </div>
  <div style="padding:28px 24px;border:1px solid #e2e6ed;border-top:none">
    <h2 style="color:#0f1729;font-size:18px;margin:0 0 12px">הוזמנת להצטרף למשרד ב-LexTrack</h2>
    <p style="color:#4b5768;font-size:14px;line-height:1.7;margin:0 0 20px">
      הוזמנת להצטרף כחברת/חבר צוות במערכת ניהול התיקים LexTrack. לחיצה על הכפתור
      תפתח את המערכת ותוסיף אותך למשרד באופן אוטומטי.
    </p>
    <div style="text-align:center;margin:24px 0">
      <a href="{{ .ConfirmationURL }}" style="background:#2563eb;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block">הצטרפות למשרד</a>
    </div>
    <p style="color:#8a94a6;font-size:12px;line-height:1.6;margin:20px 0 0">
      אם לא ציפית להזמנה הזו, אפשר להתעלם ממנה בבטחה.
    </p>
  </div>
</div>
```

---

## 3. Reset password

**Supabase screen**: Authentication → Email Templates → **Reset Password**

```html
<div dir="rtl" style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;background:#ffffff">
  <div style="background:#0f2a4a;padding:20px 24px;border-radius:8px 8px 0 0">
    <span style="color:#ffffff;font-size:20px;font-weight:bold">⚖ LexTrack</span>
  </div>
  <div style="padding:28px 24px;border:1px solid #e2e6ed;border-top:none">
    <h2 style="color:#0f1729;font-size:18px;margin:0 0 12px">איפוס סיסמה</h2>
    <p style="color:#4b5768;font-size:14px;line-height:1.7;margin:0 0 20px">
      קיבלנו בקשה לאיפוס הסיסמה לחשבון שלך ב-LexTrack. לחיצה על הכפתור תוביל אותך
      למסך קביעת סיסמה חדשה.
    </p>
    <div style="text-align:center;margin:24px 0">
      <a href="{{ .ConfirmationURL }}" style="background:#2563eb;color:#ffffff;padding:12px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block">קביעת סיסמה חדשה</a>
    </div>
    <p style="color:#8a94a6;font-size:12px;line-height:1.6;margin:20px 0 0">
      אם לא ביקשת לאפס את הסיסמה, אפשר להתעלם מהודעה זו בבטחה — הסיסמה הנוכחית שלך תישאר בתוקף.
    </p>
  </div>
</div>
```

---

## Also worth setting while you're on that screen

**Authentication → Email Templates → Sender name / Subject lines** (near the top of
that screen, above the per-template editors) — suggested subjects:
- Confirm signup: `אימות כתובת אימייל — LexTrack`
- Invite user: `הוזמנת להצטרף למשרד ב-LexTrack`
- Reset Password: `איפוס סיסמה — LexTrack`
