"""הלקוח היחיד שמדבר עם ה-CRM.

## למה Outbox מתמיד
המפרט מחייב: "אם CRM לא זמין — שמור Local Queue ונסה Retry בצורה
מבוקרת". הסיבה קונקרטית: תקלת רשת של חמש שניות באמצע שיחה לא יכולה
למחוק את העובדה שהתקשר לקוח. הבקשה נשמרת ל-SQLite, נשלחת שוב, והשיחה
ממשיכה. `docker compose restart` באמצע היום לא מוחק אותה.

## למה זה בטוח
ה-CRM אידמפוטנטי בכל נתיב שמשנה נתונים: `external_call_id` ייחודי
לשיחה, `(call_id, sequence)` לקטע תמלול, ו-`(office_id,
idempotency_key)` לפקודה. מפתח הפקודה נגזר מהתוכן ומ-`tool_call_id`,
ולכן שליחה חוזרת של "קבע פגישה" מחזירה את הפגישה הקיימת במקום ליצור
שנייה. בלי זה, תור עם retry היה מנגנון לייצור פגישות כפולות.

## מה לא עובר כאן
service_role key, גישה ל-Postgres, ו-SQL. אין. השירות שולח פעולות
בשם, וה-CRM מחליט.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any

import httpx

from ..config import Settings
from ..security.signer import build_headers
from ..telemetry.logging import get_logger
from .outbox import Outbox

log = get_logger(__name__)


class CrmUnavailable(RuntimeError):
    """ה-CRM לא ענה. הבקשה נשמרה ב-Outbox ותישלח שוב."""


class CrmRejected(RuntimeError):
    """ה-CRM ענה ודחה. ⚠ לא נכנס לתור — retry על 4xx רק יחזור על הדחייה."""

    def __init__(self, message: str, code: str | None = None,
                 retryable: bool = False) -> None:
        super().__init__(message)
        self.code = code
        self.retryable = retryable


class CrmClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.outbox = Outbox(
            f"{settings.queue_path.rstrip('/')}/outbox.db", settings.queue_max_retries)
        self._client: httpx.AsyncClient | None = None
        self._drain_lock = asyncio.Lock()

    async def start(self) -> None:
        await self.outbox.start()
        self._client = httpx.AsyncClient(timeout=self.settings.http_timeout)

    async def close(self) -> None:
        if self._client:
            await self._client.aclose()
            self._client = None
        await self.outbox.close()

    # ------------------------------------------------------------------

    async def call(self, action: str, payload: dict[str, Any], *,
                   queue_on_failure: bool = True,
                   idempotency_key: str | None = None,
                   tool_call_id: str | None = None,
                   call_id: str | None = None) -> dict[str, Any]:
        """פעולה אחת מול ה-CRM."""
        if not self.settings.crm_configured:
            raise CrmUnavailable("ה-CRM לא הוגדר (CRM_BASE_URL / OFFICE_ID / SECRET)")

        body = json.dumps({"action": action, **payload},
                          ensure_ascii=False, separators=(",", ":"))
        try:
            return await self._send(body)
        except CrmRejected as exc:
            # ⚠ 5xx ו-429 מסווגים כ-retryable ע"י ה-CRM עצמו (VoiceError).
            # דחייה שהוא סימן כניתנת לניסיון חוזר נכנסת לתור; דחייה
            # סופית (חתימה, שדה חסר) לא — היא לא תשתנה מעצמה.
            if exc.retryable and queue_on_failure:
                await self.outbox.add(action, payload, idempotency_key=idempotency_key,
                                      tool_call_id=tool_call_id, call_id=call_id,
                                      endpoint=self.settings.crm_base_url)
                raise CrmUnavailable(str(exc)) from exc
            raise
        except Exception as exc:  # noqa: BLE001 — כל כשל רשת נכנס לתור
            if queue_on_failure:
                await self.outbox.add(action, payload, idempotency_key=idempotency_key,
                                      tool_call_id=tool_call_id, call_id=call_id,
                                      endpoint=self.settings.crm_base_url)
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

        if resp.status_code < 400:
            return resp.json()

        detail, code, retryable = _parse_error(resp)
        raise CrmRejected(f"{resp.status_code}: {detail}", code=code,
                          retryable=retryable or resp.status_code >= 500
                          or resp.status_code == 429)

    # ------------------------------------------------------------------
    # ניקוז
    # ------------------------------------------------------------------

    async def drain(self, limit: int = 10) -> int:
        """שולח מחדש מה שממתין. מוחזר מספר הבקשות שנשלחו בהצלחה."""
        if not self.settings.crm_configured:
            return 0
        # ⚠ מנעול: שני ניקוזים במקביל היו שולחים את אותה בקשה פעמיים.
        # ה-CRM אמנם אידמפוטנטי, אבל אין סיבה להישען על זה כאן.
        if self._drain_lock.locked():
            return 0

        sent = 0
        async with self._drain_lock:
            for entry in await self.outbox.next_batch(limit):
                body = json.dumps({"action": entry.action, **entry.payload},
                                  ensure_ascii=False, separators=(",", ":"))
                try:
                    await self._send(body)
                    await self.outbox.mark_completed(entry.id)
                    sent += 1
                except CrmRejected as exc:
                    if exc.retryable:
                        await self._handle_failure(entry, str(exc), exc.code)
                    else:
                        # דחייה סופית — ישר ל-dead letter, בלי לבזבז ניסיונות.
                        log.error("outbox_entry_rejected", extra={
                            "action": entry.action, "error": str(exc)})
                        await self.outbox.mark_failed(
                            entry.id, str(exc), exc.code)
                        await self._report_dead_letter(entry, str(exc), exc.code)
                except Exception as exc:  # noqa: BLE001
                    await self._handle_failure(entry, str(exc), None)
                    # ה-CRM עדיין למטה; אין טעם לעבור על כל התור ולצבור
                    # ניסיונות כושלים על כולם.
                    break
        return sent

    async def _handle_failure(self, entry, error: str, code: str | None) -> None:
        dead = await self.outbox.mark_failed(entry.id, error, code)
        if dead:
            await self._report_dead_letter(entry, error, code)

    async def _report_dead_letter(self, entry, error: str, code: str | None) -> None:
        """מדווח ל-CRM על פעולה שמיצתה את הניסיונות.

        ⚠ המפרט אוסר לאבד פעולה בשקט. מרגע שהיא ב-CRM היא מופיעה במסך
        ומישהו יכול לטפל בה. הדיווח עצמו הוא best-effort — אם גם הוא
        נכשל, הפעולה נשארת ב-SQLite ותדווח בניסיון הבא.
        """
        try:
            await self.call("deadletter.report", {
                "outbox_id": entry.id,
                "call_id": entry.call_id,
                "call_external_id": entry.call_external_id,
                "tool_call_id": entry.tool_call_id,
                "idempotency_key": entry.idempotency_key,
                "endpoint": entry.endpoint,
                "action_name": entry.action,
                "payload": entry.payload,
                "attempt_count": entry.attempt_count,
                "last_error": error,
                "error_code": code,
            }, queue_on_failure=False)
            await self.outbox.mark_reported(entry.id)
        except Exception as exc:  # noqa: BLE001
            log.error("dead_letter_report_failed", extra={
                "entry": entry.id, "error": str(exc)})

    # ------------------------------------------------------------------

    async def counts(self) -> dict[str, int]:
        return await self.outbox.counts()

    async def heartbeat(self, *, active_calls: int, version: str,
                        providers: dict[str, Any],
                        transport: str | None,
                        live_calls_accepted: bool) -> dict[str, Any]:
        counts = await self.outbox.counts()
        pending = counts.get("pending", 0) + counts.get("retrying", 0) + counts.get("sending", 0)
        return await self.call("heartbeat", {
            "version": version,
            "components": self.settings.components(),
            # ⚠ כאן עוברת ההבחנה בין healthy לבין production_ready. ספק
            # Mock מדווח healthy=true ו-production_ready=false, ומנוע
            # המוכנות ב-CRM חוסם לפי השני.
            "providers": providers,
            "transport": transport,
            "active_calls": active_calls,
            "outbox_pending": pending,
            "outbox_dead_letter": counts.get("dead_letter", 0),
            "queued_events": pending,
            "live_calls_accepted": live_calls_accepted,
            "last_error": "; ".join(self.settings.problems()) or None,
        }, queue_on_failure=False)  # heartbeat מיושן חסר ערך — לא נשמר בתור


def _parse_error(resp: httpx.Response) -> tuple[str, str | None, bool]:
    """הודעת השגיאה, הקוד, והאם ניתן לנסות שוב.

    ⚠ `retryable` מגיע מה-CRM ולא מנוחש כאן. הוא זה שיודע אם 'המועד
    תפוס' הוא סופי ואם 'התנגשות כתיבה' תסתדר בניסיון הבא.
    """
    try:
        data = resp.json()
        return (
            str(data.get("human_message") or data.get("error") or "")[:300],
            data.get("code"),
            bool(data.get("retryable")),
        )
    except Exception:  # noqa: BLE001
        return resp.text[:300], None, False
