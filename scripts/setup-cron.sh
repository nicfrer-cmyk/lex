#!/usr/bin/env bash
# ============================================================================
# הפעלת התזמון של מרכז ה-AI
# ============================================================================
#
# מריצים פעם אחת:   bash scripts/setup-cron.sh
#
# הסקריפט מייצר את CRON_SECRET **אצלך במחשב**, שולח אותו ישירות ל-Supabase,
# ומדפיס בלוק SQL להדבקה. הסוד לא עובר בצ'אט, לא נכתב לקובץ ולא נכנס ל-git.
#
# למה בכלל צריך סוד: ai-cron נפרסת עם --no-verify-jwt (למתזמן אין משתמש
# מחובר), ולכן זו ההגנה היחידה שמונעת מכל אחד ברשת להריץ סוכנים על חשבונך.
# ============================================================================

set -euo pipefail

PROJECT_REF="syxutnwbpjsvzlwfpvyc"

echo "מייצר CRON_SECRET..."
SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")

echo "שולח ל-Supabase..."
npx --yes supabase@latest secrets set "CRON_SECRET=$SECRET" --project-ref "$PROJECT_REF" >/dev/null
echo "✓ הסוד הוגדר."
echo

cat <<EOF
────────────────────────────────────────────────────────────────────
עכשיו העתק את הבלוק הבא והדבק ב:
  https://supabase.com/dashboard/project/$PROJECT_REF/sql/new
ואז לחץ Run.
────────────────────────────────────────────────────────────────────

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- מריץ טיק כל 5 דקות: מנקה משימות תקועות, מנקז את התור,
-- בודק אוטומציות, ומריץ את לולאת הלמידה (שמווסתת את עצמה ל-6 שעות).
select cron.schedule(
  'ai-center-tick', '*/5 * * * *',
  \$\$
  select net.http_post(
    url := 'https://$PROJECT_REF.supabase.co/functions/v1/ai-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '$SECRET'
    ),
    body := jsonb_build_object('tasks', array['reap','drain','automations','learn'])
  );
  \$\$
);

-- בדיקה שהעבודה נרשמה:
select jobname, schedule, active from cron.job;

────────────────────────────────────────────────────────────────────
אחרי 5-10 דקות, כדי לראות שזה באמת רץ:

  select status, return_message, start_time
  from cron.job_run_details
  order by start_time desc limit 5;

────────────────────────────────────────────────────────────────────
EOF
