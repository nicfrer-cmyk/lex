"""WebSocket Media — שלד מלא, לא ממומש בפועל.

## למה הוא כאן אם הוא לא עובד
כדי שהמעבר אליו יהיה החלפת משתנה סביבה ולא שכתוב. הממשק מלא, ה-health
מלא, ונקודות ההרחבה מסומנות — מה שחסר הוא הקישור ל-Asterisk, שדורש
בחירה בין שני פרוטוקולים שונים לחלוטין (ראה למטה) ולכן אין טעם לנחש
אותה מראש.

## ⚠ מה שהוא **לא** עושה
הוא לא מדווח על עצמו כמוכן. `production_ready=False` תמיד, וההודעה
אומרת במפורש שהוא שלד. מנוע המוכנות חוסם לפיו, ולכן אי אפשר להדליק
שיחות אמיתיות בטעות מעליו — וזה בדיוק ההבדל בין שלד לבין מלכודת.

## מה יידרש כשמממשים
Asterisk מציע שני נתיבים, ובחירה ביניהם היא החלטה תפעולית:

  1. `chan_websocket` (Asterisk 22+) — ערוץ מדיה דו-כיווני מובנה.
     הנקי יותר, אך דורש בנייה עם התמיכה מופעלת.
  2. External Media עם `transport=websocket` — עובד גם בבנייה סטנדרטית,
     אך ה-framing שונה מ-AudioSocket ודורש התאמה.

בשני המקרים מה שמשתנה הוא `_recv_loop` ו-`send_audio` בלבד. שאר
המערכת — ה-Orchestrator, ה-VAD, ה-barge-in — אינה יודעת מי מזיז את
הבייטים, וזו כל הנקודה של השכבה הזו.
"""

from __future__ import annotations

import asyncio

from ..telemetry.logging import get_logger
from .base import AudioHandler, MediaSession, MediaTransport, TransportHealth

log = get_logger(__name__)


class WebSocketMediaTransport(MediaTransport):
    name = "websocket"
    supports_barge_in = True

    def __init__(self, host: str, port: int, path: str = "/media") -> None:
        self._host = host
        self._port = port
        self._path = path
        self._on_audio: AudioHandler | None = None
        self._sessions: dict[str, MediaSession] = {}
        self._sockets: dict[str, object] = {}
        self._cancel: dict[str, bool] = {}
        self._server: asyncio.AbstractServer | None = None

    async def start(self, on_audio: AudioHandler) -> None:
        self._on_audio = on_audio
        # ⚠ לא מאזין בפועל. הפעלת שרת שמקבל חיבורים ואינו מעביר אודיו
        # גרועה מהיעדרו: Asterisk היה מתחבר בהצלחה, השיחה הייתה נענית,
        # ואיש לא היה שומע דבר — כולל אותנו.
        log.warning("websocket_transport_not_implemented", extra={
            "host": self._host, "port": self._port, "path": self._path,
            "note": "שלד בלבד — ראה docs/AI_CALL_CENTER.md",
        })

    async def stop(self) -> None:
        if self._server:
            self._server.close()
            self._server = None
        self._sessions.clear()
        self._sockets.clear()
        self._cancel.clear()

    async def start_session(self, session: MediaSession) -> None:
        self._sessions[session.session_id] = session
        self._cancel[session.session_id] = False

    async def end_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)
        self._sockets.pop(session_id, None)
        self._cancel.pop(session_id, None)

    async def send_audio(self, session_id: str, pcm: bytes) -> None:
        raise NotImplementedError(
            "WebSocketMediaTransport הוא שלד. יש להגדיר MEDIA_TRANSPORT=audiosocket.")

    async def cancel_speech(self, session_id: str) -> None:
        self._cancel[session_id] = True

    async def flush_output(self, session_id: str) -> None:
        await self.cancel_speech(session_id)

    def is_connected(self, session_id: str) -> bool:
        return session_id in self._sockets

    def health(self) -> TransportHealth:
        return TransportHealth(
            name=self.name,
            # healthy=True: המודול נטען ולא קרס. זו בדיוק ההבחנה
            # שהמפרט דורש — "השירות פועל" אינו "אפשר לענות איתו לטלפון".
            healthy=True,
            production_ready=False,
            mode="skeleton",
            connected_sessions=0,
            supports_barge_in=True,
            message="שלד בלבד — ערוץ WebSocket טרם מומש. יש להשתמש ב-AudioSocket.",
        )
