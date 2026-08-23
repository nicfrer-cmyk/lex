"""TTSProvider — הפשטת ההקראה.

## ⚠ אין כאן מנוע TTS עברי, ובכוונה
לא נבחר מנוע. `MockTTSProvider` מייצר שקט באורך שמתאים לטקסט, ומצהיר
על עצמו כ-mock — כך אפשר לבדוק את כל זרימת האודיו (תזמון, framing,
ניתוק, הפרעת דיבור) בלי להעמיד פנים שיש קול.

מנוע שהיה מוחזר כ"עובד" ומחזיר שקט הוא הגרוע מכל: הבדיקות עוברות,
המערכת מדווחת תקין, ובשיחה הראשונה האמיתית הלקוח שומע כלום ומנתק.

כשייבחר מנוע: `LocalTTSProvider` למטה מדבר HTTP פשוט. יש להגדיר
`LOCAL_TTS_URL` ו-`TTS_PROVIDER=local`. לא נדרש שינוי בשום מקום אחר.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass

from ..capabilities import ProviderStatus


@dataclass
class Audio:
    """PCM 16-bit little-endian, mono."""
    pcm: bytes
    sample_rate: int = 16000

    @property
    def duration_ms(self) -> int:
        return int(len(self.pcm) / 2 / self.sample_rate * 1000)


class TTSProvider(abc.ABC):
    name: str = "abstract"
    is_mock: bool = False

    @abc.abstractmethod
    async def synthesize(self, text: str, *, voice: str | None = None,
                         sample_rate: int = 16000) -> Audio:
        """טקסט → אודיו, בבת אחת."""

    @abc.abstractmethod
    async def stream(self, text: str, *, voice: str | None = None,
                     sample_rate: int = 16000):
        """זרם מקטעי אודיו — כדי להתחיל להשמיע לפני שכל המשפט סונתז."""
        raise NotImplementedError
        yield b""  # pragma: no cover

    def capabilities(self) -> ProviderStatus:
        return ProviderStatus(type='tts', name=self.name)


class MockTTSProvider(TTSProvider):
    """שקט באורך הנכון. מצהיר על עצמו."""

    name = "mock"
    is_mock = True

    # קצב דיבור סביר בעברית. משמש כדי שהשקט יימשך בערך כמו המשפט —
    # וכך התזמון, ההפרעות והניתוקים נבדקים באמת.
    _CHARS_PER_SECOND = 14.0
    _MIN_MS = 400

    async def synthesize(self, text: str, *, voice: str | None = None,
                         sample_rate: int = 16000) -> Audio:
        ms = max(self._MIN_MS, int(len(text or "") / self._CHARS_PER_SECOND * 1000))
        return Audio(pcm=b"\x00" * (int(sample_rate * ms / 1000) * 2), sample_rate=sample_rate)

    async def stream(self, text: str, *, voice: str | None = None,
                     sample_rate: int = 16000):
        audio = await self.synthesize(text, voice=voice, sample_rate=sample_rate)
        # מקטעים של 20ms — הגודל ש-Asterisk מצפה לו בזרם slin16.
        chunk = int(sample_rate * 0.02) * 2
        for i in range(0, len(audio.pcm), chunk):
            yield audio.pcm[i:i + chunk]

    def capabilities(self) -> ProviderStatus:
        # ⚠ הדוגמה המובהקת ביותר להבחנה. הוא בריא לחלוטין: עונה, מהיר,
        # לא קורס. הוא גם מחזיר שקט. דיווח production_ready=True כאן
        # פירושו שבעל המשרד יחבר מספר אמיתי ויגלה מהלקוח הראשון שאיש
        # לא שומע דבר.
        return ProviderStatus.mock(
            'tts', 'mock',
            'הקראה במצב הדגמה — מייצרת שקט. המתקשר לא ישמע דבר.')


class LocalTTSProvider(TTSProvider):
    """מנוע TTS מקומי מאחורי HTTP.

    הממשק המצופה:
        POST {base_url}/synthesize
        {"text": "...", "voice": "...", "sample_rate": 16000}
        → audio/L16 גולמי (PCM 16-bit LE, mono)

    ⚠ נכשל ברעש ולא בשקט. ספק שמחזיר שגיאה גורם ל-TTSUnavailable, וקורא
    ה-orchestrator נופל למשפט ברירת מחדל ומסמן את השיחה להמשך ידני —
    במקום להשמיע ללקוח שקט ולהיראות כמו קו מנותק.
    """

    name = "local"
    is_mock = False

    def __init__(self, base_url: str, voice: str = "", timeout: int = 15) -> None:
        self._base = base_url.rstrip("/")
        self._voice = voice
        self._timeout = timeout
        self._healthy = True
        self._last_error = ''

    async def synthesize(self, text: str, *, voice: str | None = None,
                         sample_rate: int = 16000) -> Audio:
        import httpx

        async with httpx.AsyncClient(timeout=self._timeout) as client:
            resp = await client.post(f"{self._base}/synthesize", json={
                "text": text, "voice": voice or self._voice, "sample_rate": sample_rate,
            })
            if resp.status_code >= 400:
                self._healthy = False
                self._last_error = f"מנוע ההקראה החזיר {resp.status_code}"
                raise TTSUnavailable(self._last_error)
            self._healthy = True
            self._last_error = ''
            return Audio(pcm=resp.content, sample_rate=sample_rate)

    async def stream(self, text: str, *, voice: str | None = None,
                     sample_rate: int = 16000):
        audio = await self.synthesize(text, voice=voice, sample_rate=sample_rate)
        chunk = int(sample_rate * 0.02) * 2
        for i in range(0, len(audio.pcm), chunk):
            yield audio.pcm[i:i + chunk]

    def capabilities(self) -> ProviderStatus:
        return ProviderStatus(
            type='tts', name=f'local:{self._base}',
            mode='real',
            healthy=self._healthy,
            production_ready=self._healthy,
            supports_streaming=True,
            # ⚠ עברית אינה מובטחת ע"י עצם היות המנוע מקומי. מי שמגדיר
            # מנוע חייב לוודא זאת בעצמו; דיווח שקרי כאן היה מוביל
            # לשיחה באנגלית עם לקוח ישראלי.
            supports_hebrew=False,
            message=self._last_error,
        )


class TTSUnavailable(RuntimeError):
    """מנוע ההקראה אינו זמין."""
