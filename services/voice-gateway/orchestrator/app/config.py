"""הגדרות השירות — מקור אמת יחיד, נטען פעם אחת.

כל ערך מגיע מסביבה. אין ערכי ברירת מחדל שהם סודות, ואין fallback שקט
לערך "סביר": שירות שמתחיל לעבוד עם הגדרות חסרות מייצר תקלות שמתגלות
רק כשלקוח אמיתי מתקשר.

`Settings.problems()` מחזיר את רשימת מה שחסר, וה-heartbeat משדר אותה
ל-CRM. כך "למה אין שיחות" נענה במסך ולא ב-SSH.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from functools import lru_cache


def _env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()


def _bool(key: str, default: bool = False) -> bool:
    raw = _env(key).lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


def _int(key: str, default: int) -> int:
    try:
        return int(_env(key) or default)
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    # ---- CRM ----
    crm_base_url: str = field(default_factory=lambda: _env("CRM_BASE_URL"))
    crm_office_id: str = field(default_factory=lambda: _env("CRM_OFFICE_ID"))
    voice_gateway_secret: str = field(default_factory=lambda: _env("VOICE_GATEWAY_SECRET"))
    heartbeat_interval: int = field(default_factory=lambda: _int("HEARTBEAT_INTERVAL_SECONDS", 30))
    http_timeout: int = field(default_factory=lambda: _int("HTTP_TIMEOUT_SECONDS", 20))

    # ---- מספרים ----
    public_office_phone: str = field(default_factory=lambda: _env("PUBLIC_OFFICE_PHONE"))
    human_transfer_number: str = field(default_factory=lambda: _env("HUMAN_TRANSFER_NUMBER"))

    # ---- SIP ----
    sip_host: str = field(default_factory=lambda: _env("SIP_HOST"))
    sip_port: int = field(default_factory=lambda: _int("SIP_PORT", 5060))
    sip_username: str = field(default_factory=lambda: _env("SIP_USERNAME"))
    sip_transport: str = field(default_factory=lambda: _env("SIP_TRANSPORT", "udp"))

    # ---- ARI ----
    ari_host: str = field(default_factory=lambda: _env("ARI_HOST", "127.0.0.1"))
    ari_port: int = field(default_factory=lambda: _int("ARI_PORT", 8088))
    ari_username: str = field(default_factory=lambda: _env("ARI_USERNAME"))
    ari_password: str = field(default_factory=lambda: _env("ARI_PASSWORD"))
    ari_app: str = field(default_factory=lambda: _env("ARI_APP_NAME", "lextrack-voice"))

    external_media_host: str = field(default_factory=lambda: _env("EXTERNAL_MEDIA_HOST", "127.0.0.1"))
    external_media_port: int = field(default_factory=lambda: _int("EXTERNAL_MEDIA_PORT", 8090))
    external_media_format: str = field(default_factory=lambda: _env("EXTERNAL_MEDIA_FORMAT", "slin16"))
    # audiosocket | websocket. ⚠ websocket הוא שלד שמצהיר
    # production_ready=False — ראה media/websocket.py.
    media_transport: str = field(default_factory=lambda: _env("MEDIA_TRANSPORT", "audiosocket"))

    # ---- ספקים ----
    stt_provider: str = field(default_factory=lambda: _env("STT_PROVIDER", "mock"))
    stt_model: str = field(default_factory=lambda: _env("STT_MODEL", "small"))
    stt_language: str = field(default_factory=lambda: _env("STT_LANGUAGE", "he"))
    stt_device: str = field(default_factory=lambda: _env("STT_DEVICE", "cpu"))
    stt_compute_type: str = field(default_factory=lambda: _env("STT_COMPUTE_TYPE", "int8"))
    local_stt_url: str = field(default_factory=lambda: _env("LOCAL_STT_URL"))

    llm_provider: str = field(default_factory=lambda: _env("LLM_PROVIDER", "crm"))
    local_llm_url: str = field(default_factory=lambda: _env("LOCAL_LLM_URL"))
    llm_model: str = field(default_factory=lambda: _env("LLM_MODEL"))

    tts_provider: str = field(default_factory=lambda: _env("TTS_PROVIDER", "mock"))
    local_tts_url: str = field(default_factory=lambda: _env("LOCAL_TTS_URL"))
    tts_voice: str = field(default_factory=lambda: _env("TTS_VOICE"))

    # ---- הקלטות ----
    recording_enabled: bool = field(default_factory=lambda: _bool("CALL_RECORDING_ENABLED", False))
    recording_path: str = field(
        default_factory=lambda: _env("RECORDING_PATH", "/var/spool/lextrack/recordings"))

    # ---- תפעול ----
    log_level: str = field(default_factory=lambda: _env("LOG_LEVEL", "INFO"))
    queue_path: str = field(default_factory=lambda: _env("QUEUE_PATH", "/var/spool/lextrack/queue"))
    queue_max_retries: int = field(default_factory=lambda: _int("QUEUE_MAX_RETRIES", 8))
    max_concurrent_calls: int = field(default_factory=lambda: _int("MAX_CONCURRENT_CALLS", 4))

    # ------------------------------------------------------------------

    @property
    def crm_configured(self) -> bool:
        return bool(self.crm_base_url and self.crm_office_id and self.voice_gateway_secret)

    @property
    def sip_configured(self) -> bool:
        return bool(self.sip_host and self.sip_username)

    @property
    def ari_configured(self) -> bool:
        return bool(self.ari_username and self.ari_password)

    @property
    def transfer_target(self) -> str:
        """יעד ההעברה לנציג — או מחרוזת ריקה.

        ⚠ יעד שזהה למספר הציבורי מוחזר כריק **בכוונה**. אם השיחה הופנתה
        מהמספר הציבורי אל ה-AI, העברה חזרה אליו יוצרת לולאת ניתוב: ערוצים
        שנפתחים עד שהמערכת או הספק קורסים, וחיוב על כל אחד.

        זו השכבה השלישית של אותה הגנה (ה-CRM חוסם את הכלי, ה-dialplan
        חוסם את החיוג). פעולה שגורמת נזק מצטבר לא מקבלת הגנה יחידה.
        """
        target = _digits(self.human_transfer_number)
        if not target:
            return ""
        if target == _digits(self.public_office_phone):
            return ""
        return self.human_transfer_number

    def problems(self) -> list[str]:
        """מה חסר כדי שהשירות יעבוד. משודר ב-heartbeat ומוצג ב-CRM."""
        out: list[str] = []
        if not self.crm_base_url:
            out.append("CRM_BASE_URL לא הוגדר")
        if not self.crm_office_id:
            out.append("CRM_OFFICE_ID לא הוגדר")
        if not self.voice_gateway_secret:
            out.append("VOICE_GATEWAY_SECRET לא הוגדר — כל בקשה ל-CRM תידחה")
        if not self.sip_configured:
            out.append("SIP לא הוגדר — שיחות אמיתיות לא יתקבלו")
        if not self.ari_configured:
            out.append("ARI לא הוגדר — אין שליטה ב-Asterisk")
        if self.tts_provider == "mock":
            out.append("TTS במצב הדגמה — לא נבחר מנוע הקראה")
        if self.stt_provider == "mock":
            out.append("STT במצב הדגמה — לא נבחר מנוע תמלול")
        if self.media_transport == "websocket":
            out.append("MEDIA_TRANSPORT=websocket הוא שלד בלבד — שיחות לא יישמעו")
        if (self.human_transfer_number
                and _digits(self.human_transfer_number) == _digits(self.public_office_phone)):
            out.append(
                "HUMAN_TRANSFER_NUMBER זהה למספר הציבורי — ההעברה מושבתת "
                "כדי למנוע לולאת ניתוב")
        return out

    def components(self) -> dict[str, str]:
        """מצב הרכיבים, בפורמט שה-CRM מציג במסך 'מצב מערכת'."""
        return {
            "asterisk": "configured" if self.ari_configured else "not_configured",
            "sip": "configured" if self.sip_configured else "not_configured",
            "transport": self.media_transport,
            "stt": self.stt_provider,
            "llm": self.llm_provider,
            "tts": self.tts_provider,
            "recording": "enabled" if self.recording_enabled else "disabled",
            "transfer": "configured" if self.transfer_target else "not_configured",
        }


def _digits(value: str) -> str:
    """תשע הספרות האחרונות — משווה 0552745790 מול +972552745790."""
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    return digits[-9:] if len(digits) >= 9 else digits


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
