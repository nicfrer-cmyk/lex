# Voice Gateway Orchestrator
#
# slim ולא alpine: faster-whisper תלוי ב-CTranslate2, שמסופק כ-wheel
# עבור glibc בלבד. על alpine (musl) pip היה מנסה לקמפל מהמקור וזה נכשל
# אחרי עשרים דקות — תקלה שקל מאוד לבזבז עליה ערב שלם.
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /srv

# תלויות לפני הקוד — שכבה שנשמרת ב-cache בין builds. שינוי בקוד לא
# מפעיל התקנה מחדש של כל הספריות.
COPY requirements.txt requirements-stt.txt ./

# תמלול מקומי הוא opt-in. ברירת המחדל היא image קטן ומהיר לבנייה;
# להפעלה:  docker compose build --build-arg WITH_STT=1
ARG WITH_STT=0
RUN pip install --no-cache-dir -r requirements.txt && \
    if [ "$WITH_STT" = "1" ]; then \
        pip install --no-cache-dir -r requirements-stt.txt; \
    fi

COPY app ./app

# ⚠ משתמש לא-root. השירות מאזין לרשת ומעבד קלט חיצוני (אודיו מהקו);
# הרצה כ-root הופכת כל פגיעות לשליטה מלאה במכונה.
RUN useradd --system --create-home --uid 10001 voicegw && \
    mkdir -p /var/spool/lextrack/queue /var/spool/lextrack/recordings && \
    chown -R voicegw:voicegw /var/spool/lextrack /srv
USER voicegw

EXPOSE 8080 8090

# ⚠ עובד יחיד. מצב השיחות (מי מדבר, איזה ערוץ אודיו פתוח) חי בזיכרון
# התהליך; שני workers היו מקבלים חצי מהאירועים כל אחד, ושיחה הייתה
# מתחילה בתהליך אחד ומקבלת אודיו בשני.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1"]
