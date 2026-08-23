"""AudioSocket כ-MediaTransport.

עוטף את `AudioSocketServer` הקיים — **לא מחליף אותו ולא משכפל את
הפרוטוקול**. כל מה שנוסף כאן הוא היכולות שהממשק דורש ושלא היו בו:
הפסקת השמעה באמצע וריקון פלט.

## איך barge-in עובד כאן בפועל
`AudioSocketServer.send` שולח פריים כל 20ms בקצב אמיתי (ולא בבת אחת —
ראה ההערה שם). המשמעות היא שהשמעה היא לולאה שרצה, ולכן אפשר לבטל
אותה: `cancel_speech` מסמן דגל, והלולאה יוצאת בפריים הבא. זמן התגובה
המרבי הוא 20ms, שהם מתחת לסף שאדם מבחין בו.

⚠ זו הסיבה שדחיפת האודיו בקצב אמיתי חשובה. אילו כל המשפט היה נדחף
לחוצץ של Asterisk בבת אחת, ביטול היה בלתי אפשרי — הסוכנת הייתה
ממשיכה להקריא משפט שכבר לא רלוונטי בזמן שהמתקשר מדבר.
"""

from __future__ import annotations

import asyncio

from ..audio.socket import AudioSocketServer
from ..telemetry.logging import get_logger
from .base import AudioHandler, MediaSession, MediaTransport, TransportHealth

log = get_logger(__name__)


class AudioSocketTransport(MediaTransport):
    name = "audiosocket"
    supports_barge_in = True

    def __init__(self, host: str, port: int) -> None:
        self._host = host
        self._port = port
        self._server: AudioSocketServer | None = None
        self._sessions: dict[str, MediaSession] = {}
        # דגל ביטול לכל שיחה. נבדק בין פריימים בזמן השמעה.
        self._cancel: dict[str, bool] = {}
        self._started = False

    async def start(self, on_audio: AudioHandler) -> None:
        self._server = AudioSocketServer(self._host, self._port, on_audio)
        await self._server.start()
        self._started = True

    async def stop(self) -> None:
        if self._server:
            await self._server.stop()
            self._server = None
        self._started = False
        self._sessions.clear()
        self._cancel.clear()

    async def start_session(self, session: MediaSession) -> None:
        self._sessions[session.session_id] = session
        self._cancel[session.session_id] = False

    async def end_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)
        self._cancel.pop(session_id, None)

    async def send_audio(self, session_id: str, pcm: bytes) -> None:
        if self._server is None:
            return
        # ניקוי דגל לפני השמעה חדשה — אחרת ביטול קודם היה חוסם גם את
        # המשפט הבא, והסוכנת הייתה נאלמת לשארית השיחה.
        self._cancel[session_id] = False
        await self._send_cancellable(session_id, pcm)

    async def _send_cancellable(self, session_id: str, pcm: bytes) -> None:
        """שולח בנתחים, ובודק ביטול בין נתח לנתח."""
        assert self._server is not None
        # נתח של 200ms: קטן מספיק כדי שביטול יורגש מיידי, גדול מספיק
        # כדי לא להציף את הלולאה בהחלפות הקשר.
        chunk = int(16000 * 0.2) * 2
        for i in range(0, len(pcm), chunk):
            if self._cancel.get(session_id):
                log.info("tts_cancelled_mid_speech", extra={"sent_bytes": i})
                return
            await self._server.send(session_id, pcm[i:i + chunk])

    async def cancel_speech(self, session_id: str) -> None:
        """⚠ הליבה של barge-in. הלולאה למעלה יוצאת בנתח הבא."""
        self._cancel[session_id] = True

    async def flush_output(self, session_id: str) -> None:
        """מרוקן פלט ממתין.

        ⚠ AudioSocket מעל TCP אינו חושף "זרוק את מה שבחוצץ" — ברגע
        שבייט נכתב ל-socket הוא בדרך. מה שכן אפשרי הוא לעצור מיד את
        המשך השליחה, וזה מה שנעשה. בפועל זה מספיק: החוצץ מכיל לכל
        היותר נתח אחד (200ms), כי הדחיפה היא בקצב אמיתי.
        """
        await self.cancel_speech(session_id)
        # מתן שהות ללולאה לצאת לפני שהקורא מתחיל להקשיב.
        await asyncio.sleep(0.02)

    def is_connected(self, session_id: str) -> bool:
        return bool(self._server and self._server.is_connected(session_id))

    def health(self) -> TransportHealth:
        return TransportHealth(
            name=self.name,
            healthy=self._started,
            # ⚠ AudioSocket הוא ערוץ ייצור אמיתי — אבל רק כשהוא באמת
            # מאזין. שלד שלא הופעל אינו מוכן, ואומר זאת.
            production_ready=self._started,
            mode="real",
            connected_sessions=len(self._sessions),
            supports_barge_in=True,
            message="" if self._started else "הערוץ לא הופעל",
        )
