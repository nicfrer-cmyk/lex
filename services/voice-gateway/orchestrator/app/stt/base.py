"""STTProvider — הפשטת התמלול.

זרם, לא בקשה: המערכת צריכה תוצאה חלקית תוך כדי דיבור (כדי לדעת מתי
המשתמש סיים) ותוצאה סופית אחריו. ספק שיודע רק "קובץ → טקסט" מתעטף
במימוש שצובר אודיו ומתמלל בסוף — אבל הממשק נשאר זה.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass


@dataclass
class Transcript:
    text: str
    is_final: bool
    confidence: float | None = None
    started_at_ms: int | None = None
    ended_at_ms: int | None = None


class STTProvider(abc.ABC):
    """הממשק. מימוש חדש לא דורש שינוי בשום מקום אחר."""

    name: str = "abstract"
    is_mock: bool = False

    @abc.abstractmethod
    async def start_stream(self, call_id: str, sample_rate: int = 16000) -> None:
        """פותח זרם לשיחה. נקרא פעם אחת בתחילתה."""

    @abc.abstractmethod
    async def push_audio(self, call_id: str, pcm: bytes) -> None:
        """מזין מקטע PCM 16-bit little-endian."""

    @abc.abstractmethod
    async def get_partial_transcript(self, call_id: str) -> Transcript | None:
        """התמלול החלקי הנוכחי, אם יש. לא חוסם."""

    @abc.abstractmethod
    async def get_final_transcript(self, call_id: str) -> Transcript | None:
        """סוגר את המקטע הנוכחי ומחזיר תוצאה סופית."""

    @abc.abstractmethod
    async def end_stream(self, call_id: str) -> None:
        """משחרר משאבים. חייב להיות בטוח לקריאה כפולה."""


class MockSTTProvider(STTProvider):
    """מצב הדגמה — מצהיר על עצמו ולא מתחזה.

    ⚠ הוא **לא** ממציא טקסט. מנוע שמחזיר משפט מומצא בשיחה של משרד עורכי
    דין יגרום ליצירת ליד, משימה ופגישה על סמך דבר שאיש לא אמר. מה שמוזן
    ידנית (מצב בדיקה ב-CRM) מוחזר כמות שהוא; אודיו אמיתי מוחזר כריק.
    """

    name = "mock"
    is_mock = True

    def __init__(self) -> None:
        self._injected: dict[str, str] = {}

    def inject(self, call_id: str, text: str) -> None:
        """מזין טקסט ידנית — משמש בבדיקות מקומיות של זרימת האודיו."""
        self._injected[call_id] = text

    async def start_stream(self, call_id: str, sample_rate: int = 16000) -> None:
        self._injected.setdefault(call_id, "")

    async def push_audio(self, call_id: str, pcm: bytes) -> None:
        return None

    async def get_partial_transcript(self, call_id: str) -> Transcript | None:
        return None

    async def get_final_transcript(self, call_id: str) -> Transcript | None:
        text = self._injected.get(call_id, "")
        if not text:
            return None
        self._injected[call_id] = ""
        return Transcript(text=text, is_final=True, confidence=None)

    async def end_stream(self, call_id: str) -> None:
        self._injected.pop(call_id, None)
