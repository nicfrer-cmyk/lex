"""זיהוי דיבור, זיהוי תור, והפרעה.

## למה שיחה טבעית דורשת את שלושתם
אדם לא ממתין לצפצוף. הוא מתחיל לדבר כשהוא רוצה, עוצר באמצע משפט,
ולפעמים קוטע. מערכת שמניחה תורות מסודרים נשמעת כמו מענה קולי משנות
התשעים — וזו בדיוק החוויה שגורמת לאנשים לנתק ולהתקשר שוב.

## שלוש השאלות, ומי עונה עליהן
  VoiceActivityDetector — "האם מישהו מדבר עכשיו?"  (פריים בודד)
  TurnDetector          — "האם הוא סיים?"           (רצף פריימים)
  BargeInPolicy         — "האם להשתיק את הסוכנת?"   (מצב השיחה)

הפרדה זו מכוונת: הראשונה טהורה וזולה, השנייה מחזיקה מצב, והשלישית
היא **מדיניות** — היא זו שמחליטה, למשל, שרעש רקע קצר אינו הפרעה.

## ⚠ למה סף אנרגיה ולא WebRTC VAD
קו טלפון כבר עבר סינון רעש ברשת, והאות מגיע נקי יחסית. סף אנרגיה עם
היסטרזיס מספיק, ואין לו תלות בספרייה מקומפלת שצריך לבנות בתוך ה-image.
`WebRtcVad` נשאר נקודת הרחבה מסומנת למי שיצטרך יותר.

טהור: אין רשת, אין DB, אין Deno. ניתן לבדיקה ישירה.
"""

from __future__ import annotations

import array
import math
from dataclasses import dataclass
from enum import Enum

# 20ms ב-16kHz — גודל הפריים ש-Asterisk שולח.
FRAME_MS = 20
SAMPLE_RATE = 16000


def frame_rms(pcm: bytes) -> float:
    """עוצמת הפריים. 16-bit → טווח 0..32767."""
    if len(pcm) < 2:
        return 0.0
    samples = array.array("h")
    samples.frombytes(pcm[: len(pcm) - (len(pcm) % 2)])
    if not samples:
        return 0.0
    return math.sqrt(sum(s * s for s in samples) / len(samples))


@dataclass
class VadConfig:
    # ⚠ שני ספים ולא אחד. עם סף יחיד, אות שמרחף סביבו מייצר רצף של
    # speech_start/speech_end מזויפים — והסוכנת נקטעת ומתחילה מחדש
    # עשר פעמים בשנייה. היסטרזיס פותר בדיוק את זה.
    start_rms: float = 700.0
    end_rms: float = 400.0
    # כמה פריימים רצופים מעל הסף לפני שמכריזים "מדבר". מסנן נקישות,
    # שיעולים ורעש קו.
    start_frames: int = 3
    # כמה שקט לפני "סיים". קצר מדי קוטע אנשים באמצע משפט; ארוך מדי
    # הופך את הסוכנת לאיטית ולא טבעית.
    end_frames: int = 35            # ~700ms


class VoiceActivityDetector:
    """האם מישהו מדבר. פריים-פריים, עם היסטרזיס."""

    def __init__(self, config: VadConfig | None = None) -> None:
        self.config = config or VadConfig()
        self._speaking = False
        self._above = 0
        self._below = 0

    @property
    def is_speaking(self) -> bool:
        return self._speaking

    def reset(self) -> None:
        self._speaking = False
        self._above = 0
        self._below = 0

    def push(self, pcm: bytes) -> str | None:
        """מזין פריים. מחזיר 'speech_start' / 'speech_end' / None."""
        rms = frame_rms(pcm)
        c = self.config

        if not self._speaking:
            self._above = self._above + 1 if rms >= c.start_rms else 0
            if self._above >= c.start_frames:
                self._speaking = True
                self._below = 0
                return "speech_start"
            return None

        self._below = self._below + 1 if rms < c.end_rms else 0
        if self._below >= c.end_frames:
            self._speaking = False
            self._above = 0
            return "speech_end"
        return None


class TurnState(str, Enum):
    IDLE = "idle"
    LISTENING = "listening"
    USER_SPEAKING = "user_speaking"
    ENDED = "ended"


@dataclass
class TurnConfig:
    # שתיקה מוחלטת שאחריה מוותרים ומדברים. מגיע מהגדרות ה-CRM
    # (silence_timeout_ms) כדי שיהיה מקור אמת אחד.
    silence_timeout_ms: int = 8000
    # תקרת אורך תור. גם מי שלא עוצר לנשום מקבל תשובה.
    max_turn_ms: int = 30000
    min_speech_ms: int = 250


class TurnDetector:
    """מתי המתקשר סיים את התור שלו.

    מחזיק מצב על פני פריימים, ולכן נפרד מה-VAD: אותו VAD משמש גם
    לזיהוי הפרעה בזמן שהסוכנת מדברת, שם אין מושג של "תור".
    """

    def __init__(self, vad: VoiceActivityDetector | None = None,
                 config: TurnConfig | None = None) -> None:
        self.vad = vad or VoiceActivityDetector()
        self.config = config or TurnConfig()
        self.state = TurnState.IDLE
        self._speech_ms = 0.0
        self._silence_ms = 0.0
        self._turn_ms = 0.0

    def start_listening(self) -> None:
        self.state = TurnState.LISTENING
        self.vad.reset()
        self._speech_ms = 0.0
        self._silence_ms = 0.0
        self._turn_ms = 0.0

    def push(self, pcm: bytes) -> str | None:
        """מחזיר 'speech_start' / 'turn_end' / 'silence_timeout' / None."""
        if self.state in (TurnState.IDLE, TurnState.ENDED):
            return None

        ms = len(pcm) / 2 / SAMPLE_RATE * 1000
        self._turn_ms += ms
        event = self.vad.push(pcm)

        if event == "speech_start":
            self.state = TurnState.USER_SPEAKING
            self._silence_ms = 0.0
            return "speech_start"

        if self.vad.is_speaking:
            self._speech_ms += ms
            self._silence_ms = 0.0
        else:
            self._silence_ms += ms

        if event == "speech_end":
            # ⚠ תור נחשב תור רק אם באמת נאמר בו משהו. בלי הסף הזה,
            # שיעול בודד היה נשלח לתמלול ומייצר תור ריק — שהמודל היה
            # עונה עליו במשפט לא רלוונטי.
            if self._speech_ms >= self.config.min_speech_ms:
                self.state = TurnState.ENDED
                return "turn_end"
            self.state = TurnState.LISTENING
            return None

        if self._turn_ms >= self.config.max_turn_ms and self._speech_ms > 0:
            self.state = TurnState.ENDED
            return "turn_end"

        # ⚠ שתיקה מוחלטת: המתקשר לא אמר דבר. זה **לא** סוף תור אלא
        # אירוע נפרד — הסוכנת צריכה לשאול "אתה עדיין שם?" ולא לענות
        # על כלום.
        if self._speech_ms == 0 and self._silence_ms >= self.config.silence_timeout_ms:
            self.state = TurnState.LISTENING
            self._silence_ms = 0.0
            return "silence_timeout"

        return None

    @property
    def speech_ms(self) -> float:
        return self._speech_ms


@dataclass
class BargeInConfig:
    enabled: bool = True
    # כמה דיבור רצוף נדרש כדי להשתיק את הסוכנת. ⚠ ארוך מהסף של
    # speech_start: הפרעה היא החלטה יקרה (המשפט נקטע ולא יושמע שוב),
    # ורעש רקע קצר לא אמור להפעיל אותה.
    min_speech_frames: int = 5      # ~100ms
    # חסד בתחילת ההשמעה. בלעדיו, הד של המילה האחרונה של המתקשר קוטע
    # את המשפט הראשון של הסוכנת לפני שהספיקה לומר מילה.
    grace_ms: int = 300


class BargeInPolicy:
    """האם להשתיק את הסוכנת כי המתקשר התחיל לדבר.

    ⚠ מדיניות ולא גלאי. היא יודעת מתי ההשמעה התחילה, וכמה זמן המתקשר
    מדבר — ולכן היא זו שיכולה להחליט ש"המתקשר אמר 'אהה' תוך כדי" אינו
    הפרעה, בעוד "המתקשר התחיל משפט" כן.
    """

    def __init__(self, config: BargeInConfig | None = None) -> None:
        self.config = config or BargeInConfig()
        self._vad = VoiceActivityDetector()
        self._speaking_since_ms = 0.0
        self._caller_frames = 0
        self._armed = False

    def on_speech_started(self) -> None:
        """נקרא כשהסוכנת מתחילה להקריא."""
        self._speaking_since_ms = 0.0
        self._caller_frames = 0
        self._armed = self.config.enabled
        self._vad.reset()

    def on_speech_stopped(self) -> None:
        self._armed = False

    def push(self, pcm: bytes) -> bool:
        """מזין אודיו שנקלט בזמן שהסוכנת מדברת. True = להשתיק אותה."""
        if not self._armed:
            return False

        self._speaking_since_ms += len(pcm) / 2 / SAMPLE_RATE * 1000
        if self._speaking_since_ms < self.config.grace_ms:
            return False

        self._vad.push(pcm)
        if self._vad.is_speaking:
            self._caller_frames += 1
        else:
            self._caller_frames = 0

        if self._caller_frames >= self.config.min_speech_frames:
            self._armed = False   # מפעילים פעם אחת לכל משפט
            return True
        return False
