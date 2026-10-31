#!/usr/bin/env bash
# ============================================================================
# הפעלת התזמון של מרכז ה-AI, צוות ה-AI ותזכורות ה-Push
# ============================================================================
#
# מריצים פעם אחת, מתיקיית הפרויקט:   bash scripts/setup-cron.sh
#
# הסקריפט עושה הכול לבד:
#   1. מייצר CRON_SECRET **אצלך במחשב** ושולח אותו ישירות ל-Supabase.
#   2. רושם את עבודות pg_cron דרך ה-CLI (הפרויקט מקושר, אין צורך להדביק SQL).
#   3. מדפיס את רשימת העבודות לאימות.
# הסוד לא עובר בצ'אט, לא נכתב לקובץ ולא נכנס ל-git.
#
# למה בכלל צריך סוד: ai-cron נפרסת עם --no-verify-jwt (למתזמן אין משתמש
# מחובר), ולכן זו ההגנה היחידה שמונעת מכל אחד ברשת להריץ סוכנים על חשבונך.
#
# הרצה חוזרת בטוחה: cron.schedule עם שם קיים מעדכן את העבודה במקום לשכפל.
# ============================================================================

set -euo pipefail
cd "$(dirname "$0")/.."

PROJECT_REF="syxutnwbpjsvzlwfpvyc"
SB="npx --yes supabase@latest"

echo "מייצר CRON_SECRET..."
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

echo "שולח ל-Supabase..."
$SB secrets set "CRON_SECRET=$SECRET" --project-ref "$PROJECT_REF" >/dev/null
echo "✓ הסוד הוגדר."
echo

SQL=$(cat <<EOF
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- מרכז ה-AI וצוות ה-AI: טיק כל 5 דקות — מנקה משימות תקועות, מכניס לתור את
-- שגרות הצוות שהגיע זמנן (רק במשרדים שהפעילו "הצוות עובד לבד"), מנקז את התור
-- ומריץ את לולאת הלמידה (שמווסתת את עצמה ל-6 שעות).
select cron.schedule(
  'ai-center-tick', '*/5 * * * *',
  \$\$
  select net.http_post(
    url := 'https://$PROJECT_REF.supabase.co/functions/v1/ai-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '$SECRET'
    ),
    body := jsonb_build_object('tasks', array['reap','routines','drain','learn'])
  );
  \$\$
);

-- מנוע האוטומציות הדטרמיניסטי (כללים לפי משרד). לא עולה כסף אלא אם כלל
-- מפעיל סוכן במפורש; תקופת הצינון של כל כלל קובעת מה קורה בפועל.
select cron.schedule(
  'automation-tick', '*/5 * * * *',
  \$\$
  select net.http_post(
    url := 'https://$PROJECT_REF.supabase.co/functions/v1/automation-engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '$SECRET'
    ),
    body := '{"action":"tick"}'::jsonb
  );
  \$\$
);

-- תזכורות Push לטלפון (דיון מחר, משימה להיום, תיק תקוע). בלי AI ובלי עלות.
-- העבודה הזו כבר קיימת בשם הזה; כאן רק מוודאים שהיא רצה ב-07:00 שעון ישראל
-- (04:00 UTC) ולא ב-08:00.
select cron.schedule(
  'daily-reminders-check', '0 4 * * *',
  \$\$
  select net.http_post(
    url := 'https://$PROJECT_REF.supabase.co/functions/v1/check-and-send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  \$\$
);

select jobname, schedule, active from cron.job order by jobname;
EOF
)

echo "רושם את עבודות התזמון..."
$SB db query --linked "$SQL"
echo
echo "✓ סיימנו. אחרי 5-10 דקות אפשר לראות שזה רץ:"
echo "   npx supabase db query --linked \"select status, return_message, start_time from cron.job_run_details order by start_time desc limit 5\""
echo "ובמערכת: עוזר AI ← הצוות ← 'המתזמן פעיל'."
