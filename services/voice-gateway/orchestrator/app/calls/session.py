"""שיחה אחת — מצב, תורות, והפרעה.

## מה כאן ומה לא
כאן: מצב הערוץ, זרם האודיו, והתיאום בין STT, המודל ו-TTS.
**לא כאן**: מה לומר, למי, ומה ליצור. זה חי ב-CRM ומגיע דרך
`LLMProvider`. ההפרדה היא מה שמאפשר לשיחת סימולציה מהדפדפן לעבור
באותו קוד בדיוק כמו שיחת טלפון.

## מכונת המצבים
    listening → transcribing → thinking → (waiting_for_tool) → speaking → listening

כל מעבר מדווח ל-CRM, כדי שציר הזמן יראה **מה** קרה ולא רק מתי. וכל
מעבר נמדד, כי בשיחה קולית השהיה היא תכונת המוצר המרכזית ובלי מדידה
לכל שלב אי אפשר לדעת מי הצוואר.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum

from ..audio.vad import BargeInConfig, BargeInPolicy, TurnConfig, TurnDetector
from ..llm.base import LLMProvider
from ..stt.base import STTProvider
from ..telemetry.logging import get_logger, set_call_id
from ..tts.base import TTSProvider, TTSUnavailable

log = get_logger(__name__)


class CallState(str, Enum):
    RINGING = "ringing"
    ANSWERING = "answering"
    LISTENING = "listening"
    TRANSCRIBING = "transcribing"
    THINKING = "thinking"
    SPEAKING = "speaking"
    WAITING_FOR_TOOL = "waiting_for_tool"
    ON_HOLD = "on_hold"
    COMPLETING = "completing"
    ENDED = "ended"
    FAILED = "failed"


@dataclass
class TurnMetrics:
    """מדדי תור אחד. נשלחים ל-CRM יחד עם הטקסט."""
    turn_index: int = 0
    stt_latency_ms: int = 0
    tts_first_audio_ms: int = 0
    tts_total_ms: int = 0
    interrupted: bool = False

    def as_payload(self) -> dict:
        return {
            "turn_index": self.turn_index,
            "stt_latency_ms": self.stt_latency_ms or None,
            "tts_first_audio_ms": self.tts_first_audio_ms or None,
            "tts_total_ms": self.tts_total_ms or None,
            "interrupted": self.interrupted,
        }


@dataclass
class CallSession:
    channel_id: str
    caller_number: str
    called_number: str
    crm_call_id: str = ""
    media_id: str = ""
    audio_uuid: str = ""
    state: CallState = CallState.RINGING
    started_at: float = field(default_factory=time.monotonic)
    turns: int = 0
    speaking: bool = False
    followup_required: bool = False
    interruptions: int = 0
    silence_events: int = 0

    @property
    def duration_seconds(self) -> int:
        return int(time.monotonic() - self.started_at)


class CallRunner:
    """מריץ שיחה אחת: אודיו → תמלול → CRM → הקראה."""

    def __init__(self, session: CallSession, stt: STTProvider, llm: LLMProvider,
                 tts: TTSProvider, transport, report_event,
                 max_turns: int = 30,
                 silence_timeout_ms: int = 8000,
                 barge_in_enabled: bool = True) -> None:
        self._s = session
        self._stt = stt
        self._llm = llm
        self._tts = tts
        self._transport = transport
        self._report = report_event
        self._max_turns = max_turns

        self._turn = TurnDetector(config=TurnConfig(silence_timeout_ms=silence_timeout_ms))
        self._barge = BargeInPolicy(BargeInConfig(
            # ⚠ אם התעבורה אינה תומכת בהפסקת השמעה, barge-in **מכובה**.
            # מדיניות שמסמנת הפרעה בלי יכולת להשתיק הייתה מייצרת מצב
            # שבו הסוכנת ממשיכה לדבר ואנחנו מאזינים בו-זמנית — כלומר
            # התמלול קולט את הקול שלה עצמה.
            enabled=barge_in_enabled and getattr(transport, 'supports_barge_in', False),
        ))
        self._speak_task: asyncio.Task | None = None
        self._metrics = TurnMetrics()
        self._speech_ended_at: float | None = None

    # ------------------------------------------------------------------

    async def start(self, greeting: str) -> None:
        set_call_id(self._s.crm_call_id or self._s.channel_id)
        await self._stt.start_stream(self._s.audio_uuid or self._s.channel_id)
        self._s.state = CallState.LISTENING
        self._turn.start_listening()
        await self._report("LISTENING_STARTED", state="listening")
        if greeting:
            await self._speak(greeting)

    async def on_audio(self, pcm: bytes) -> None:
        """פריים אודיו מהמתקשר."""
        stream_id = self._s.audio_uuid or self._s.channel_id

        # ---- הפרעה ----
        # ⚠ נבדק **לפני** הכל, ורק בזמן שהסוכנת מדברת. אם המתקשר התחיל
        # לדבר, המשפט הנוכחי כבר לא רלוונטי — והמשך השמעתו הוא בדיוק
        # מה שגורם לאנשים לנתק.
        if self._s.speaking:
            if self._barge.push(pcm):
                await self._handle_barge_in()
            # האודיו עדיין מוזן ל-STT: מה שנאמר תוך כדי הוא חלק מהתור.
            await self._stt.push_audio(stream_id, pcm)
            return

        await self._stt.push_audio(stream_id, pcm)

        event = self._turn.push(pcm)
        if event == "speech_start":
            await self._report("USER_SPEECH_STARTED")
        elif event == "silence_timeout":
            self._s.silence_events += 1
            await self._report("SILENCE_TIMEOUT")
            await self._speak("אתה עדיין איתי?")
        elif event == "turn_end":
            self._speech_ended_at = time.monotonic()
            await self._report("USER_SPEECH_ENDED")
            await self._consume_turn(stream_id)

    async def _consume_turn(self, stream_id: str) -> None:
        """סוגר תמלול ומעביר את התור למודל."""
        self._s.state = CallState.TRANSCRIBING
        await self._report("STT_STARTED", state="transcribing")
        stt_started = time.monotonic()

        # ⚠ ממתינים לתמלול הסופי, אך לא לנצח. מנוע שנתקע לא יכול להשאיר
        # את המתקשר מול שקט; אחרי התקרה ממשיכים בלי המקטע ומסמנים את
        # השיחה כדורשת השלמה ידנית.
        final = None
        deadline = time.monotonic() + 6.0
        while time.monotonic() < deadline:
            final = await self._stt.get_final_transcript(stream_id)
            if final and final.text.strip():
                break
            await asyncio.sleep(0.05)

        self._metrics.stt_latency_ms = int((time.monotonic() - stt_started) * 1000)
        await self._report("STT_COMPLETED", payload={"ms": self._metrics.stt_latency_ms})

        if not final or not final.text.strip():
            log.warning("stt_empty_turn")
            self._s.followup_required = True
            self._turn.start_listening()
            self._s.state = CallState.LISTENING
            return

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
        self._metrics.turn_index = self._s.turns - 1
        self._s.state = CallState.THINKING
        await self._report("LLM_STARTED", state="thinking")
        log.info("caller_utterance", extra={"turn": self._s.turns, "chars": len(text)})

        turn = await self._llm.generate(
            system="",
            messages=[{
                "role": "caller", "call_id": self._s.crm_call_id,
                "text": text, "confidence": confidence,
                "metrics": self._metrics.as_payload(),
            }],
        )
        await self._report("LLM_FIRST_TOKEN")

        if turn.tool_calls:
            self._s.state = CallState.WAITING_FOR_TOOL
            await self._report("TOOL_COMPLETED", state="waiting_for_tool",
                               payload={"tools": [t.name for t in turn.tool_calls]})

        if turn.text:
            await self._speak(turn.text)
        if turn.done:
            self._s.state = CallState.COMPLETING
        else:
            self._turn.start_listening()
            self._s.state = CallState.LISTENING
            await self._report("LISTENING_STARTED", state="listening")

        # איפוס לתור הבא.
        self._metrics = TurnMetrics(turn_index=self._s.turns)

    # ------------------------------------------------------------------
    # דיבור והפרעה
    # ------------------------------------------------------------------

    async def _speak(self, text: str) -> None:
        """מקריא, ומשחרר את הנעילה גם אם משהו נכשל באמצע."""
        self._s.speaking = True
        self._s.state = CallState.SPEAKING
        self._barge.on_speech_started()
        await self._report("TTS_STARTED", state="speaking")

        started = time.monotonic()
        first_audio = True
        try:
            async for chunk in self._tts.stream(text):
                if not self._s.speaking:
                    # בוטל ע"י barge-in.
                    break
                await self._transport.send_audio(self._s.audio_uuid, chunk)
                if first_audio:
                    first_audio = False
                    self._metrics.tts_first_audio_ms = int((time.monotonic() - started) * 1000)
                    await self._report("TTS_FIRST_AUDIO",
                                       payload={"ms": self._metrics.tts_first_audio_ms})
            self._metrics.tts_total_ms = int((time.monotonic() - started) * 1000)
            await self._report("TTS_COMPLETED", payload={"ms": self._metrics.tts_total_ms})
        except TTSUnavailable as exc:
            # ⚠ נכשל ברעש: השיחה ממשיכה, אבל היא מסומנת כדורשת טיפול
            # ידני, כי המתקשר לא שמע את מה שנאמר לו.
            self._s.followup_required = True
            log.error("tts_unavailable", extra={"detail": str(exc)})
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            self._s.followup_required = True
            log.exception("tts_failed")
        finally:
            self._s.speaking = False
            self._barge.on_speech_stopped()

    async def _handle_barge_in(self) -> None:
        """המתקשר התחיל לדבר בזמן שהסוכנת מדברת.

        סדר הפעולות אינו שרירותי:
          1. לסמן שהיא כבר לא מדברת — הלולאה ב-_speak תצא.
          2. לבטל את ההשמעה בתעבורה.
          3. לרוקן מה שכבר נשלח, ככל שאפשר.
          4. רק אז לחזור להקשבה ולפתוח תור חדש.

        היפוך הסדר היה משאיר פריימים בדרך אחרי שכבר עברנו להקשבה —
        כלומר ה-STT היה קולט את הקול של הסוכנת עצמה.
        """
        self._s.speaking = False
        self._s.interruptions += 1
        self._metrics.interrupted = True

        await self._transport.cancel_speech(self._s.audio_uuid)
        await self._transport.flush_output(self._s.audio_uuid)

        log.info("barge_in", extra={"turn": self._s.turns})
        await self._report("BARGE_IN", state="listening",
                           payload={"turn": self._s.turns})

        self._turn.start_listening()
        self._s.state = CallState.LISTENING

    # ------------------------------------------------------------------

    async def stop(self) -> None:
        if self._speak_task and not self._speak_task.done():
            self._speak_task.cancel()
        await self._stt.end_stream(self._s.audio_uuid or self._s.channel_id)
        set_call_id(None)
