# ============================================================================
# הפעלת התזמון של מרכז ה-AI, צוות ה-AI ותזכורות ה-Push — גרסת PowerShell
# ============================================================================
# מריצים פעם אחת, מתיקיית הפרויקט:
#   powershell -ExecutionPolicy Bypass -File scripts\setup-cron.ps1
# זהה ל-setup-cron.sh (לווינדוס בלי Git Bash). ראה שם את ההסברים.
# ============================================================================

$ErrorActionPreference = 'Stop'
Set-Location (Join-Path $PSScriptRoot '..')

$ProjectRef = 'syxutnwbpjsvzlwfpvyc'

Write-Host 'מייצר CRON_SECRET...'
$bytes = New-Object byte[] 32
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$Secret = ($bytes | ForEach-Object { $_.ToString('x2') }) -join ''

Write-Host 'שולח ל-Supabase...'
npx supabase secrets set "CRON_SECRET=$Secret" --project-ref $ProjectRef | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'הגדרת הסוד נכשלה.' }
Write-Host '✓ הסוד הוגדר.'
Write-Host ''

$Sql = @"
create extension if not exists pg_cron;
create extension if not exists pg_net;

select cron.schedule(
  'ai-center-tick', '*/5 * * * *',
  `$`$
  select net.http_post(
    url := 'https://$ProjectRef.supabase.co/functions/v1/ai-cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '$Secret'
    ),
    body := jsonb_build_object('tasks', array['reap','routines','drain','learn'])
  );
  `$`$
);

select cron.schedule(
  'automation-tick', '*/5 * * * *',
  `$`$
  select net.http_post(
    url := 'https://$ProjectRef.supabase.co/functions/v1/automation-engine',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '$Secret'
    ),
    body := '{"action":"tick"}'::jsonb
  );
  `$`$
);

select cron.schedule(
  'daily-reminders-check', '0 4 * * *',
  `$`$
  select net.http_post(
    url := 'https://$ProjectRef.supabase.co/functions/v1/check-and-send-reminders',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := '{}'::jsonb
  );
  `$`$
);

select jobname, schedule, active from cron.job order by jobname;
"@

$SqlFile = Join-Path $env:TEMP ("lextrack-cron-" + [guid]::NewGuid().ToString('n') + ".sql")
Set-Content -Path $SqlFile -Value $Sql -Encoding utf8
try {
  Write-Host 'רושם את עבודות התזמון...'
  npx supabase db query --linked -f $SqlFile
  if ($LASTEXITCODE -ne 0) { throw 'רישום העבודות נכשל.' }
} finally {
  Remove-Item $SqlFile -Force -ErrorAction SilentlyContinue
}

Write-Host ''
Write-Host '✓ סיימנו. אחרי 5-10 דקות: עוזר AI ← הצוות ← "המתזמן פעיל".'
