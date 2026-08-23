"""MediaTransport — הפשטת ערוץ האודיו.

## למה זו שכבה נפרדת מ-TelephonyProvider
`TelephonyProvider` שולט ב**שיחה** (לענות, לנתק, להחזיק). `MediaTransport`
מזיז **בייטים** (לקבל אודיו, לשלוח אודיו, לעצור באמצע). באסטריסק שניהם
נראים כמו "ARI", אבל הם משתנים בקצבים שונים: אפשר לעבור מ-AudioSocket
ל-WebSocket Media בלי לגעת בדרך שבה עונים לשיחה, וזה בדיוק המעבר
שהמפרט דורש שיהיה אפשרי בלי לשנות את ה-Orchestrator.

## מה נשמר ומה נוסף
`AudioSocketServer` הקיים **לא נמחק ולא שוכתב**. `AudioSocketTransport`
עוטף אותו ומממש את הממשק הזה. `WebSocketMediaTransport` הוא שלד מלא עם
health status; הוא מצהיר על עצמו כלא מוכן לייצור כל עוד לא מומש, במקום
לדווח בריאות ולהשתתק בשיחה הראשונה.

## ⚠ cancel_speech ו-flush_output
שתי המתודות שהופכות barge-in לאפשרי. ספק שאינו תומך בהן חייב להצהיר
`supports_barge_in = False` — כי המשמעות המעשית היא שהסוכנת תמשיך
להקריא משפט שכבר לא רלוונטי בזמן שהמתקשר מדבר, וזו חוויה שגורמת
לאנשים לנתק.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Awaitable, Callable

AudioHandler = Callable[[str, bytes], Awaitable[None]]


@dataclass
class TransportHealth:
    """מצב הערוץ.

    ⚠ `healthy` ו-`production_ready` נפרדים בכוונה. שלד שמאזין לפורט
    ולא מזיז אודיו הוא healthy לחלוטין — ורק production_ready מבדיל
    אותו ממשהו שאפשר לענות איתו לטלפון.
    """
    name: str
    healthy: bool
    production_ready: bool
    mode: str = "real"
    connected_sessions: int = 0
    message: str = ""
    supports_barge_in: bool = True

    def as_dict(self) -> dict:
        return {
            "name": self.name,
            "mode": self.mode,
            "healthy": self.healthy,
            "production_ready": self.production_ready,
            "connected_sessions": self.connected_sessions,
            "supports_barge_in": self.supports_barge_in,
            "message": self.message,
        }


@dataclass
class MediaSession:
    session_id: str
    channel_id: str
    sample_rate: int = 16000
    metadata: dict = field(default_factory=dict)


class MediaTransport(abc.ABC):
    """הממשק. מימוש חדש לא דורש שינוי ב-Orchestrator."""

    name: str = "abstract"
    supports_barge_in: bool = False

    @abc.abstractmethod
    async def start(self, on_audio: AudioHandler) -> None:
        """מפעיל את השירות. `on_audio(session_id, pcm)` לכל פריים נכנס."""

    @abc.abstractmethod
    async def stop(self) -> None:
        ...

    @abc.abstractmethod
    async def start_session(self, session: MediaSession) -> None:
        """רושם שיחה. נקרא כשערוץ מדיה נפתח."""

    @abc.abstractmethod
    async def end_session(self, session_id: str) -> None:
        ...

    @abc.abstractmethod
    async def send_audio(self, session_id: str, pcm: bytes) -> None:
        """שולח אודיו למתקשר. חייב להיות ניתן להפסקה באמצע."""

    @abc.abstractmethod
    async def cancel_speech(self, session_id: str) -> None:
        """עוצר מיידית את ההשמעה הנוכחית. ליבת ה-barge-in."""

    @abc.abstractmethod
    async def flush_output(self, session_id: str) -> None:
        """מרוקן אודיו שכבר נשלח וטרם הושמע, ככל שהתעבורה מאפשרת."""

    @abc.abstractmethod
    def is_connected(self, session_id: str) -> bool:
        ...

    @abc.abstractmethod
    def health(self) -> TransportHealth:
        ...
