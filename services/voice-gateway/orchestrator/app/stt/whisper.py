"""faster-whisper — תמלול מקומי.

## למה faster-whisper ולא whisper
אותם משקלים, מימוש CTranslate2. על CPU זה ההבדל בין תמלול שמסיים אחרי
שהמתקשר כבר ניתק לבין תמלול שמסיים בשנייה-שתיים. בשיחה חיה, השהיה היא
לא נוחות אלא תקינות.

## למה חלוקה לפי שקט ולא חלון קבוע
Whisper מתמלל **מקטע**, לא זרם. חיתוך כל 2 שניות היה חותך מילים באמצע
ומייצר "עיקו" ו-"ל" כשני מקטעים. במקום זה: צוברים עד שהדובר שותק, ואז
מתמללים משפט שלם. הגלאי כאן הוא סף אנרגיה — פשוט, ומספיק לקו טלפון
שכבר עבר סינון רעש ברשת. WebRTC VAD הוא השדרוג הבא אם יידרש.

⚠ הטעינה של המודל היא lazy ובתהליכון נפרד. טעינה ברמת המודול הייתה
מוסיפה עשרות שניות לעליית השירות גם כשמוגדר STT_PROVIDER=mock.
"""

from __future__ import annotations

import array
import asyncio
import math
import time
from typing import Any

from ..telemetry.logging import get_logger
from .base import STTProvider, Transcript

log = get_logger(__name__)

# סף האנרגיה שמתחתיו נחשב שקט. 16-bit → טווח 0..32767.
_SILENCE_RMS = 500
# כמה שקט רצוף מסמן "סיים לדבר". קצר מדי קוטע אנשים באמצע משפט; ארוך
# מדי הופך את הסוכנת לאיטית ולא טבעית.
_SILENCE_MS = 700
# תקרת אורך מקטע. גם מי שלא עוצר לנשום מקבל תשובה.
_MAX_SEGMENT_MS = 15000
_MIN_SPEECH_MS = 300


def _rms(pcm: bytes) -> float:
    if len(pcm) < 2:
        return 0.0
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


class _Stream:
    def __init__(self, sample_rate: int) -> None:
        self.sample_rate = sample_rate
        self.buffer = bytearray()
        self.silence_ms = 0
        self.speech_ms = 0
        self.started_at = time.monotonic()

    def ms(self, pcm: bytes) -> float:
        return len(pcm) / 2 / self.sample_rate * 1000


class FasterWhisperSTT(STTProvider):
    name = "faster_whisper"
    is_mock = False

    def __init__(self, model: str = "small", language: str = "he",
                 device: str = "cpu", compute_type: str = "int8") -> None:
        self._model_name = model
        self._language = language
        self._device = device
        self._compute_type = compute_type
        self._model: Any = None
        self._streams: dict[str, _Stream] = {}
        self._pending: dict[str, Transcript] = {}
        self._lock = asyncio.Lock()

    async def _ensure_model(self) -> Any:
        if self._model is not None:
            return self._model
        async with self._lock:
            if self._model is not None:
                return self._model
            from faster_whisper import WhisperModel  # ייבוא עצל, ראה docstring

            log.info("stt_model_loading", extra={"model": self._model_name})
            # to_thread: הטעינה חוסמת, ולולאת ה-asyncio מטפלת באודיו חי.
            self._model = await asyncio.to_thread(
                WhisperModel, self._model_name,
                device=self._device, compute_type=self._compute_type)
            log.info("stt_model_ready", extra={"model": self._model_name})
        return self._model

    async def start_stream(self, call_id: str, sample_rate: int = 16000) -> None:
        self._streams[call_id] = _Stream(sample_rate)
        # מחממים את המודל כבר עכשיו: הטעינה בתמלול הראשון הייתה מוסיפה
        # אותה השהיה בדיוק לרגע שבו המתקשר מחכה לתשובה הראשונה.
        asyncio.create_task(self._ensure_model())

    async def push_audio(self, call_id: str, pcm: bytes) -> None:
        stream = self._streams.get(call_id)
        if stream is None or not pcm:
            return

        stream.buffer.extend(pcm)
        chunk_ms = stream.ms(pcm)
        if _rms(pcm) < _SILENCE_RMS:
            stream.silence_ms += chunk_ms
        else:
            stream.silence_ms = 0
            stream.speech_ms += chunk_ms

        total_ms = stream.ms(bytes(stream.buffer))
        done_talking = stream.silence_ms >= _SILENCE_MS and stream.speech_ms >= _MIN_SPEECH_MS
        too_long = total_ms >= _MAX_SEGMENT_MS

        if done_talking or too_long:
            audio = bytes(stream.buffer)
            stream.buffer.clear()
            stream.silence_ms = 0
            stream.speech_ms = 0
            asyncio.create_task(self._transcribe(call_id, audio, stream.sample_rate))

    async def _transcribe(self, call_id: str, pcm: bytes, sample_rate: int) -> None:
        try:
            model = await self._ensure_model()
            audio = _pcm_to_float32(pcm)
            segments, _info = await asyncio.to_thread(
                model.transcribe, audio,
                language=self._language,
                vad_filter=True,
                beam_size=1,          # beam רחב יותר מדויק ואיטי; בשיחה חיה מהירות מנצחת
            )
            text = " ".join(s.text.strip() for s in segments).strip()
            if not text:
                return
            self._pending[call_id] = Transcript(
                text=text, is_final=True,
                ended_at_ms=int(len(pcm) / 2 / sample_rate * 1000))
        except Exception:  # noqa: BLE001
            # ⚠ תמלול שנכשל **לא מפיל את השיחה**. הסוכן ימשיך בלי המקטע
            # הזה, וה-CRM יסמן manual_followup_required בסיום.
            log.exception("stt_transcribe_failed")

    async def get_partial_transcript(self, call_id: str) -> Transcript | None:
        return None  # faster-whisper אינו זורם באמת; אין תוצאה חלקית אמיתית

    async def get_final_transcript(self, call_id: str) -> Transcript | None:
        return self._pending.pop(call_id, None)

    async def end_stream(self, call_id: str) -> None:
        self._streams.pop(call_id, None)
        self._pending.pop(call_id, None)


def _pcm_to_float32(pcm: bytes):
    """PCM 16-bit → float32 בטווח [-1, 1], כפי ש-whisper מצפה."""
    import numpy as np

    return np.frombuffer(pcm, dtype=np.int16).astype("float32") / 32768.0
