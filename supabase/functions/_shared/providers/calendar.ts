// שכבת Calendar Provider (סעיף 10) — Google Calendar.
//
// אזור הזמן קבוע Asia/Jerusalem בכל אירוע. אירוע שנוצר בלי timezone
// מפורש מתפרש לפי הגדרת היומן של המשתמש, ודיון שנקבע לשעה הלא נכונה
// הוא בדיוק סוג הטעות שהמערכת הזו אמורה למנוע.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { decryptJson, encryptJson } from '../crypto.ts';

export const TIMEZONE = 'Asia/Jerusalem';

export type CalEvent = {
  externalId: string; title: string;
  start: string; end: string;         // ISO
  location?: string; description?: string;
  meetingLink?: string;
  attendees?: string[];
  status?: string;
};

export interface CalendarProvider {
  readonly name: string;
  readonly isMock: boolean;
  listEvents(fromISO: string, toISO: string): Promise<CalEvent[]>;
  createEvent(e: Omit<CalEvent, 'externalId'>): Promise<{ ok: boolean; externalId?: string; error?: string }>;
  updateEvent(externalId: string, e: Partial<CalEvent>): Promise<{ ok: boolean; error?: string }>;
  deleteEvent(externalId: string): Promise<{ ok: boolean; error?: string }>;
  findFreeSlots(fromISO: string, toISO: string, minutes: number): Promise<Array<{ start: string; end: string }>>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID') || '';
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET') || '';
const CAL_API = 'https://www.googleapis.com/calendar/v3';

type GoogleCreds = { access_token: string; refresh_token: string; expiry: number };

export class GoogleCalendarProvider implements CalendarProvider {
  readonly name = 'google_calendar';
  readonly isMock = false;
  constructor(private sb: SupabaseClient, private officeId: string, private calendarId = 'primary') {}

  private async accessToken(): Promise<string> {
    const { data: conn } = await this.sb.from('integration_connections')
      .select('encrypted_credentials').eq('office_id', this.officeId)
      .eq('provider', 'google_calendar').maybeSingle();
    if (!conn?.encrypted_credentials) throw new Error('יומן Google אינו מחובר');

    const creds = await decryptJson<GoogleCreds>(conn.encrypted_credentials);
    if (creds.expiry && creds.expiry > Date.now() + 60_000) return creds.access_token;

    const resp = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: creds.refresh_token, grant_type: 'refresh_token',
      }),
    });
    const data = await resp.json();
    if (!resp.ok) {
      await this.sb.from('integration_connections').update({
        status: 'expired', last_error: 'רענון token נכשל',
      }).eq('office_id', this.officeId).eq('provider', 'google_calendar');
      throw new Error('פג תוקף החיבור ליומן. יש להתחבר מחדש.');
    }
    const updated: GoogleCreds = {
      access_token: data.access_token,
      refresh_token: creds.refresh_token,   // Google לא מחזיר אותו ברענון
      expiry: Date.now() + (data.expires_in || 3600) * 1000,
    };
    await this.sb.from('integration_connections').update({
      encrypted_credentials: await encryptJson(updated),
      token_expires_at: new Date(updated.expiry).toISOString(),
      status: 'connected', last_error: null,
    }).eq('office_id', this.officeId).eq('provider', 'google_calendar');
    return updated.access_token;
  }

  async listEvents(fromISO: string, toISO: string): Promise<CalEvent[]> {
    const token = await this.accessToken();
    const url = new URL(`${CAL_API}/calendars/${encodeURIComponent(this.calendarId)}/events`);
    url.searchParams.set('timeMin', fromISO);
    url.searchParams.set('timeMax', toISO);
    url.searchParams.set('singleEvents', 'true');     // מפרק אירועים חוזרים
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '250');

    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error('שגיאה בקריאת היומן: ' + (await r.text()).slice(0, 200));
    const data = await r.json();
    return (data.items || []).map((it: Record<string, any>) => ({
      externalId: it.id,
      title: it.summary || '(ללא כותרת)',
      start: it.start?.dateTime || it.start?.date,
      end: it.end?.dateTime || it.end?.date,
      location: it.location, description: it.description,
      meetingLink: it.hangoutLink,
      attendees: (it.attendees || []).map((a: Record<string, any>) => a.email),
      status: it.status,
    }));
  }

  async createEvent(e: Omit<CalEvent, 'externalId'>) {
    try {
      const token = await this.accessToken();
      const r = await fetch(`${CAL_API}/calendars/${encodeURIComponent(this.calendarId)}/events`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          summary: e.title,
          location: e.location, description: e.description,
          start: { dateTime: e.start, timeZone: TIMEZONE },
          end: { dateTime: e.end, timeZone: TIMEZONE },
          attendees: (e.attendees || []).map((email) => ({ email })),
          reminders: { useDefault: true },
        }),
      });
      const data = await r.json();
      if (!r.ok) return { ok: false, error: data?.error?.message || `HTTP ${r.status}` };
      return { ok: true, externalId: data.id };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async updateEvent(externalId: string, e: Partial<CalEvent>) {
    try {
      const token = await this.accessToken();
      const body: Record<string, unknown> = {};
      if (e.title) body.summary = e.title;
      if (e.location !== undefined) body.location = e.location;
      if (e.description !== undefined) body.description = e.description;
      if (e.start) body.start = { dateTime: e.start, timeZone: TIMEZONE };
      if (e.end) body.end = { dateTime: e.end, timeZone: TIMEZONE };

      const r = await fetch(
        `${CAL_API}/calendars/${encodeURIComponent(this.calendarId)}/events/${externalId}`,
        { method: 'PATCH',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify(body) });
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async deleteEvent(externalId: string) {
    try {
      const token = await this.accessToken();
      const r = await fetch(
        `${CAL_API}/calendars/${encodeURIComponent(this.calendarId)}/events/${externalId}`,
        { method: 'DELETE', headers: { authorization: `Bearer ${token}` } });
      // 410 = כבר נמחק. זו לא שגיאה מבחינת הקורא.
      return r.ok || r.status === 410 ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async findFreeSlots(fromISO: string, toISO: string, minutes: number) {
    const events = await this.listEvents(fromISO, toISO);
    const busy = events
      .filter((e) => e.status !== 'cancelled')
      .map((e) => ({ start: Date.parse(e.start), end: Date.parse(e.end) }))
      .sort((a, b) => a.start - b.start);

    const slots: Array<{ start: string; end: string }> = [];
    const needed = minutes * 60_000;
    let cursor = Date.parse(fromISO);
    const end = Date.parse(toISO);

    const pushIfWorkHours = (from: number, to: number) => {
      // רק שעות עבודה סבירות — הצעת פגישה ל-03:00 היא רעש, לא אפשרות.
      const d = new Date(new Date(from).toLocaleString('en-US', { timeZone: TIMEZONE }));
      const h = d.getHours(), day = d.getDay();
      if (day === 5 || day === 6) return;          // שישי-שבת
      if (h < 9 || h >= 18) return;
      if (to - from >= needed) {
        slots.push({ start: new Date(from).toISOString(), end: new Date(from + needed).toISOString() });
      }
    };

    for (const b of busy) {
      if (b.start > cursor) pushIfWorkHours(cursor, b.start);
      cursor = Math.max(cursor, b.end);
    }
    if (cursor < end) pushIfWorkHours(cursor, end);
    return slots.slice(0, 10);
  }

  async testConnection() {
    try {
      const token = await this.accessToken();
      const r = await fetch(`${CAL_API}/users/me/calendarList`, {
        headers: { authorization: `Bearer ${token}` },
      });
      return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

export class MockCalendarProvider implements CalendarProvider {
  readonly name = 'mock_calendar';
  readonly isMock = true;
  listEvents() { return Promise.resolve([] as CalEvent[]); }
  createEvent(e: Omit<CalEvent, 'externalId'>) {
    console.log('[mock-calendar] would create', e.title, e.start);
    return Promise.resolve({ ok: true, externalId: 'mock-cal-' + crypto.randomUUID() });
  }
  updateEvent() { return Promise.resolve({ ok: true }); }
  deleteEvent() { return Promise.resolve({ ok: true }); }
  findFreeSlots() { return Promise.resolve([] as Array<{ start: string; end: string }>); }
  testConnection() {
    return Promise.resolve({ ok: false, error: 'מצב הדגמה — לא מחובר יומן Google אמיתי' });
  }
}

export async function getCalendarProvider(
  sb: SupabaseClient, officeId: string,
): Promise<CalendarProvider> {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return new MockCalendarProvider();
  const { data: conn } = await sb.from('integration_connections')
    .select('status, config').eq('office_id', officeId)
    .eq('provider', 'google_calendar').maybeSingle();
  if (conn?.status !== 'connected') return new MockCalendarProvider();
  const calId = (conn.config as Record<string, unknown>)?.calendar_id as string || 'primary';
  return new GoogleCalendarProvider(sb, officeId, calId);
}
