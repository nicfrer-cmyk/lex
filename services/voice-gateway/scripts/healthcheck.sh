#!/usr/bin/env bash
# בדיקת מצב של שרת הקול.
#
# מדפיס מה מוגדר ומה לא, ומחזיר קוד יציאה שאפשר לתלות בו ב-CI או
# ב-monitoring. אין כאן ניחושים: כל שורה מגיעה משאילתה אמיתית.
#
#   ./scripts/healthcheck.sh          # מקומי
#   ./scripts/healthcheck.sh <host>   # מרוחק
#
# קודי יציאה:
#   0  הכול מחובר
#   1  השירות חי אך חסרות הגדרות (המצב הצפוי לפני חיבור SIP)
#   2  השירות אינו מגיב

set -uo pipefail

HOST="${1:-127.0.0.1}"
ORCH_PORT="${ORCHESTRATOR_PORT:-8080}"
BASE="http://${HOST}:${ORCH_PORT}"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

echo "LexTrack Voice Gateway — בדיקת מצב"
echo "================================================"

# ---- 1. האם השירות עונה ----
if ! HEALTH=$(curl -fsS --max-time 5 "${BASE}/health" 2>/dev/null); then
  bad "ה-Orchestrator אינו מגיב ב-${BASE}"
  echo
  echo "  בדוק:  docker compose ps"
  echo "         docker compose logs orchestrator --tail 50"
  exit 2
fi
ok "ה-Orchestrator מגיב"

# jq אינו מובטח על כל שרת. נפילה ל-grep שומרת על הסקריפט שמיש בלי
# להוסיף תלות שצריך להתקין רק בשביל בדיקת בריאות.
field() {
  if command -v jq >/dev/null 2>&1; then
    echo "$HEALTH" | jq -r "$1 // empty"
  else
    echo "$HEALTH" | grep -o "\"${2}\":[^,}]*" | head -1 | cut -d: -f2- | tr -d '" '
  fi
}

VERSION=$(field '.version' version)
CONFIGURED=$(field '.configured' configured)
ACTIVE=$(field '.active_calls' active_calls)
QUEUED=$(field '.queued' queued)

ok "גרסה ${VERSION:-?}"
[ "${ACTIVE:-0}" != "0" ] && ok "שיחות פעילות: ${ACTIVE}" || true

# ---- 2. תור מקומי ----
# ⚠ תור שגדל פירושו שה-CRM לא זמין ופניות של לקוחות ממתינות לשליחה.
# זו לא בעיית ביצועים, זו פנייה שטרם נרשמה.
if [ "${QUEUED:-0}" != "0" ] && [ -n "${QUEUED:-}" ]; then
  warn "${QUEUED} בקשות ממתינות בתור המקומי — ה-CRM כנראה אינו זמין"
  echo "     ניקוז ידני:  curl -X POST ${BASE}/drain"
else
  ok "התור המקומי ריק"
fi

# ---- 3. חיבור ל-CRM ----
if [ "${CONFIGURED}" = "true" ]; then
  ok "החיבור ל-CRM מוגדר"
else
  warn "החיבור ל-CRM אינו מוגדר (CRM_BASE_URL / CRM_OFFICE_ID / VOICE_GATEWAY_SECRET)"
fi

# ---- 4. מרכזייה ----
if STATUS=$(curl -fsS --max-time 5 "${BASE}/status" 2>/dev/null); then
  if echo "$STATUS" | grep -q '"ok":true'; then
    ok "המרכזייה (Asterisk) מגיבה"
  else
    warn "המרכזייה אינה מחוברת — זהו המצב הצפוי לפני הגדרת ARI ו-SIP"
  fi
fi

# ---- 5. מה חסר ----
echo
PROBLEMS=$(echo "$HEALTH" | tr ',' '\n' | grep -A20 'problems' | grep -o '"[^"]\{8,\}"' | tr -d '"' | grep -v problems || true)
if [ -n "$PROBLEMS" ]; then
  echo "נדרש להשלמה:"
  echo "$PROBLEMS" | while IFS= read -r line; do warn "$line"; done
  echo
  echo "כל עוד אלה חסרים, שיחות טלפון אמיתיות אינן מתקבלות."
  echo "המערכת ניתנת לבדיקה מלאה דרך \"מצב בדיקה\" ב-CRM."
  exit 1
fi

echo "הכול מחובר."
exit 0
