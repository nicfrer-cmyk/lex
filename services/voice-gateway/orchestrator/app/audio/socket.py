"""AudioSocket — זרם האודיו הדו-כיווני מול Asterisk.

## הפרוטוקול
TCP, פריימים באורך משתנה:

    [type: 1 byte][length: 2 bytes big-endian][payload: length bytes]

    0x00  סיום
    0x01  UUID של הערוץ (16 בייט) — הפריים הראשון תמיד
    0x10  אודיו (slin16: PCM 16-bit LE, 8kHz או 16kHz, mono)
    0xff  שגיאה

⚠ הפריים הראשון הוא מה שמקשר את החיבור לשיחה. בלי ה-UUID אין דרך לדעת
איזו שיחה מדברת — Asterisk לא שולח מזהה בשום מקום אחר בזרם.

## למה TCP ולא RTP
RTP דורש טיפול ב-jitter buffer, ב-NAT ובאובדן חבילות. AudioSocket מעל
TCP מוותר על "זמן אמת קשיח" ומקבל בתמורה זרם אמין וסדור — וזה בדיוק
מה שנדרש כשהצד השני הוא מנוע תמלול ולא אוזן אנושית.
"""

from __future__ import annotations

import asyncio
import struct
import uuid
from typing import Awaitable, Callable

from ..telemetry.logging import get_logger, set_call_id

log = get_logger(__name__)

TYPE_TERMINATE = 0x00
TYPE_UUID = 0x01
TYPE_AUDIO = 0x10
TYPE_ERROR = 0xFF

# 20ms ב-16kHz — הגודל ש-Asterisk שולח ומצפה לקבל.
FRAME_MS = 20
SAMPLE_RATE = 16000
FRAME_BYTES = int(SAMPLE_RATE * FRAME_MS / 1000) * 2

AudioHandler = Callable[[str, bytes], Awaitable[None]]


class AudioSocketServer:
    """מקבל חיבורי אודיו מ-Asterisk.

    כל חיבור = ערוץ אחד. `on_audio` נקרא לכל פריים נכנס; `send()` דוחף
    אודיו חזרה למתקשר.
    """

    def __init__(self, host: str, port: int, on_audio: AudioHandler) -> None:
        self._host = host
        self._port = port
        self._on_audio = on_audio
        self._server: asyncio.Server | None = None
        self._writers: dict[str, asyncio.StreamWriter] = {}
        # ⚠ נעילת כתיבה לכל ערוץ. שני משפטי TTS שנשלחים במקביל היו
        # משתרגים פריים-פריים והמתקשר היה שומע רעש.
        self._locks: dict[str, asyncio.Lock] = {}

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, self._host, self._port)
        log.info("audiosocket_listening", extra={"host": self._host, "port": self._port})

    async def stop(self) -> None:
        for writer in list(self._writers.values()):
            writer.close()
        self._writers.clear()
        self._locks.clear()
        if self._server:
            self._server.close()
            await self._server.wait_closed()
            self._server = None

    # ------------------------------------------------------------------

    async def _handle(self, reader: asyncio.StreamReader,
                      writer: asyncio.StreamWriter) -> None:
        channel_uuid = ""
        try:
            while True:
                header = await reader.readexactly(3)
                ftype, length = struct.unpack("!BH", header)
                payload = await reader.readexactly(length) if length else b""

                if ftype == TYPE_UUID:
                    channel_uuid = str(uuid.UUID(bytes=payload))
                    self._writers[channel_uuid] = writer
                    self._locks[channel_uuid] = asyncio.Lock()
                    set_call_id(channel_uuid)
                    log.info("audiosocket_channel_open")
                elif ftype == TYPE_AUDIO:
                    if channel_uuid:
                        await self._on_audio(channel_uuid, payload)
                elif ftype == TYPE_ERROR:
                    log.warning("audiosocket_error_frame", extra={"payload_len": length})
                elif ftype == TYPE_TERMINATE:
                    break
        except (asyncio.IncompleteReadError, ConnectionResetError):
            # ניתוק באמצע פריים = המתקשר ניתק. מצב רגיל, לא שגיאה.
            pass
        except Exception:  # noqa: BLE001
            log.exception("audiosocket_failed")
        finally:
            if channel_uuid:
                self._writers.pop(channel_uuid, None)
                self._locks.pop(channel_uuid, None)
                log.info("audiosocket_channel_closed")
            writer.close()

    async def send(self, channel_uuid: str, pcm: bytes) -> None:
        """שולח אודיו למתקשר, בקצב אמיתי.

        ⚠ ה-sleep בין הפריימים אינו התחסכות. דחיפת חמש שניות אודיו
        בבת אחת ממלאת את החוצץ של Asterisk, ואז אי אפשר להפסיק את
        הסוכנת באמצע משפט כשהמתקשר מתחיל לדבר — היא תמשיך להשמיע דבר
        שכבר לא רלוונטי. שליחה בקצב היא מה שהופך הפרעה לאפשרית.
        """
        writer = self._writers.get(channel_uuid)
        lock = self._locks.get(channel_uuid)
        if writer is None or lock is None:
            return

        async with lock:
            for i in range(0, len(pcm), FRAME_BYTES):
                frame = pcm[i:i + FRAME_BYTES]
                if len(frame) < FRAME_BYTES:
                    frame = frame + b"\x00" * (FRAME_BYTES - len(frame))
                try:
                    writer.write(struct.pack("!BH", TYPE_AUDIO, len(frame)) + frame)
                    await writer.drain()
                except (ConnectionResetError, BrokenPipeError):
                    return
                await asyncio.sleep(FRAME_MS / 1000)

    def is_connected(self, channel_uuid: str) -> bool:
        return channel_uuid in self._writers
