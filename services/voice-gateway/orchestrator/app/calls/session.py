"""שיחה אחת — מצב ומחזור חיים.

## מה כאן ומה לא
כאן: מצב הערוץ, זרם האודיו, והתיאום בין STT ל-TTS.
**לא כאן**: מה לומר, למי, ומה ליצור. זה חי ב-CRM, ומגיע דרך
`LLMProvider`. ההפרדה הזו היא מה שמאפשר לשיחת סימולציה מהדפדפן לעבור
באותו קוד בדיוק כמו שיחת טלפון.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum

from ..llm.base import LLMProvider
from ..stt.base import STTProvider
from ..telemetry.logging import get_logger, set_call_id
from ..tts.base import TTSProvider, TTSUnavailable

log = get_logger(__name__)


class CallState(str, Enum):
    RINGING = "ringing"
    ANSWERING = "answering"
    ACTIVE = "active"
    ON_HOLD = "on_hold"
    TRANSFERRING = "transferring"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class CallSession:
    channel_id: str
    caller_number: str
    called_number: str
    # מזהה השיחה ב-CRM. נקבע בתשובה ל-call.start ומשמש כ-correlation id
    # בכל לוג ובכל בקשה מכאן והלאה.
    crm_call_id: str = ""
    media_id: str = ""
    audio_uuid: str = ""
    state: CallState = CallState.RINGING
    started_at: float = field(default_factory=time.monotonic)
    turns: int = 0
    # ⚠ ננעל בזמן שהסוכנת מדברת. בלעדיו, תמלול שמגיע באמצע התשובה היה
    # מפעיל תור שני במקביל — ושתי תשובות היו מנוגנות זו על גבי זו.
    speaking: bool = False
    followup_required: bool = False

    @property
    def duration_seconds(self) -> int:
        return int(time.monotonic() - self.started_at)


# משפט שנאמר כשמנוע ההקראה נופל. ⚠ לא ניתוק ולא שקט: מתקשר שנתקל
# בשקט מניח שהקו נפל ומנתק, והפנייה נעלמת.
_TTS_FALLBACK_NOTE = "מנוע ההקראה אינו זמין"


class CallRunner:
    """מריץ שיחה אחת: אודיו → תמלול → CRM → הקראה."""

    def __init__(self, session: CallSession, stt: STTProvider, llm: LLMProvider,
                 tts: TTSProvider, send_audio, max_turns: int = 30) -> None:
        self._s = session
        self._stt = stt
        self._llm = llm
        self._tts = tts
        self._send_audio = send_audio
        self._max_turns = max_turns

    async def start(self, greeting: str) -> None:
        set_call_id(self._s.crm_call_id or self._s.channel_id)
        await self._stt.start_stream(self._s.audio_uuid or self._s.channel_id)
        self._s.state = CallState.ACTIVE
        if greeting:
            await self._speak(greeting)

    async def on_audio(self, pcm: bytes) -> None:
        """פריים אודיו מהמתקשר."""
        stream_id = self._s.audio_uuid or self._s.channel_id
        await self._stt.push_audio(stream_id, pcm)

        # בזמן שהסוכנת מדברת אנחנו עדיין מזינים ל-STT (כדי לזהות הפרעה),
        # אבל לא פותחים תור חדש.
        if self._s.speaking:
            return

        final = await self._stt.get_final_transcript(stream_id)
        if final and final.text.strip():
            await self._handle_utterance(final.text.strip(), final.confidence)

    async def _handle_utterance(self, text: str, confidence: float | None) -> None:
        if self._s.turns >= self._max_turns:
            # ⚠ תקרה קשיחה. שיחה שנתקעת בלולאה עולה כסף בכל תור ומתסכלת
            # את המתקשר. עדיף לסגור עם משימה מאשר להמשיך ללא סוף.
            log.warning("call_max_turns_reached")
            self._s.followup_required = True
            await self._speak("אני מעבירה את הפנייה לעורך הדין, שיחזור אליך. תודה.")
            return

        self._s.turns += 1
        log.info("caller_utterance", extra={"turn": self._s.turns, "chars": len(text)})

        turn = await self._llm.generate(
            system="",
            messages=[{
                "role": "caller", "call_id": self._s.crm_call_id,
                "text": text, "confidence": confidence,
            }],
        )
        if turn.text:
            await self._speak(turn.text)
        if turn.done:
            self._s.state = CallState.COMPLETED

    async def _speak(self, text: str) -> None:
        """מקריא, ומשחרר את הנעילה גם אם משהו נכשל באמצע."""
        self._s.speaking = True
        try:
            async for chunk in self._tts.stream(text):
                await self._send_audio(chunk)
        except TTSUnavailable as exc:
            # ⚠ נכשל ברעש: השיחה ממשיכה, אבל היא מסומנת כדורשת טיפול
            # ידני, כי המתקשר לא שמע את מה שנאמר לו.
            self._s.followup_required = True
            log.error("tts_unavailable", extra={"detail": str(exc), "note": _TTS_FALLBACK_NOTE})
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            self._s.followup_required = True
            log.exception("tts_failed")
        finally:
            self._s.speaking = False

    async def stop(self) -> None:
        await self._stt.end_stream(self._s.audio_uuid or self._s.channel_id)
        set_call_id(None)
