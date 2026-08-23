"""Asterisk דרך ARI.

## למה ARI ולא AGI/AMI
AGI מריץ תהליך לכל שיחה וחוסם את הערוץ; AMI הוא זרם אירועים בלי שליטה
טובה בערוצים. ARI נותן REST + WebSocket אחד, ומאפשר External Media —
כלומר להוציא את האודיו מהשיחה אל תהליך אחר ולהחזיר אליו. זה בדיוק מה
שנדרש כדי להכניס STT ו-TTS באמצע שיחה.

## חלוקת האחריות
Asterisk: לענות, לגשר, להעביר מדיה, לנתק, להחזיק.
כאן: לתרגם את זה לקריאות פונקציה. **אין כאן היגיון של שיחה** — אין
החלטה מה לומר, למי, ומה ליצור. זה חי ב-CRM.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Callable, Awaitable

import httpx

from ..telemetry.logging import get_logger
from .base import InboundCall, TelephonyProvider, TransferBlocked

log = get_logger(__name__)

EventHandler = Callable[[dict[str, Any]], Awaitable[None]]


class AsteriskAriProvider(TelephonyProvider):
    name = "asterisk"
    is_mock = False

    def __init__(self, host: str, port: int, username: str, password: str,
                 app: str, media_host: str, media_port: int,
                 media_format: str = "slin16") -> None:
        self._base = f"http://{host}:{port}/ari"
        self._ws = f"ws://{host}:{port}/ari/events"
        self._auth = (username, password)
        self._app = app
        self._media_host = media_host
        self._media_port = media_port
        self._media_format = media_format
        self._client: httpx.AsyncClient | None = None
        self._ws_task: asyncio.Task | None = None
        self._stop = asyncio.Event()

    # ------------------------------------------------------------------
    # מחזור חיים
    # ------------------------------------------------------------------

    async def start(self, on_event: EventHandler) -> None:
        self._client = httpx.AsyncClient(auth=self._auth, timeout=10)
        self._stop.clear()
        self._ws_task = asyncio.create_task(self._listen(on_event))

    async def stop(self) -> None:
        self._stop.set()
        if self._ws_task:
            self._ws_task.cancel()
            try:
                await self._ws_task
            except asyncio.CancelledError:
                pass
            self._ws_task = None
        if self._client:
            await self._client.aclose()
            self._client = None

    async def _listen(self, on_event: EventHandler) -> None:
        """מנוי לאירועי ARI, עם חיבור מחדש.

        ⚠ ההתחברות מחדש היא לא נוחות. WebSocket שנופל בשקט פירושו
        ש-Asterisk ממשיך לענות לשיחות ואיש לא מטפל בהן — המתקשר שומע
        שקט. backoff מוגבל: מתחיל בשנייה, מטפס עד 30, לא מוותר.
        """
        import websockets

        backoff = 1
        url = f"{self._ws}?api_key={self._auth[0]}:{self._auth[1]}&app={self._app}&subscribeAll=true"
        while not self._stop.is_set():
            try:
                async with websockets.connect(url, ping_interval=20) as ws:
                    log.info("ari_connected", extra={"app": self._app})
                    backoff = 1
                    async for raw in ws:
                        try:
                            await on_event(json.loads(raw))
                        except Exception:  # noqa: BLE001
                            # אירוע אחד שנפל לא מפיל את המנוי לכל השאר.
                            log.exception("ari_event_handler_failed")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                if self._stop.is_set():
                    return
                log.warning("ari_disconnected", extra={
                    "error": str(exc), "retry_in": backoff})
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)

    # ------------------------------------------------------------------
    # פעולות
    # ------------------------------------------------------------------

    async def _req(self, method: str, path: str, **kwargs: Any) -> Any:
        assert self._client is not None, "AsteriskAriProvider.start() לא נקרא"
        resp = await self._client.request(method, f"{self._base}{path}", **kwargs)
        # 404 על ערוץ = השיחה כבר נותקה. זו לא שגיאה מבחינת הקורא: מרוץ
        # בין ניתוק של המתקשר לבין פעולה שלנו הוא המצב הרגיל, לא החריג.
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json() if resp.content else None

    async def answer_call(self, channel_id: str) -> None:
        await self._req("POST", f"/channels/{channel_id}/answer")

    async def end_call(self, channel_id: str) -> None:
        await self._req("DELETE", f"/channels/{channel_id}")

    async def hold_call(self, channel_id: str, on: bool) -> None:
        method = "POST" if on else "DELETE"
        await self._req(method, f"/channels/{channel_id}/hold")

    async def transfer_call(self, channel_id: str, target: str) -> None:
        """⚠ שכבת ההגנה השלישית מפני לולאת ניתוב.

        `target` ריק מגיע לכאן רק אם שתי השכבות שלפניה נפרצו (הכלי ב-CRM
        מסומן לא-זמין, וה-dialplan בודק את היעד). חסימה כאן היא הדבר
        היחיד שעומד בין טעות הגדרה לבין ערוצים שנפתחים עד קריסה.
        """
        if not target:
            raise TransferBlocked("לא הוגדר יעד העברה")
        await self._req("POST", f"/channels/{channel_id}/redirect",
                        params={"endpoint": f"PJSIP/{target}@trunk"})

    async def start_media(self, channel_id: str) -> str:
        """פותח ערוץ External Media ומגשר אותו לשיחה.

        הגישור נדרש: ערוץ מדיה שאינו בגשר עם ערוץ השיחה לא מקבל ולא
        שולח דבר — הוא פשוט קיים.
        """
        media = await self._req("POST", "/channels/externalMedia", params={
            "app": self._app,
            "external_host": f"{self._media_host}:{self._media_port}",
            "format": self._media_format,
            "encapsulation": "audiosocket",
            "transport": "tcp",
            "direction": "both",
        })
        if not media:
            raise RuntimeError("פתיחת ערוץ מדיה נכשלה")
        media_id = media["id"]

        bridge = await self._req("POST", "/bridges", params={"type": "mixing"})
        await self._req("POST", f"/bridges/{bridge['id']}/addChannel",
                        params={"channel": f"{channel_id},{media_id}"})
        return media_id

    async def stop_media(self, media_id: str) -> None:
        await self._req("DELETE", f"/channels/{media_id}")

    async def play_audio(self, channel_id: str, pcm: bytes) -> None:
        """האודיו נשלח דרך ערוץ המדיה (AudioSocket), לא דרך ARI.

        ARI יודע לנגן קבצים בלבד. כתיבת כל תשובה לקובץ ואז לנגן אותה
        מוסיפה גישת דיסק וחצי שנייה לכל משפט, ובשיחה חיה זה נשמע כמו
        תקלה. הזרם עצמו מטופל ב-`audio/socket.py`.
        """
        raise NotImplementedError("השמעה עוברת דרך AudioSocket, ראה audio/socket.py")

    async def test_connection(self) -> tuple[bool, str]:
        try:
            info = await self._req("GET", "/asterisk/info")
            if not info:
                return False, "ARI לא החזיר מידע"
            version = (info.get("system") or {}).get("version", "?")
            return True, f"Asterisk {version}"
        except Exception as exc:  # noqa: BLE001
            return False, str(exc)

    # ------------------------------------------------------------------

    @staticmethod
    def parse_stasis_start(event: dict[str, Any]) -> InboundCall | None:
        """StasisStart → שיחה נכנסת.

        ⚠ ערוץ המדיה שאנחנו עצמנו פתחנו גם הוא מייצר StasisStart. בלי
        הסינון הזה, כל שיחה הייתה נספרת פעמיים והמערכת הייתה פותחת שיחה
        שנייה ב-CRM על ערוץ שהיא יצרה בעצמה.
        """
        if event.get("type") != "StasisStart":
            return None
        channel = event.get("channel") or {}
        if str(channel.get("name", "")).startswith("UnicastRTP"):
            return None
        args = event.get("args") or []
        if args and args[0] != "inbound":
            return None

        caller = (channel.get("caller") or {}).get("number") or ""
        dialed = (channel.get("dialplan") or {}).get("exten") or ""
        return InboundCall(
            channel_id=channel.get("id", ""),
            caller_number=args[1] if len(args) > 1 else caller,
            called_number=args[2] if len(args) > 2 else dialed,
            started_at=channel.get("creationtime") or "",
        )
