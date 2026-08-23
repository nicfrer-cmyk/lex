"""TelephonyProvider — הפשטת המרכזייה.

מה שמעליה (ה-orchestrator, השיחה, הכלים) לא יודע מה זה SIP, ARI או RTP.
הוא יודע: לענות, לנתק, להחזיק, להעביר, ולהזרים אודיו.

⚠ `transfer_call` הוא היחיד כאן שיכול לגרום נזק מצטבר, ולכן הוא היחיד
שנושא בדיקה משלו בכל שכבה: ב-CRM (הכלי מסומן לא-זמין), ב-dialplan
(בדיקת יעד), וכאן (`TransferBlocked`). פעולה שלולאה שלה מייצרת ערוצים
עד קריסה לא מקבלת הגנה יחידה.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass


@dataclass
class InboundCall:
    channel_id: str
    caller_number: str
    called_number: str
    started_at: str


class TransferBlocked(RuntimeError):
    """ההעברה נחסמה — יעד חסר, או יעד שזהה למספר הציבורי."""


class TelephonyProvider(abc.ABC):
    name: str = "abstract"
    is_mock: bool = False

    @abc.abstractmethod
    async def answer_call(self, channel_id: str) -> None:
        ...

    @abc.abstractmethod
    async def end_call(self, channel_id: str) -> None:
        ...

    @abc.abstractmethod
    async def hold_call(self, channel_id: str, on: bool) -> None:
        ...

    @abc.abstractmethod
    async def transfer_call(self, channel_id: str, target: str) -> None:
        ...

    @abc.abstractmethod
    async def start_media(self, channel_id: str) -> str:
        """פותח ערוץ מדיה חיצוני ומחזיר את מזההו."""

    @abc.abstractmethod
    async def stop_media(self, media_id: str) -> None:
        ...

    @abc.abstractmethod
    async def play_audio(self, channel_id: str, pcm: bytes) -> None:
        ...

    @abc.abstractmethod
    async def test_connection(self) -> tuple[bool, str]:
        ...


class MockTelephonyProvider(TelephonyProvider):
    """אין מרכזייה מחוברת. מצהיר על עצמו ולא מתחזה."""

    name = "mock"
    is_mock = True

    async def answer_call(self, channel_id: str) -> None:
        return None

    async def end_call(self, channel_id: str) -> None:
        return None

    async def hold_call(self, channel_id: str, on: bool) -> None:
        return None

    async def transfer_call(self, channel_id: str, target: str) -> None:
        raise TransferBlocked("לא הוגדרה מרכזייה — לא ניתן להעביר שיחה")

    async def start_media(self, channel_id: str) -> str:
        return "mock-media"

    async def stop_media(self, media_id: str) -> None:
        return None

    async def play_audio(self, channel_id: str, pcm: bytes) -> None:
        return None

    async def test_connection(self) -> tuple[bool, str]:
        return False, "לא הוגדרה מרכזייה (ARI)"
