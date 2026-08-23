"""יכולות ומצב של ספק — הצורה שה-CRM מקבל ב-heartbeat.

## ⚠ ההבחנה שכל המודול קיים בשבילה
`healthy` ו-`production_ready` הם **שני דברים שונים**, ומיזוגם הוא
התקלה שהמפרט מזהיר מפניה במפורש.

`MockTTSProvider` בריא לחלוטין: הוא עונה, הוא מהיר, הוא לא זורק
שגיאות. הוא גם מחזיר שקט. מערכת שבודקת רק `healthy` תצבע אותו ירוק,
בעל המשרד יחבר מספר אמיתי, והלקוח הראשון לא ישמע דבר וינתק.

לכן:
    healthy          = "השירות עצמו פועל"
    production_ready = "אפשר לענות איתו לטלפון של לקוח"

מנוע המוכנות ב-CRM חוסם לפי השני. Mock מחזיר תמיד `production_ready
= False`, ו-`ProviderStatus.mock()` הוא הדרך היחידה לבנות אותו — כדי
שאי אפשר יהיה לשכוח.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class ProviderStatus:
    type: str                      # stt | llm | tts | telephony | media
    name: str
    mode: str = "real"             # real | mock | skeleton
    healthy: bool = True
    production_ready: bool = True
    supports_streaming: bool = False
    supports_barge_in: bool = False
    supports_hebrew: bool = False
    average_latency_ms: int | None = None
    message: str = ""
    extra: dict = field(default_factory=dict)

    @classmethod
    def mock(cls, type_: str, name: str, message: str = "") -> "ProviderStatus":
        """⚠ הדרך היחידה לבנות מצב Mock. production_ready נעול על False.

        לא פרמטר, לא ברירת מחדל שאפשר לדרוס — כי ההבדל בין "שכחתי
        לעדכן דגל" לבין "מערכת שמצהירה שהיא מוכנה ואינה" הוא לקוח
        שמקשיב לשקט.
        """
        return cls(
            type=type_, name=name, mode="mock",
            healthy=True,              # הוא באמת עובד
            production_ready=False,    # והוא באמת לא מתאים לייצור
            message=message or "מצב הדגמה — אינו מתאים לשיחות אמיתיות",
        )

    @classmethod
    def unavailable(cls, type_: str, name: str, message: str) -> "ProviderStatus":
        return cls(type=type_, name=name, mode="real",
                   healthy=False, production_ready=False, message=message)

    def as_dict(self) -> dict:
        return {
            "type": self.type,
            "name": self.name,
            "mode": self.mode,
            "healthy": self.healthy,
            "production_ready": self.production_ready,
            "supports_streaming": self.supports_streaming,
            "supports_barge_in": self.supports_barge_in,
            "supports_hebrew": self.supports_hebrew,
            "average_latency_ms": self.average_latency_ms,
            "message": self.message,
            **self.extra,
        }


class LatencyTracker:
    """ממוצע נע של השהיה, לדיווח ב-heartbeat.

    חלון קצר במכוון: ממוצע על כל ההיסטוריה מחליק בדיוק את ההידרדרות
    שרוצים לראות — מודל שהאט בשעה האחרונה נבלע בנתוני אתמול.
    """

    def __init__(self, window: int = 20) -> None:
        self._window = window
        self._samples: list[int] = []

    def record(self, ms: int) -> None:
        self._samples.append(int(ms))
        if len(self._samples) > self._window:
            self._samples.pop(0)

    @property
    def average_ms(self) -> int | None:
        if not self._samples:
            return None
        return round(sum(self._samples) / len(self._samples))
