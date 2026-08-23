"""Outbox מתמיד — SQLite.

## למה לא תור בזיכרון
המפרט מחייב זאת מפורשות, והסיבה קונקרטית: `docker compose restart`
באמצע היום, או קריסה של התהליך, מוחקים תור בזיכרון. מה שנמחק אינו
"בקשת רשת" — זו פנייה של לקוח שהמזכירה קיבלה ולא נרשמה בשום מקום.
הלקוח מצידו כבר קיבל אישור בטלפון.

## למה SQLite ולא קבצים
הגרסה הקודמת השתמשה בקובץ JSON לכל פעולה. זה עבד, אבל:
  • ספירה דרשה סריקת תיקייה,
  • "מה הבא בתור" דרש מיון שמות,
  • ושני ניקוזים במקביל יכלו לקרוא את אותו קובץ.
SQLite נותן את שלושתם בשאילתה, בלי להוסיף שירות — הוא חלק מ-Python.

## ⚠ למה זה בטוח בכלל
כל פעולה נושאת `idempotency_key`, וה-CRM מחזיר את התוצאה המקורית
כשהמפתח חוזר. בלי זה, תור עם retry היה **מנגנון לייצור פגישות
כפולות** ולא מנגנון עמידות.

## Backoff
1, 2, 5, 10, 30, 60 שניות — ואז המרווח נשאר 60. מדרג ולא הכפלה
אינסופית: פעולה שנכשלה שש פעמים לא תצליח בעוד שעה, וכדאי שמישהו
יראה אותה במסך.
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import time
import uuid
from dataclasses import dataclass
from pathlib import Path

from ..telemetry.logging import get_logger

log = get_logger(__name__)

BACKOFF_SECONDS = [1, 2, 5, 10, 30, 60]

SCHEMA = """
create table if not exists outbox (
  id text primary key,
  call_id text,
  call_external_id text,
  tool_call_id text,
  idempotency_key text,
  endpoint text,
  action text not null,
  payload text not null,
  attempt_count integer not null default 0,
  next_attempt_at real not null default 0,
  created_at real not null,
  completed_at real,
  status text not null default 'pending',
  last_error text,
  error_code text
);
create index if not exists outbox_ready on outbox(status, next_attempt_at);
create index if not exists outbox_call on outbox(call_id);
"""


@dataclass
class OutboxEntry:
    id: str
    action: str
    payload: dict
    attempt_count: int
    idempotency_key: str | None = None
    tool_call_id: str | None = None
    call_id: str | None = None
    call_external_id: str | None = None
    endpoint: str | None = None
    last_error: str | None = None


class Outbox:
    """תור מתמיד לפעולות שטרם אושרו ע"י ה-CRM."""

    def __init__(self, db_path: str, max_retries: int = 8) -> None:
        self._path = Path(db_path)
        self._max_retries = max_retries
        self._conn: sqlite3.Connection | None = None
        # ⚠ מנעול אחד לכל הפעולות. sqlite3 אינו בטוח לשימוש מקביל
        # מאותו חיבור, וה-orchestrator כותב מכמה משימות asyncio.
        self._lock = asyncio.Lock()

    async def start(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False נדרש כי asyncio.to_thread מריץ על
        # thread מה-pool, ולא תמיד אותו אחד.
        self._conn = sqlite3.connect(self._path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        # WAL: קורא וכותב לא חוסמים זה את זה, ו-restart באמצע כתיבה
        # לא משאיר קובץ פגום.
        self._conn.execute("pragma journal_mode=WAL")
        self._conn.execute("pragma synchronous=FULL")
        self._conn.executescript(SCHEMA)
        self._conn.commit()

        # פעולות שנשארו ב-'sending' מריצה קודמת — התהליך מת באמצע.
        # ⚠ מוחזרות לתור ולא נזרקות: אנחנו לא יודעים אם ה-CRM קיבל
        # אותן, והאידמפוטנטיות שם היא שתכריע. שליחה חוזרת בטוחה;
        # מחיקה אינה.
        cur = self._conn.execute(
            "update outbox set status='pending' where status='sending'")
        self._conn.commit()
        if cur.rowcount:
            log.warning("outbox_recovered_inflight", extra={"count": cur.rowcount})

    async def close(self) -> None:
        if self._conn:
            self._conn.close()
            self._conn = None

    # ------------------------------------------------------------------

    async def add(self, action: str, payload: dict, *,
                  idempotency_key: str | None = None,
                  tool_call_id: str | None = None,
                  call_id: str | None = None,
                  call_external_id: str | None = None,
                  endpoint: str | None = None) -> str:
        entry_id = uuid.uuid4().hex
        async with self._lock:
            assert self._conn is not None
            self._conn.execute(
                "insert into outbox (id, call_id, call_external_id, tool_call_id, "
                "idempotency_key, endpoint, action, payload, created_at, next_attempt_at) "
                "values (?,?,?,?,?,?,?,?,?,?)",
                (entry_id, call_id, call_external_id, tool_call_id, idempotency_key,
                 endpoint, action, json.dumps(payload, ensure_ascii=False),
                 time.time(), time.time()))
            self._conn.commit()
        log.info("outbox_queued", extra={"action": action, "entry": entry_id})
        return entry_id

    async def next_batch(self, limit: int = 10) -> list[OutboxEntry]:
        """פעולות שהגיע זמנן. מסומנות 'sending' כדי שניקוז מקביל לא ייקח אותן שוב."""
        async with self._lock:
            assert self._conn is not None
            rows = self._conn.execute(
                "select * from outbox where status in ('pending','retrying') "
                "and next_attempt_at <= ? order by created_at limit ?",
                (time.time(), limit)).fetchall()
            if rows:
                self._conn.executemany(
                    "update outbox set status='sending' where id=?",
                    [(r["id"],) for r in rows])
                self._conn.commit()
        return [self._to_entry(r) for r in rows]

    async def mark_completed(self, entry_id: str) -> None:
        async with self._lock:
            assert self._conn is not None
            self._conn.execute(
                "update outbox set status='completed', completed_at=?, last_error=null "
                "where id=?", (time.time(), entry_id))
            self._conn.commit()

    async def mark_failed(self, entry_id: str, error: str,
                          error_code: str | None = None) -> bool:
        """מחזיר True אם הפעולה עברה ל-dead_letter."""
        async with self._lock:
            assert self._conn is not None
            row = self._conn.execute(
                "select attempt_count from outbox where id=?", (entry_id,)).fetchone()
            attempts = (row["attempt_count"] if row else 0) + 1

            if attempts >= self._max_retries:
                self._conn.execute(
                    "update outbox set status='dead_letter', attempt_count=?, "
                    "last_error=?, error_code=? where id=?",
                    (attempts, error[:1000], error_code, entry_id))
                self._conn.commit()
                # ⚠ נרשם ברמת error ולא warning. פעולה שמיצתה את כל
                # הניסיונות היא פנייה שלא נרשמה, והיא חייבת להגיע לעיני
                # אדם — כאן וגם ב-CRM (deadletter.report).
                log.error("outbox_dead_letter", extra={
                    "entry": entry_id, "attempts": attempts, "error": error[:200]})
                return True

            delay = BACKOFF_SECONDS[min(attempts - 1, len(BACKOFF_SECONDS) - 1)]
            self._conn.execute(
                "update outbox set status='retrying', attempt_count=?, "
                "next_attempt_at=?, last_error=?, error_code=? where id=?",
                (attempts, time.time() + delay, error[:1000], error_code, entry_id))
            self._conn.commit()
        log.warning("outbox_retry_scheduled", extra={
            "entry": entry_id, "attempt": attempts, "in_seconds": delay})
        return False

    async def dead_letters(self, limit: int = 50) -> list[OutboxEntry]:
        async with self._lock:
            assert self._conn is not None
            rows = self._conn.execute(
                "select * from outbox where status='dead_letter' "
                "order by created_at limit ?", (limit,)).fetchall()
        return [self._to_entry(r) for r in rows]

    async def mark_reported(self, entry_id: str) -> None:
        """סומן ב-CRM. נשאר ב-dead_letter מקומית עד שניקוי יסלק אותו."""
        async with self._lock:
            assert self._conn is not None
            self._conn.execute(
                "update outbox set error_code='reported' where id=?", (entry_id,))
            self._conn.commit()

    async def requeue(self, entry_id: str) -> None:
        """מחזיר פעולה מתה לתור — לשימוש כשמישהו תיקן את הסיבה."""
        async with self._lock:
            assert self._conn is not None
            self._conn.execute(
                "update outbox set status='pending', attempt_count=0, "
                "next_attempt_at=?, last_error=null where id=?",
                (time.time(), entry_id))
            self._conn.commit()

    async def counts(self) -> dict[str, int]:
        async with self._lock:
            assert self._conn is not None
            rows = self._conn.execute(
                "select status, count(*) as n from outbox group by status").fetchall()
        return {r["status"]: r["n"] for r in rows}

    async def prune(self, older_than_days: int = 7) -> int:
        """מנקה פעולות שהושלמו. dead_letter **לא** נמחק — הוא ראיה."""
        cutoff = time.time() - older_than_days * 86400
        async with self._lock:
            assert self._conn is not None
            cur = self._conn.execute(
                "delete from outbox where status='completed' and completed_at < ?", (cutoff,))
            self._conn.commit()
        return cur.rowcount

    @staticmethod
    def _to_entry(row: sqlite3.Row) -> OutboxEntry:
        return OutboxEntry(
            id=row["id"],
            action=row["action"],
            payload=json.loads(row["payload"]),
            attempt_count=row["attempt_count"],
            idempotency_key=row["idempotency_key"],
            tool_call_id=row["tool_call_id"],
            call_id=row["call_id"],
            call_external_id=row["call_external_id"],
            endpoint=row["endpoint"],
            last_error=row["last_error"],
        )
