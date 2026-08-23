"""לוגים מובנים, עם correlation id ובלי סודות.

## שני כללים שאינם ניתנים למשא ומתן

1. **`call_id` בכל שורה.** שיחה נוגעת ב-Asterisk, ב-STT, ב-CRM, בכלים
   וב-TTS. בלי מזהה משותף, ניפוי של שיחה אחת מתוך לוג של יום שלם הוא
   חיפוש לפי חותמת זמן — כלומר בלתי אפשרי כששתי שיחות רצות במקביל.

2. **אין סודות בלוג.** המסנן למטה חותך ערכים שנראים כמו מפתחות, סיסמאות
   וחתימות. הוא לא תחליף לזהירות, אבל הוא תופס את השורה שמישהו יוסיף
   בשלוש בבוקר כדי "רק לראות מה נשלח".

⚠ תוכן השיחה עצמו גם הוא לא נכנס ללוג. מה שנאמר בשיחה עם משרד עורכי דין
חי בתמלול, תחת מדיניות שמירה ובקרת גישה — לא בקובץ טקסט על השרת.
"""

from __future__ import annotations

import json
import logging
import re
import sys
from contextvars import ContextVar
from typing import Any

_call_id: ContextVar[str | None] = ContextVar("call_id", default=None)

# מפתחות שערכם לעולם לא נרשם.
_SECRET_KEYS = re.compile(
    r"(secret|password|passwd|token|api[_-]?key|signature|authorization|credential)",
    re.IGNORECASE)

# ערכים שנראים כמו סוד גם כשהמפתח תמים.
_SECRET_VALUE = re.compile(r"(sk-[A-Za-z0-9_\-]{16,}|[A-Fa-f0-9]{40,})")

_RESERVED = {
    "name", "msg", "args", "levelname", "levelno", "pathname", "filename",
    "module", "exc_info", "exc_text", "stack_info", "lineno", "funcName",
    "created", "msecs", "relativeCreated", "thread", "threadName",
    "processName", "process", "taskName", "message", "asctime",
}


def set_call_id(value: str | None) -> None:
    """קושר את השורות הבאות לשיחה. נקרא בתחילת טיפול בשיחה."""
    _call_id.set(value)


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            k: ("***" if _SECRET_KEYS.search(str(k)) else redact(v))
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(v) for v in value]
    if isinstance(value, str):
        return _SECRET_VALUE.sub("***", value)[:2000]
    return value


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "event": record.getMessage(),
        }
        cid = _call_id.get()
        if cid:
            payload["call_id"] = cid
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith("_"):
                payload[key] = redact(value)
        if record.exc_info:
            payload["error"] = self.formatException(record.exc_info)[:2000]
        return json.dumps(payload, ensure_ascii=False)


def configure(level: str = "INFO") -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers.clear()
    root.addHandler(handler)
    root.setLevel(getattr(logging, level.upper(), logging.INFO))
    # httpx מדפיס כל בקשה עם URL מלא. ה-URL מכיל את מזהה המשרד, וברמת
    # INFO זה רעש שמסתיר את מה שחשוב.
    logging.getLogger("httpx").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)
