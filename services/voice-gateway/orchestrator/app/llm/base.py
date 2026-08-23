"""LLMProvider — הפשטת מנוע השפה.

## ההחלטה החשובה: ברירת המחדל היא `crm`
הסוכן, ה-prompt, רשימת הכלים המותרים, בדיקות ההרשאה, כללי הדחיפות
והכתיבה ל-CRM — כולם חיים ב-CRM. `CrmLlmProvider` מעביר את התור לשם
ומקבל בחזרה את מה שצריך לומר.

זו לא עצלות. הרצת מודל כאן הייתה יוצרת מערכת שנייה עם prompt משלה
ורשימת כלים משלה — כלומר בדיוק הפיצול שהמפרט אוסר בסימולטור, רק גרוע
יותר: שתי מערכות שצריך לעדכן במקביל, ובאחת מהן עורך הדין לא רואה מה
משתנה.

`ollama`/`vllm` שמורים למקרה קונקרטי: כשההשהיה של סבב אינטרנט הופכת את
השיחה ללא טבעית, אפשר להריץ מודל מקומי לתשובות קצרות — אבל **הכלים
ממשיכים לעבור דרך שער הכלים של ה-CRM**. מודל מקומי לעולם לא כותב ל-CRM
בעצמו.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any

from ..capabilities import ProviderStatus


@dataclass
class ToolCall:
    id: str
    name: str
    input: dict[str, Any]


@dataclass
class LlmTurn:
    """תוצאת תור אחד."""
    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    done: bool = False
    category: str | None = None
    urgency: str | None = None
    cost_usd: float = 0.0


class LLMProvider(abc.ABC):
    name: str = "abstract"
    is_mock: bool = False

    @abc.abstractmethod
    async def generate(self, system: str, messages: list[dict[str, Any]],
                       tools: list[dict[str, Any]] | None = None) -> LlmTurn:
        """תשובה אחת, בבת אחת."""

    @abc.abstractmethod
    async def stream(self, system: str, messages: list[dict[str, Any]]):
        """זרם טוקנים — כדי להתחיל להקריא לפני שהמשפט הושלם."""
        raise NotImplementedError
        yield ""  # pragma: no cover — מסמן שזו אסינכרונית-גנרטור

    @abc.abstractmethod
    async def tool_call(self, system: str, messages: list[dict[str, Any]],
                        tools: list[dict[str, Any]]) -> list[ToolCall]:
        """בקשות כלים בלבד, בלי טקסט."""

    def capabilities(self) -> ProviderStatus:
        return ProviderStatus(type='llm', name=self.name)


class MockLLMProvider(LLMProvider):
    """מצהיר על עצמו כהדגמה. אינו ממציא תוכן משפטי."""

    name = "mock"
    is_mock = True

    async def generate(self, system: str, messages: list[dict[str, Any]],
                       tools: list[dict[str, Any]] | None = None) -> LlmTurn:
        return LlmTurn(
            text="מצב הדגמה — לא הוגדר מנוע שפה. הפנייה נרשמה ועורך הדין יחזור אליך.",
            done=True)

    async def stream(self, system: str, messages: list[dict[str, Any]]):
        turn = await self.generate(system, messages)
        yield turn.text

    async def tool_call(self, system: str, messages: list[dict[str, Any]],
                        tools: list[dict[str, Any]]) -> list[ToolCall]:
        return []

    def capabilities(self) -> ProviderStatus:
        return ProviderStatus.mock(
            'llm', 'mock', 'מנוע שפה במצב הדגמה — לא ינהל שיחה אמיתית')
