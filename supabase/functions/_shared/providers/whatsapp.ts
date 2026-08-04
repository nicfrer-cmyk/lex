// שכבת WhatsApp Provider (סעיף 11) — WhatsApp Business Cloud API.

import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.58.0';
import { normalizePhone } from '../security.ts';

export type WaSendResult = { ok: boolean; externalId?: string; error?: string };

export interface WhatsAppProvider {
  readonly name: string;
  readonly isMock: boolean;
  sendText(to: string, body: string): Promise<WaSendResult>;
  sendTemplate(to: string, template: string, params: string[], lang?: string): Promise<WaSendResult>;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

const WA_TOKEN = Deno.env.get('WHATSAPP_TOKEN') || '';
const WA_PHONE_ID = Deno.env.get('WHATSAPP_PHONE_NUMBER_ID') || '';
const WA_API = 'https://graph.facebook.com/v21.0';

export class CloudWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'whatsapp';
  readonly isMock = false;

  private async post(payload: Record<string, unknown>): Promise<WaSendResult> {
    const resp = await fetch(`${WA_API}/${WA_PHONE_ID}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${WA_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    });
    const data = await resp.json();
    if (!resp.ok) return { ok: false, error: data?.error?.message || `HTTP ${resp.status}` };
    return { ok: true, externalId: data?.messages?.[0]?.id };
  }

  async sendText(to: string, body: string): Promise<WaSendResult> {
    // WhatsApp דורש E.164 בלי הסימן +. נרמול חובה: אותו לקוח מופיע ב-CRM
    // כ-050-1234567 ובוואטסאפ כ-972501234567.
    const e164 = normalizePhone(to);
    if (!e164) return { ok: false, error: `מספר טלפון לא תקין: ${to}` };
    return await this.post({
      to: e164.replace('+', ''), type: 'text',
      text: { preview_url: false, body },
    });
  }

  async sendTemplate(to: string, template: string, params: string[], lang = 'he'): Promise<WaSendResult> {
    const e164 = normalizePhone(to);
    if (!e164) return { ok: false, error: `מספר טלפון לא תקין: ${to}` };
    return await this.post({
      to: e164.replace('+', ''), type: 'template',
      template: {
        name: template, language: { code: lang },
        components: params.length
          ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: t })) }]
          : [],
      },
    });
  }

  async testConnection() {
    if (!WA_TOKEN || !WA_PHONE_ID) return { ok: false, error: 'חסרים WHATSAPP_TOKEN / PHONE_NUMBER_ID' };
    const r = await fetch(`${WA_API}/${WA_PHONE_ID}`, {
      headers: { authorization: `Bearer ${WA_TOKEN}` },
    });
    return r.ok ? { ok: true } : { ok: false, error: `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}` };
  }
}

export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly name = 'mock_whatsapp';
  readonly isMock = true;
  sendText(to: string, body: string): Promise<WaSendResult> {
    console.log('[mock-whatsapp] would send', { to, chars: body.length });
    return Promise.resolve({ ok: true, externalId: 'mock-wa-' + crypto.randomUUID() });
  }
  sendTemplate(to: string, template: string): Promise<WaSendResult> {
    console.log('[mock-whatsapp] would send template', { to, template });
    return Promise.resolve({ ok: true, externalId: 'mock-wa-' + crypto.randomUUID() });
  }
  testConnection() {
    return Promise.resolve({ ok: false, error: 'מצב הדגמה — לא מחובר חשבון WhatsApp Business אמיתי' });
  }
}

export async function getWhatsAppProvider(
  sb: SupabaseClient, officeId: string,
): Promise<WhatsAppProvider> {
  if ((Deno.env.get('WHATSAPP_PROVIDER_MODE') || 'mock').toLowerCase() === 'mock') {
    return new MockWhatsAppProvider();
  }
  if (!WA_TOKEN || !WA_PHONE_ID) return new MockWhatsAppProvider();

  const { data: conn } = await sb.from('integration_connections')
    .select('status').eq('office_id', officeId).eq('provider', 'whatsapp').maybeSingle();
  if (conn?.status !== 'connected') return new MockWhatsAppProvider();

  return new CloudWhatsAppProvider();
}

/**
 * שעות פעילות ו-opt-out (סעיף 11).
 *
 * שתי הבדיקות האלה אינן נימוס — הן חוק. שליחת הודעה מסחרית למי שביקש
 * להפסיק, או בשעות לא סבירות, חושפת את המשרד לתלונה. הבדיקה נעשית כאן
 * ולא בסוכן, כי סוכן יכול "לשכוח" הנחיה; קוד לא.
 */
export function canSendNow(config: Record<string, unknown>, optedOut: boolean): { ok: boolean; reason?: string } {
  if (optedOut) return { ok: false, reason: 'הנמען ביקש להפסיק לקבל הודעות (opt-out)' };

  const hours = config.business_hours as { start?: number; end?: number; days?: number[] } | undefined;
  if (!hours) return { ok: true };

  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Jerusalem' }));
  const day = now.getDay();          // 0=ראשון, 6=שבת
  const hour = now.getHours();

  // ברירת מחדל: ראשון–חמישי. שישי ושבת מוחרגים אלא אם הוגדר אחרת.
  const days = hours.days || [0, 1, 2, 3, 4];
  if (!days.includes(day)) return { ok: false, reason: 'מחוץ לימי הפעילות של המשרד' };
  if (hour < (hours.start ?? 9) || hour >= (hours.end ?? 18)) {
    return { ok: false, reason: 'מחוץ לשעות הפעילות של המשרד' };
  }
  return { ok: true };
}
