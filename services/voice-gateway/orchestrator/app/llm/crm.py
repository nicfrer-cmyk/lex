"""המימוש שהוא ברירת המחדל: הסוכן רץ ב-CRM.

תור אחד = בקשה אחת ל-`call.utterance`. ה-CRM מריץ שם את המודל, את שער
הכלים, את בדיקות ההרשאה, את מנוע הדחיפות ואת הכתיבה — ומחזיר את מה
שצריך לומר בטלפון.

⚠ המשמעות המעשית: שיחת טלפון אמיתית ושיחת סימולציה מהדפדפן מגיעות
לאותה פונקציה ב-CRM. אין "לוגיקה של טלפוניה" ו"לוגיקה של בדיקה". זו
הסיבה שאפשר לסמוך על מצב הבדיקה — הוא לא בודק חיקוי, הוא בודק את
המערכת.
"""

from __future__ import annotations

from typing import Any

from ..capabilities import LatencyTracker, ProviderStatus
from ..crm.client import CrmClient, CrmUnavailable
from ..telemetry.logging import get_logger
from .base import LLMProvider, LlmTurn, ToolCall

log = get_logger(__name__)

# מה שנאמר כשה-CRM לא זמין. ⚠ לא ניתוק: מתקשר שנותק בשקט מפסיק לסמוך על
# המשרד. משפט אחד ישר עדיף על שתיקה, וה-CRM ייצור משימה מהתור המקומי
# ברגע שיחזור.
_FALLBACK = ("אני מתנצלת, יש תקלה זמנית במערכת. הפנייה שלך נרשמה "
             "ועורך הדין יחזור אליך בהקדם.")


class CrmLlmProvider(LLMProvider):
    name = "crm"
    is_mock = False

    def __init__(self, crm: CrmClient) -> None:
        self._crm = crm
        self._latency = LatencyTracker()
        self._healthy = True

    async def generate(self, system: str, messages: list[dict[str, Any]],
                       tools: list[dict[str, Any]] | None = None) -> LlmTurn:
        """`messages` חייב לכלול `call_id` ו-`text` בפריט האחרון."""
        last = messages[-1] if messages else {}
        call_id = last.get("call_id")
        text = last.get("text", "")
        if not call_id:
            raise ValueError("CrmLlmProvider דורש call_id בהודעה")

        import time
        started = time.monotonic()
        try:
            data = await self._crm.call("call.utterance", {
                "call_id": call_id,
                "text": text,
                "confidence": last.get("confidence"),
                "metrics": last.get("metrics") or {},
            })
            self._latency.record(int((time.monotonic() - started) * 1000))
            self._healthy = True
        except CrmUnavailable:
            self._healthy = False
            # הבקשה כבר בתור המקומי. אומרים משהו וממשיכים.
            log.warning("crm_turn_queued_fallback", extra={"call_id": call_id})
            return LlmTurn(text=_FALLBACK, done=True)

        # הפעולות כבר בוצעו בצד ה-CRM — הן מוחזרות לתיעוד ולא לביצוע כאן.
        tool_calls = [
            ToolCall(id=f"crm_{i}", name=a.get("tool", ""), input={})
            for i, a in enumerate(data.get("actions") or [])
        ]
        return LlmTurn(
            text=data.get("reply") or "",
            tool_calls=tool_calls,
            done=bool(data.get("done")),
            category=data.get("category"),
            urgency=data.get("urgency"),
            cost_usd=float(data.get("costUsd") or 0),
        )

    async def stream(self, system: str, messages: list[dict[str, Any]]):
        # ה-CRM מחזיר תור שלם. הזרמה תתאפשר כשיתווסף שם נתיב זורם;
        # עד אז — תשובה אחת, מה שעדיין נכון ולא מתחזה לזרם.
        turn = await self.generate(system, messages)
        if turn.text:
            yield turn.text

    async def tool_call(self, system: str, messages: list[dict[str, Any]],
                        tools: list[dict[str, Any]]) -> list[ToolCall]:
        turn = await self.generate(system, messages, tools)
        return turn.tool_calls

    def capabilities(self) -> ProviderStatus:
        # ⚠ הסוכן רץ **בצד ה-CRM**, ולכן מוכנותו נקבעת שם (יש מפתח
        # מודל או אין). הדיווח כאן מתאר את הערוץ בלבד; ה-CRM דורס אותו
        # במצב האמיתי של המודל — ראה collectSnapshot ב-call-center.
        return ProviderStatus(
            type='llm', name='crm-agent', mode='real',
            healthy=self._healthy,
            production_ready=self._healthy,
            supports_streaming=False,
            supports_hebrew=True,
            average_latency_ms=self._latency.average_ms,
            message='' if self._healthy else 'ה-CRM אינו זמין',
        )
