"""שער הכלים — מהצד של שרת הקול.

⚠ אין כאן מימוש של אף כלי. אין כאן SQL, אין service_role key, ואין גישה
למסד הנתונים. השירות הזה **מבקש** פעולה בשם, וה-CRM מחליט אם היא מותרת
ומבצע אותה.

הסיבה: רשימת הכלים המותרים, בדיקות ההרשאה, כללי הדחיפות והרישום חיים
במקום אחד. שרת קול שהיה כותב ל-CRM בעצמו היה מנגנון שני שצריך לאבטח
ולתחזק במקביל — ובעל המשרד לא היה רואה במסך מה הוא עשה.

השכבה הזו נדרשת רק כאשר `LLM_PROVIDER` אינו `crm` (כלומר מודל מקומי
מריץ את הלולאה כאן). בברירת המחדל הכלים מופעלים בצד ה-CRM, וזה נתיב
עם פחות חלקים נעים.
"""

from __future__ import annotations

from typing import Any

from ..crm.client import CrmClient, CrmRejected, CrmUnavailable
from ..telemetry.logging import get_logger

log = get_logger(__name__)


class ToolGateway:
    def __init__(self, crm: CrmClient) -> None:
        self._crm = crm
        self._cache: list[dict[str, Any]] | None = None

    async def list_tools(self, *, refresh: bool = False) -> list[dict[str, Any]]:
        """הכלים שהסוכן רשאי להפעיל, כפי שה-CRM מגדיר אותם.

        ⚠ נטען מה-CRM ולא מרשימה קשיחה כאן. כלי שכובה במסך ההגדרות חייב
        להיעלם מיד; רשימה מקומית הייתה ממשיכה להציע אותו למודל, והבקשה
        הייתה נדחית רק בשלב הביצוע — כלומר תור מבוזבז וסוכן מבולבל.
        """
        if self._cache is not None and not refresh:
            return self._cache
        try:
            data = await self._crm.call("tools.list", {}, queue_on_failure=False)
            self._cache = [t for t in data.get("tools", [])
                           if t.get("enabled") and t.get("available")]
        except (CrmUnavailable, CrmRejected) as exc:
            # ⚠ נכשל **סגור**: בלי רשימה מאושרת, אין כלים. מודל שמקבל
            # רשימה ריקה יאסוף פרטים וידבר; מודל שמקבל רשימה מנוחשת
            # עלול לבצע פעולה שאיש לא אישר.
            log.error("tool_catalog_unavailable", extra={"error": str(exc)})
            self._cache = []
        return self._cache

    async def execute(self, call_id: str, tool: str,
                      payload: dict[str, Any]) -> dict[str, Any]:
        """מבקש ביצוע כלי. כל השערים נאכפים בצד ה-CRM."""
        if not call_id:
            return {"ok": False, "message": "חסר מזהה שיחה"}
        try:
            result = await self._crm.call("tool.execute", {
                "call_id": call_id, "tool": tool, "input": payload,
            })
            log.info("tool_executed", extra={
                "tool": tool, "status": result.get("status")})
            return result
        except CrmRejected as exc:
            log.warning("tool_rejected", extra={"tool": tool, "error": str(exc)})
            return {"ok": False, "status": "blocked", "message": str(exc)}
        except CrmUnavailable as exc:
            # ⚠ הבקשה בתור ותישלח שוב, אבל הסוכן צריך לדעת **עכשיו**
            # שהיא לא הושלמה — אחרת יאמר ללקוח "קבעתי לך פגישה" בזמן
            # שדבר לא נקבע. אמירה כזו במשרד עורכי דין היא נזק אמיתי.
            log.warning("tool_queued", extra={"tool": tool})
            return {
                "ok": False, "status": "failed",
                "message": ("הפעולה לא הושלמה כרגע ותבוצע כשהחיבור יחזור. "
                            "אין לומר למתקשר שהיא בוצעה."),
                "queued": True, "detail": str(exc),
            }

    def invalidate(self) -> None:
        self._cache = None
