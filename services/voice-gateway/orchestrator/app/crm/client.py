"""הלקוח היחיד שמדבר עם ה-CRM.

## למה תור מקומי
המפרט מחייב: "אם CRM לא זמין — שמור Local Queue ונסה Retry בצורה מבוקרת".
הסיבה קונקרטית: תקלת רשת של חמש שניות באמצע שיחה לא יכולה למחוק את
העובדה שהתקשר לקוח. הבקשה נשמרת לדיסק, נשלחת שוב, והשיחה ממשיכה.

## למה זה בטוח
ה-CRM אידמפוטנטי בכל נתיב שמשנה נתונים: `external_call_id` ייחודי לשיחה,
`(call_id, sequence)` לקטע תמלול, ו-`(call_id, idempotency_key)` לפעולה.
מפתח הפעולה נגזר מהתוכן, ולכן שליחה חוזרת של "קבע פגישה" מחזירה את
הפגישה הקיימת במקום ליצור שנייה. בלי זה, תור עם retry היה מנגנון לייצור
פגישות כפולות.

## מה לא עובר כאן
service_role key, גישה ל-Postgres, ו-SQL. אין. השירות הזה שולח פעולות
בשם, וה-CRM מחליט.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from pathlib import Path
from typing import Any

import httpx

from ..config import Settings
from ..security.signer import build_headers
from ..telemetry.logging import get_logger

log = get_logger(__name__)


class CrmUnavailable(RuntimeError):
    """ה-CRM לא ענה. הבקשה נשמרה בתור ותישלח שוב."""


class CrmRejected(RuntimeError):
    """ה-CRM ענה ודחה. ⚠ לא נכנס לתור — retry על 4xx רק יחזור על אותה דחייה."""


class CrmClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._queue_dir = Path(settings.queue_path)
        self._client: httpx.AsyncClient | None = None
        self._drain_lock = asyncio.Lock()

    async def start(self) -> None:
        self._queue_dir.mkdir(parents=True, exist_ok=True)
        self._client = httpx.AsyncClient(timeout=self.settings.http_timeout)

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None

    # ------------------------------------------------------------------

    async def call(self, action: str, payload: dict[str, Any], *,
                   queue_on_failure: bool = True) -> dict[str, Any]:
        """פעולה אחת מול ה-CRM."""
        if not self.settings.crm_configured:
            raise CrmUnavailable("ה-CRM לא הוגדר (CRM_BASE_URL / OFFICE_ID / SECRET)")

        body = json.dumps({"action": action, **payload}, ensure_ascii=False, separators=(",", ":"))
        try:
            return await self._send(body)
        except CrmRejected:
            raise
        except Exception as exc:  # noqa: BLE001 — כל כשל רשת נכנס לתור
            if queue_on_failure:
                self._enqueue(action, body)
                log.warning("crm_unavailable_queued", extra={
                    "action": action, "error": str(exc)})
            raise CrmUnavailable(str(exc)) from exc

    async def _send(self, body: str) -> dict[str, Any]:
        assert self._client is not None, "CrmClient.start() לא נקרא"
        headers = build_headers(
            self.settings.voice_gateway_secret, self.settings.crm_office_id, body)

        resp = await self._client.post(
            self.settings.crm_base_url, content=body.encode("utf-8"),
            headers=headers.as_dict())

        if resp.status_code >= 500 or resp.status_code == 429:
            # שגיאת שרת או מגבלת קצב — שווה לנסות שוב מאוחר יותר.
            raise RuntimeError(f"CRM החזיר {resp.status_code}")
        if resp.status_code >= 400:
            # ⚠ 4xx אחר: חתימה שגויה, פעולה לא מוכרת, שדה חסר. retry על
            # אלה הוא לולאה שמייצרת רעש ולא מתקנת דבר.
            detail = _safe_error(resp)
            raise CrmRejected(f"{resp.status_code}: {detail}")
        return resp.json()

    # ------------------------------------------------------------------
    # תור מקומי
    # ------------------------------------------------------------------

    def _enqueue(self, action: str, body: str) -> None:
        entry = {
            "action": action,
            "body": body,
            "attempts": 0,
            "created_at": time.time(),
        }
        # שם קובץ ממוין לפי זמן — הניקוז שומר על סדר השיחה.
        name = f"{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}.json"
        tmp = self._queue_dir / (name + ".tmp")
        tmp.write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
        # כתיבה אטומית: rename אחרי כתיבה מלאה. בלי זה, קריסה באמצע
        # הכתיבה משאירה קובץ חצי-JSON שהניקוז ייכשל עליו לנצח.
        os.replace(tmp, self._queue_dir / name)

    def queue_depth(self) -> int:
        try:
            return len(list(self._queue_dir.glob("*.json")))
        except OSError:
            return 0

    async def drain(self) -> int:
        """שולח מחדש מה שממתין. מוחזר מספר הבקשות שנשלחו בהצלחה."""
        if not self.settings.crm_configured:
            return 0
        # מנעול: שני ניקוזים במקביל היו שולחים את אותה בקשה פעמיים.
        if self._drain_lock.locked():
            return 0

        sent = 0
        async with self._drain_lock:
            for path in sorted(self._queue_dir.glob("*.json")):
                try:
                    entry = json.loads(path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    log.error("queue_entry_corrupt", extra={"file": path.name})
                    path.unlink(missing_ok=True)
                    continue

                try:
                    await self._send(entry["body"])
                    path.unlink(missing_ok=True)
                    sent += 1
                except CrmRejected as exc:
                    # דחייה סופית — אין טעם לשמור. נרשם כדי שלא ייעלם בשקט.
                    log.error("queue_entry_rejected", extra={
                        "action": entry.get("action"), "error": str(exc)})
                    path.unlink(missing_ok=True)
                except Exception as exc:  # noqa: BLE001
                    entry["attempts"] = int(entry.get("attempts", 0)) + 1
                    if entry["attempts"] >= self.settings.queue_max_retries:
                        # ⚠ נמחק **אחרי** רישום מפורש. פנייה שאבדה בשקט
                        # במשרד עורכי דין היא נזק ללקוח; לוג הוא המינימום.
                        log.error("queue_entry_dead", extra={
                            "action": entry.get("action"),
                            "attempts": entry["attempts"], "error": str(exc)})
                        path.unlink(missing_ok=True)
                    else:
                        path.write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
                    # הפסקה בניסיון הראשון שנכשל: אם ה-CRM עדיין למטה, אין
                    # טעם לעבור על כל התור ולצבור ניסיונות על כולם.
                    break
        return sent

    # ------------------------------------------------------------------
    # נוחות
    # ------------------------------------------------------------------

    async def heartbeat(self, *, active_calls: int, version: str) -> dict[str, Any]:
        return await self.call("heartbeat", {
            "version": version,
            "components": self.settings.components(),
            "active_calls": active_calls,
            "queued_events": self.queue_depth(),
            "last_error": "; ".join(self.settings.problems()) or None,
        }, queue_on_failure=False)  # heartbeat מיושן חסר ערך — לא נשמר בתור


def _safe_error(resp: httpx.Response) -> str:
    """הודעת השגיאה, בלי לגרור גוף ענק ובלי סודות אפשריים ללוג."""
    try:
        data = resp.json()
        return str(data.get("error") or data.get("code") or "")[:300]
    except Exception:  # noqa: BLE001
        return resp.text[:300]
