"""Voice Gateway Orchestrator — נקודת הכניסה.

## מה השירות הזה עושה
מחבר קו טלפון למנוע השיחה של ה-CRM. הוא **לא** מכיל היגיון של שיחה,
לא רשימת כלים ולא כללי דחיפות — כל אלה חיים ב-CRM ומשותפים עם מצב
הבדיקה.

## למה הוא לא Serverless
שיחת טלפון היא חיבור מתמשך של דקות עם זרם אודיו דו-כיווני, ו-Asterisk
מחזיק רישום SIP חי. סביבה שמתעוררת לבקשה ומתה אחריה לא יכולה לעשות
אף אחד מהשניים.

## עלייה בהגדרות חסרות
השירות **עולה** גם בלי SIP, בלי ARI ובלי CRM — ומדווח על עצמו כלא-מוגדר
דרך `/health` ודרך ה-heartbeat. זה מכוון: כישלון עלייה שקט הוא הדבר
שהכי קשה לאבחן מרחוק, ובעל המשרד צריך לראות במסך "לא מחובר" ולא כלום.
"""

from __future__ import annotations

import asyncio
import contextlib
from typing import Any

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .audio.socket import AudioSocketServer
from .calls.manager import CallManager
from .config import get_settings
from .crm.client import CrmClient
from .llm.base import LLMProvider, MockLLMProvider
from .llm.crm import CrmLlmProvider
from .llm.local import OllamaLLM, VllmLLM
from .stt.base import MockSTTProvider, STTProvider
from .telemetry.logging import configure, get_logger
from .telephony.base import MockTelephonyProvider, TelephonyProvider
from .tts.base import LocalTTSProvider, MockTTSProvider, TTSProvider

VERSION = "1.0.0"

settings = get_settings()
configure(settings.log_level)
log = get_logger(__name__)

app = FastAPI(title="LexTrack Voice Gateway", version=VERSION)

_state: dict[str, Any] = {}


# ======================================================================
# בחירת ספקים
# ======================================================================
#
# ⚠ אין נפילה שקטה לספק אחר. כשמבוקש ספק שאינו ממומש, נרשמת אזהרה
# מפורשת והמצב מדווח כ-mock ב-heartbeat. מערכת שמראה "פעיל" בזמן שהיא
# במצב הדגמה היא בדיוק מה שהמפרט אוסר.

def _build_stt() -> STTProvider:
    if settings.stt_provider == "faster_whisper":
        from .stt.whisper import FasterWhisperSTT
        return FasterWhisperSTT(
            model=settings.stt_model, language=settings.stt_language,
            device=settings.stt_device, compute_type=settings.stt_compute_type)
    if settings.stt_provider not in ("mock", ""):
        log.warning("stt_provider_unknown", extra={"requested": settings.stt_provider})
    return MockSTTProvider()


def _build_llm(crm: CrmClient) -> LLMProvider:
    provider = settings.llm_provider
    if provider == "crm":
        return CrmLlmProvider(crm)
    if provider == "ollama":
        return OllamaLLM(settings.local_llm_url or "http://127.0.0.1:11434",
                         settings.llm_model or "llama3.1:8b")
    if provider == "vllm":
        return VllmLLM(settings.local_llm_url or "http://127.0.0.1:8000",
                       settings.llm_model)
    if provider not in ("mock", ""):
        log.warning("llm_provider_unknown", extra={"requested": provider})
    return MockLLMProvider()


def _build_tts() -> TTSProvider:
    if settings.tts_provider == "local" and settings.local_tts_url:
        return LocalTTSProvider(settings.local_tts_url, settings.tts_voice)
    if settings.tts_provider == "local":
        # ⚠ ביקשו local בלי כתובת. שקט שמדווח כהצלחה הוא הכשל הגרוע
        # ביותר כאן — הבדיקות עוברות והלקוח הראשון לא שומע דבר.
        log.warning("tts_local_without_url")
    return MockTTSProvider()


def _build_telephony() -> TelephonyProvider:
    if not settings.ari_configured:
        return MockTelephonyProvider()
    from .telephony.asterisk_ari import AsteriskAriProvider
    return AsteriskAriProvider(
        settings.ari_host, settings.ari_port,
        settings.ari_username, settings.ari_password, settings.ari_app,
        settings.external_media_host, settings.external_media_port,
        settings.external_media_format)


# ======================================================================
# מחזור חיים
# ======================================================================

@app.on_event("startup")
async def on_startup() -> None:
    problems = settings.problems()
    if problems:
        # רשימה מלאה, לא "שגיאה". זו התשובה ל"למה אין שיחות" — והיא
        # צריכה להיות בשורה הראשונה של הלוג, לא מפוזרת.
        log.warning("startup_incomplete", extra={"problems": problems})

    crm = CrmClient(settings)
    await crm.start()

    telephony = _build_telephony()
    stt = _build_stt()
    llm = _build_llm(crm)
    tts = _build_tts()

    manager = CallManager(settings, crm, telephony, stt, llm, tts)
    audio = AudioSocketServer(
        settings.external_media_host if settings.external_media_host != "orchestrator" else "0.0.0.0",
        settings.external_media_port, manager.on_audio)
    manager.bind_audio_sender(audio.send)

    await audio.start()

    if not telephony.is_mock:
        await telephony.start(manager.on_ari_event)  # type: ignore[attr-defined]

    _state.update(crm=crm, telephony=telephony, stt=stt, llm=llm, tts=tts,
                  manager=manager, audio=audio)
    _state["heartbeat_task"] = asyncio.create_task(_heartbeat_loop())

    log.info("startup_complete", extra={
        "version": VERSION,
        "telephony": telephony.name, "stt": stt.name,
        "llm": llm.name, "tts": tts.name,
        "crm_configured": settings.crm_configured,
    })


@app.on_event("shutdown")
async def on_shutdown() -> None:
    task = _state.get("heartbeat_task")
    if task:
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    manager: CallManager | None = _state.get("manager")
    if manager:
        await manager.shutdown()

    telephony = _state.get("telephony")
    if telephony and not telephony.is_mock:
        await telephony.stop()

    audio = _state.get("audio")
    if audio:
        await audio.stop()

    crm: CrmClient | None = _state.get("crm")
    if crm:
        # ניסיון אחרון לרוקן את התור. שיחה שהסתיימה ולא נרשמה בגלל
        # restart היא פנייה של לקוח שנעלמה.
        with contextlib.suppress(Exception):
            await crm.drain()
        await crm.close()

    log.info("shutdown_complete")


async def _heartbeat_loop() -> None:
    """דופק + ניקוז התור.

    ⚠ ה-CRM מציג "מחובר" רק אם התקבל heartbeat לאחרונה — אין דגל
    "online" שמור. לכן שרת שנפל הופך ל"מנותק" מעצמו, בלי שאיש צריך
    לעדכן דבר.
    """
    crm: CrmClient = _state["crm"]
    manager: CallManager = _state["manager"]
    while True:
        try:
            await crm.heartbeat(active_calls=manager.active_count, version=VERSION)
            drained = await crm.drain()
            if drained:
                log.info("queue_drained", extra={"sent": drained})
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            # heartbeat שנכשל אינו מפיל את השירות: שיחות שכבר רצות
            # ממשיכות, והמסך יציג "מנותק" — וזה מדויק.
            log.warning("heartbeat_failed", extra={"error": str(exc)})
        await asyncio.sleep(settings.heartbeat_interval)


# ======================================================================
# HTTP
# ======================================================================

@app.get("/health")
async def health() -> JSONResponse:
    manager: CallManager | None = _state.get("manager")
    crm: CrmClient | None = _state.get("crm")
    problems = settings.problems()

    # ⚠ 200 גם כשיש בעיות הגדרה. השירות **חי** — הוא פשוט לא מוגדר.
    # 503 היה גורם ל-Docker להרוג אותו בלולאה, ואז גם המסך שאמור להסביר
    # מה חסר היה מפסיק לקבל heartbeat.
    return JSONResponse({
        "status": "ok",
        "version": VERSION,
        "configured": settings.crm_configured,
        "active_calls": manager.active_count if manager else 0,
        "queued": crm.queue_depth() if crm else 0,
        "components": settings.components(),
        "problems": problems,
    })


@app.get("/status")
async def status() -> JSONResponse:
    telephony = _state.get("telephony")
    ok, detail = (False, "לא אותחל")
    if telephony:
        ok, detail = await telephony.test_connection()
    return JSONResponse({
        "telephony": {"name": getattr(telephony, "name", "?"), "ok": ok, "detail": detail},
        "stt": getattr(_state.get("stt"), "name", "?"),
        "llm": getattr(_state.get("llm"), "name", "?"),
        "tts": getattr(_state.get("tts"), "name", "?"),
        "public_office_phone": settings.public_office_phone,
        # ⚠ מוחזר "האם מוגדר", לא הערך. מספר יעד הוא מידע תפעולי, ואין
        # סיבה שנקודת קצה שאינה מאומתת תדליף אותו.
        "transfer_configured": bool(settings.transfer_target),
        "problems": settings.problems(),
    })


@app.post("/drain")
async def drain() -> JSONResponse:
    """ניקוז ידני של התור — לשימוש אחרי תקלת רשת ממושכת."""
    crm: CrmClient | None = _state.get("crm")
    if crm is None:
        return JSONResponse({"error": "השירות לא אותחל"}, status_code=503)
    sent = await crm.drain()
    return JSONResponse({"sent": sent, "remaining": crm.queue_depth()})
