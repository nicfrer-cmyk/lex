"""חתימת בקשות ל-CRM.

⚠ **חייב להישאר זהה במדויק** ל-`supabase/functions/_shared/voice/signing.ts`.
המחרוזת שנחתמת היא `f"{timestamp}.{nonce}.{body}"`, והחתימה היא HMAC-SHA256
בהקסה קטנה. כל סטייה — רווח, סדר, קידוד — הופכת כל בקשה ל-401, וזה נראה
כמו "השרת לא עונה" ולא כמו "החתימה לא תואמת".

שלוש שכבות, וכל אחת סוגרת פרצה שהאחרות משאירות:
  1. חתימה — מוכיחה שמי ששלח מחזיק בסוד; הגוף חתום, ולכן אי אפשר לשנות
     את מספר המתקשר בבקשה לגיטימית.
  2. חותמת זמן — מצמצמת את חלון השידור החוזר.
  3. nonce — סוגר אותו. ה-CRM דוחה nonce שכבר נראה.
"""

from __future__ import annotations

import hashlib
import hmac
import time
import uuid
from dataclasses import dataclass


@dataclass(frozen=True)
class SignedHeaders:
    office: str
    timestamp: str
    nonce: str
    signature: str

    def as_dict(self) -> dict[str, str]:
        return {
            "X-Voice-Office": self.office,
            "X-Voice-Timestamp": self.timestamp,
            "X-Voice-Nonce": self.nonce,
            "X-Voice-Signature": self.signature,
            "Content-Type": "application/json",
        }


def signing_payload(timestamp: str, nonce: str, body: str) -> str:
    return f"{timestamp}.{nonce}.{body}"


def sign(secret: str, timestamp: str, nonce: str, body: str) -> str:
    return hmac.new(
        secret.encode("utf-8"),
        signing_payload(timestamp, nonce, body).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()


def build_headers(secret: str, office_id: str, body: str, *, nonce: str | None = None,
                  timestamp: int | None = None) -> SignedHeaders:
    """כותרות חתומות לבקשה אחת.

    ⚠ nonce **חדש לכל ניסיון**, כולל retry. שידור חוזר של אותו nonce נדחה
    ב-409 מצד ה-CRM — וזו התנהגות נכונה שלו, לא תקלה. האידמפוטנטיות
    האמיתית מושגת בשכבה אחרת: מפתח הפעולה נגזר מהתוכן, ולכן retry עם
    nonce חדש עדיין לא ייצור פגישה שנייה.
    """
    ts = str(timestamp if timestamp is not None else int(time.time()))
    nc = nonce or uuid.uuid4().hex
    return SignedHeaders(
        office=office_id,
        timestamp=ts,
        nonce=nc,
        signature=sign(secret, ts, nc, body),
    )
