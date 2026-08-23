"""מרשם השיחות הפעילות + חיבור אירועי ARI ל-CRM.

זו נקודת החיבור בין השכבות: אירוע מ-Asterisk נכנס כאן, הופך לשיחה
ב-CRM, והאודיו מתחיל לזרום. כל השאר מואצל.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

from ..config import Settings
from ..crm.client import CrmClient, CrmRejected, CrmUnavailable
from ..llm.base import LLMProvider
from ..stt.base import STTProvider
from ..telemetry.logging import get_logger, set_call_id
from ..telephony.base import TelephonyProvider, TransferBlocked
from ..tts.base import TTSProvider
from .session import CallRunner, CallSession, CallState

log = get_logger(__name__)


class CallManager:
    def __init__(self, settings: Settings, crm: CrmClient, telephony: TelephonyProvider,
                 stt: STTProvider, llm: LLMProvider, tts: TTSProvider) -> None:
        self._settings = settings
        self._crm = crm
        self._telephony = telephony
        self._stt = stt
        self._llm = llm
        self._tts = tts
        self._sessions: dict[str, CallSession] = {}
        self._runners: dict[str, CallRunner] = {}
        # מיפוי מזהה AudioSocket → ערוץ. הזרם מגיע לפני שהקישור ידוע,
        # ולכן צריך את שני הכיוונים.
        self._by_audio: dict[str, str] = {}
        self._send_audio = None

    def bind_audio_sender(self, sender) -> None:
        self._send_audio = sender

    @property
    def active_count(self) -> int:
        return len([s for s in self._sessions.values()
                    if s.state not in (CallState.COMPLETED, CallState.FAILED)])

    # ------------------------------------------------------------------
    # אירועי ARI
    # ------------------------------------------------------------------

    async def on_ari_event(self, event: dict[str, Any]) -> None:
        etype = event.get("type")
        if etype == "StasisStart":
            await self._on_start(event)
        elif etype in ("StasisEnd", "ChannelDestroyed", "ChannelHangupRequest"):
            await self._on_end(event)
        elif etype == "ChannelHold":
            await self._set_state(event, CallState.ON_HOLD)
        elif etype == "ChannelUnhold":
            await self._set_state(event, CallState.ACTIVE)

    async def _on_start(self, event: dict[str, Any]) -> None:
        from ..telephony.asterisk_ari import AsteriskAriProvider

        inbound = AsteriskAriProvider.parse_stasis_start(event)
        if inbound is None:
            return  # ערוץ מדיה שאנחנו פתחנו, לא שיחה

        # ⚠ תקרת שיחות מקבילות. שרת קטן שמנסה לטפל בעשר שיחות בו-זמנית
        # יאט את כולן עד שאף אחת לא שמישה. עדיף לענות לארבע כמו שצריך
        # ולתת לשאר להישמע כתפוס — הספק ינתב אותן ליעד גיבוי.
        if self.active_count >= self._settings.max_concurrent_calls:
            log.warning("call_rejected_capacity", extra={"active": self.active_count})
            await self._telephony.end_call(inbound.channel_id)
            return

        session = CallSession(
            channel_id=inbound.channel_id,
            caller_number=inbound.caller_number,
            called_number=inbound.called_number or self._settings.public_office_phone,
        )
        self._sessions[session.channel_id] = session
        set_call_id(session.channel_id)
        log.info("call_started", extra={"from": session.caller_number})

        # ---- פתיחת השיחה ב-CRM ----
        try:
            data = await self._crm.call("call.start", {
                # ⚠ מזהה יציב מ-Asterisk ולא uuid חדש: retry על אותה שיחה
                # חייב להגיע לאותה שורה ב-CRM, אחרת כל ניסיון חוזר יוצר
                # שיחה, ליד ומשימה נוספים.
                "call_id": f"ast-{session.channel_id}",
                "from": session.caller_number,
                "to": session.called_number,
                "direction": "inbound",
            })
        except CrmRejected as exc:
            log.error("crm_rejected_call_start", extra={"error": str(exc)})
            await self._telephony.end_call(session.channel_id)
            self._sessions.pop(session.channel_id, None)
            return
        except CrmUnavailable:
            # הבקשה בתור. אי אפשר לנהל שיחה בלי הסוכן, אבל אפשר לא לנתק
            # בשקט: משפט אחד, והשיחה תירשם כשה-CRM יחזור.
            log.warning("crm_unavailable_at_start")
            data = {"greeting": ("שלום, הגעת למשרד עורכי הדין. יש תקלה זמנית "
                                 "במערכת המענה. הפנייה נרשמה ונחזור אליך בהקדם."),
                    "call_id": ""}
            session.followup_required = True

        session.crm_call_id = data.get("call_id") or ""
        set_call_id(session.crm_call_id or session.channel_id)

        # ---- פתיחת המדיה ----
        try:
            session.media_id = await self._telephony.start_media(session.channel_id)
            # ב-AudioSocket, המזהה שמגיע בפריים הראשון הוא ה-UUID של הערוץ.
            session.audio_uuid = session.channel_id
            self._by_audio[session.audio_uuid] = session.channel_id
        except Exception:  # noqa: BLE001
            log.exception("media_start_failed")
            session.state = CallState.FAILED
            await self._finish(session, status="failed")
            return

        runner = CallRunner(
            session, self._stt, self._llm, self._tts,
            send_audio=lambda pcm: self._send(session.audio_uuid, pcm),
        )
        self._runners[session.channel_id] = runner
        await runner.start(data.get("greeting") or "")

    async def _on_end(self, event: dict[str, Any]) -> None:
        channel_id = (event.get("channel") or {}).get("id", "")
        session = self._sessions.get(channel_id)
        if session is None:
            return
        await self._finish(session, status="completed")

    async def _set_state(self, event: dict[str, Any], state: CallState) -> None:
        channel_id = (event.get("channel") or {}).get("id", "")
        session = self._sessions.get(channel_id)
        if session is None:
            return
        session.state = state
        if session.crm_call_id:
            try:
                await self._crm.call("call.status", {
                    "call_id": session.crm_call_id, "status": state.value})
            except (CrmUnavailable, CrmRejected):
                pass  # עדכון מצב הוא מידע, לא פעולה. אובדנו אינו קריטי.

    async def _finish(self, session: CallSession, *, status: str) -> None:
        set_call_id(session.crm_call_id or session.channel_id)
        runner = self._runners.pop(session.channel_id, None)
        if runner:
            await runner.stop()
        if session.media_id:
            try:
                await self._telephony.stop_media(session.media_id)
            except Exception:  # noqa: BLE001
                pass

        if session.crm_call_id:
            try:
                await self._crm.call("call.end", {
                    "call_id": session.crm_call_id,
                    "status": status,
                    "duration_seconds": session.duration_seconds,
                })
            except CrmUnavailable:
                # ⚠ בתור. הסיכום והתוצאה ייווצרו כשה-CRM יחזור. זו הסיבה
                # שהתור נשמר לדיסק ולא בזיכרון: restart בין השניים היה
                # מוחק שיחה שלמה.
                log.warning("call_end_queued")
            except CrmRejected as exc:
                log.error("call_end_rejected", extra={"error": str(exc)})

        session.state = CallState.COMPLETED if status == "completed" else CallState.FAILED
        self._sessions.pop(session.channel_id, None)
        self._by_audio.pop(session.audio_uuid, None)
        log.info("call_finished", extra={
            "status": status, "duration": session.duration_seconds, "turns": session.turns})
        set_call_id(None)

    # ------------------------------------------------------------------
    # אודיו
    # ------------------------------------------------------------------

    async def on_audio(self, audio_uuid: str, pcm: bytes) -> None:
        channel_id = self._by_audio.get(audio_uuid, audio_uuid)
        runner = self._runners.get(channel_id)
        if runner is None:
            return
        await runner.on_audio(pcm)

    async def _send(self, audio_uuid: str, pcm: bytes) -> None:
        if self._send_audio is None:
            return
        await self._send_audio(audio_uuid, pcm)

    # ------------------------------------------------------------------
    # העברה
    # ------------------------------------------------------------------

    async def transfer(self, channel_id: str) -> tuple[bool, str]:
        """⚠ ההגנה האחרונה מפני לולאת ניתוב.

        `settings.transfer_target` כבר מחזיר ריק כשהיעד זהה למספר
        הציבורי. הבדיקה כאן היא על היעד שחזר משם, ולא על הערך הגולמי.
        """
        session = self._sessions.get(channel_id)
        if session is None:
            return False, "השיחה לא נמצאה"

        target = self._settings.transfer_target
        if not target:
            return False, ("לא הוגדר יעד העברה תקין. נוצרה משימת חזרה במקום.")

        try:
            session.state = CallState.TRANSFERRING
            await self._telephony.transfer_call(channel_id, target)
            return True, f"השיחה הועברה אל {target}"
        except TransferBlocked as exc:
            session.state = CallState.ACTIVE
            return False, str(exc)

    async def shutdown(self) -> None:
        """סוגר את כל השיחות הפתוחות. נקרא ב-shutdown של השירות."""
        await asyncio.gather(
            *(self._finish(s, status="completed") for s in list(self._sessions.values())),
            return_exceptions=True,
        )
