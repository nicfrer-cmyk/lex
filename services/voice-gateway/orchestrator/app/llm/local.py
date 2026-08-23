"""מודלים מקומיים — Ollama ו-vLLM.

## מתי להשתמש בהם
כשההשהיה של סבב לענן הופכת את השיחה ללא טבעית. שיחת טלפון סובלת ~800ms;
מעבר לכך המתקשר מתחיל לדבר שוב.

## ⚠ המגבלה שאסור לחצות
מודל מקומי **לא כותב ל-CRM**. הוא מנסח תשובה; כל פעולה — ליד, משימה,
פגישה — עוברת דרך `tool.execute` בשער הכלים, עם אותה בדיקת הרשאות ואותו
רישום. מודל שרץ על השרת של המשרד אינו מהימן יותר ממודל בענן; הוא רק
קרוב יותר.

שני המימושים מדברים ב-OpenAI-compatible chat API, שגם Ollama וגם vLLM
חושפים. לכן ההבדל ביניהם הוא כתובת ושם מודל, לא קוד.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

from ..telemetry.logging import get_logger
from .base import LLMProvider, LlmTurn, ToolCall

log = get_logger(__name__)


class OpenAiCompatibleLLM(LLMProvider):
    """בסיס משותף ל-Ollama ול-vLLM."""

    def __init__(self, base_url: str, model: str, timeout: int = 30) -> None:
        self._base = base_url.rstrip("/")
        self._model = model
        self._timeout = timeout

    @property
    def _endpoint(self) -> str:
        return f"{self._base}/v1/chat/completions"

    async def generate(self, system: str, messages: list[dict[str, Any]],
                       tools: list[dict[str, Any]] | None = None) -> LlmTurn:
        body: dict[str, Any] = {
            "model": self._model,
            "messages": [{"role": "system", "content": system}] + _to_chat(messages),
            # בשיחת טלפון תשובה ארוכה היא תשובה גרועה. הגבלה קשיחה עדיפה
            # על הנחיה בלבד — הנחיה נשברת, תקרה לא.
            "max_tokens": 220,
            "temperature": 0.3,
            "stream": False,
        }
        if tools:
            body["tools"] = [{"type": "function", "function": t} for t in tools]

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(self._endpoint, json=body)
            resp.raise_for_status()
            data = resp.json()

        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        calls: list[ToolCall] = []
        for i, tc in enumerate(message.get("tool_calls") or []):
            fn = tc.get("function") or {}
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except json.JSONDecodeError:
                # ⚠ מודל מקומי מייצר JSON שבור לא פעם. פעולה עם ארגומנטים
                # שלא נקראו היא פעולה על נתונים שגויים — עדיף לדלג ולתת
                # לשער הכלים לא לראות אותה כלל.
                log.warning("local_llm_bad_tool_args", extra={"tool": fn.get("name")})
                continue
            calls.append(ToolCall(id=tc.get("id") or f"local_{i}",
                                  name=fn.get("name", ""), input=args))

        return LlmTurn(
            text=(message.get("content") or "").strip(),
            tool_calls=calls,
            done=choice.get("finish_reason") == "stop" and not calls,
        )

    async def stream(self, system: str, messages: list[dict[str, Any]]):
        body = {
            "model": self._model,
            "messages": [{"role": "system", "content": system}] + _to_chat(messages),
            "max_tokens": 220,
            "temperature": 0.3,
            "stream": True,
        }
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            async with client.stream("POST", self._endpoint, json=body) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line.startswith("data: "):
                        continue
                    chunk = line[6:].strip()
                    if chunk == "[DONE]":
                        break
                    try:
                        delta = json.loads(chunk)["choices"][0]["delta"]
                    except (json.JSONDecodeError, KeyError, IndexError):
                        continue
                    if delta.get("content"):
                        yield delta["content"]

    async def tool_call(self, system: str, messages: list[dict[str, Any]],
                        tools: list[dict[str, Any]]) -> list[ToolCall]:
        return (await self.generate(system, messages, tools)).tool_calls


class OllamaLLM(OpenAiCompatibleLLM):
    name = "ollama"
    is_mock = False

    def __init__(self, base_url: str = "http://127.0.0.1:11434",
                 model: str = "llama3.1:8b") -> None:
        super().__init__(base_url, model)


class VllmLLM(OpenAiCompatibleLLM):
    name = "vllm"
    is_mock = False

    def __init__(self, base_url: str = "http://127.0.0.1:8000", model: str = "") -> None:
        super().__init__(base_url, model)


def _to_chat(messages: list[dict[str, Any]]) -> list[dict[str, str]]:
    """הפורמט הפנימי → הפורמט של chat API."""
    out: list[dict[str, str]] = []
    for m in messages:
        role = m.get("role")
        if role == "caller":
            out.append({"role": "user", "content": m.get("text", "")})
        elif role == "agent":
            out.append({"role": "assistant", "content": m.get("text", "")})
        elif "content" in m:
            out.append({"role": role or "user", "content": str(m["content"])})
    return out
