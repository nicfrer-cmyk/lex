// שכבת הפשטה לספקי AI (סעיף 17).
//
// "אין לקשור את כל המערכת ישירות לספק אחד." בפועל: ה-worker לא יודע מה
// זה Anthropic. הוא מקבל AIProvider ומדבר איתו.
//
// שני מימושים כאן: AnthropicProvider (חי) ו-MockProvider (דטרמיניסטי,
// לבדיקות ולמצב demo). OpenAIProvider **לא ממומש בכוונה** — אין credentials,
// והפרומט אוסר להציג אינטגרציה כפעילה כשהיא לא (סעיף 24). נקודת ההרחבה
// היא ה-interface הזה: מימוש חדש לא דורש שינוי בסוכנים, בכלים או ב-worker.

import { estimateCost, countTokens, acceptsTemperature } from './cost.ts';

export type AIMessage = { role: 'user' | 'assistant'; content: unknown };

export type AIToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type AIRequest = {
  model: string;
  system: string;
  messages: AIMessage[];
  tools?: AIToolDef[];
  maxTokens?: number;
  temperature?: number;
};

export type AIToolCall = { id: string; name: string; input: Record<string, unknown> };

export type AIResponse = {
  text: string;
  toolCalls: AIToolCall[];
  rawContent: unknown[];
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  model: string;
};

export interface AIProvider {
  readonly name: string;
  generate(req: AIRequest): Promise<AIResponse>;
  generateStructured<T>(req: AIRequest, schema: Record<string, unknown>): Promise<{ data: T; usage: AIResponse }>;
  countTokens(text: string): number;
  estimateCost(model: string, inTok: number, outTok: number): number;
  testConnection(): Promise<{ ok: boolean; error?: string }>;
}

// ============================================================
// Anthropic
// ============================================================

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') || '';

export class AnthropicProvider implements AIProvider {
  readonly name = 'anthropic';

  async generate(req: AIRequest): Promise<AIResponse> {
    if (!ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY לא מוגדר בשרת');
    }

    // ה-system prompt זהה בין הרצות של אותו סוכן ויקר לשלוח שוב ושוב.
    // cache_control חוסך גם עלות וגם השהיה. אותה טכניקה שהצ'אט הקיים
    // כבר משתמש בה (app.js:4316).
    const system = [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }];

    // גם מערך הכלים גדול וקבוע — סימון האחרון בו מטמין את כולו.
    const tools = req.tools?.length
      ? req.tools.map((t, i) =>
          i === req.tools!.length - 1
            ? { ...t, cache_control: { type: 'ephemeral' } }
            : t)
      : undefined;

    const body: Record<string, unknown> = {
      model: req.model,
      max_tokens: req.maxTokens ?? 2048,
      system,
      messages: req.messages,
    };
    if (tools) body.tools = tools;
    // temperature נשלח **רק** למודלים שמקבלים אותו. הוא הוסר מדורות
    // 4.7 ואילך (Opus 4.7/4.8/5, Sonnet 5, Fable 5) ומוחזר משם כשגיאת 400.
    // ai_agents.default_model ניתן לעריכה ע"י בעל המשרד, ולכן בלי הבדיקה
    // הזו שינוי מודל במסך ההגדרות היה מפיל **כל** הרצה של אותו סוכן.
    // ברירת המחדל הבטוחה היא להשמיט: השמטה אף פעם לא נכשלת.
    if (req.temperature !== undefined && acceptsTemperature(req.model)) {
      body.temperature = req.temperature;
    }

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        // הערה: prompt caching הוא GA ואינו דורש beta header. ai-proxy הקיים
        // עדיין שולח את 'prompt-caching-2024-07-31' — שריד לא מזיק. כאן לא
        // שולחים אותו; cache_control פועל בלעדיו.
      },
      body: JSON.stringify(body),
    });

    const data = await resp.json();
    if (!resp.ok) {
      const msg = data?.error?.message || `HTTP ${resp.status}`;
      throw new Error(`שגיאת ספק AI: ${msg}`);
    }
    return parseAnthropic(data, req.model);
  }

  async generateStructured<T>(
    req: AIRequest, schema: Record<string, unknown>,
  ): Promise<{ data: T; usage: AIResponse }> {
    // כפיית פלט מובנה דרך tool_choice — אמין הרבה יותר מ"החזר JSON בבקשה"
    // ואז parsing. הפרומט (סעיף 17) דורש מפורשות: "אין להסתמך על parsing
    // חופשי של טקסט כאשר מדובר ביצירת משימה, מועד, הודעה או שינוי נתון".
    const tool: AIToolDef = {
      name: 'submit_result',
      description: 'החזר את התוצאה במבנה הנדרש',
      input_schema: schema,
    };
    const resp = await this.generate({ ...req, tools: [tool] });
    const call = resp.toolCalls.find((c) => c.name === 'submit_result');
    if (!call) {
      // גיבוי: נסה לחלץ JSON מהטקסט (המודל התעלם מהכלי).
      const parsed = extractJson(resp.text);
      if (parsed) return { data: parsed as T, usage: resp };
      throw new Error('המודל לא החזיר תוצאה מובנית');
    }
    return { data: call.input as T, usage: resp };
  }

  countTokens(text: string): number { return countTokens(text); }
  estimateCost(model: string, i: number, o: number): number { return estimateCost(model, i, o); }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    if (!ANTHROPIC_API_KEY) return { ok: false, error: 'ANTHROPIC_API_KEY לא מוגדר' };
    try {
      await this.generate({
        model: 'claude-haiku-4-5-20251001',
        system: 'ענה במילה אחת.',
        messages: [{ role: 'user', content: 'בדיקה' }],
        maxTokens: 16,
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
}

function parseAnthropic(data: Record<string, any>, model: string): AIResponse {
  const content: unknown[] = data.content || [];
  const text = content
    .filter((b: any) => b?.type === 'text')
    .map((b: any) => b.text)
    .join('\n')
    .trim();
  const toolCalls: AIToolCall[] = content
    .filter((b: any) => b?.type === 'tool_use')
    .map((b: any) => ({ id: b.id, name: b.name, input: b.input || {} }));

  const usage = data.usage || {};
  // טוקנים שנקראו מה-cache נספרים כקלט לצורך העלות — התעריף שונה בפועל
  // אצל הספק, אבל אומדן גבוה מדי בטוח יותר מנמוך מדי כשהוא מפעיל תקציב.
  const inputTokens = (usage.input_tokens || 0)
    + (usage.cache_creation_input_tokens || 0)
    + (usage.cache_read_input_tokens || 0);
  const outputTokens = usage.output_tokens || 0;

  return {
    text, toolCalls, rawContent: content,
    stopReason: data.stop_reason || 'end_turn',
    inputTokens, outputTokens,
    cost: estimateCost(model, inputTokens, outputTokens),
    model: data.model || model,
  };
}

function extractJson(text: string): unknown | null {
  if (!text) return null;
  // המודל עוטף לעיתים ב-```json — אותה בעיה שכבר טופלה ב-app.js:2208.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  try { return JSON.parse(candidate.slice(start).trim()); } catch { return null; }
}

// ============================================================
// Mock — לבדיקות ולמצב demo
// ============================================================
//
// דטרמיניסטי לחלוטין: אותו קלט → אותו פלט, בלי רשת ובלי עלות. זה מה
// שמאפשר לבדוק את כל הזרימה (job → worker → tool → approval) בלי מפתח
// API ובלי לשלוח כלום החוצה (סעיף 24).

export class MockProvider implements AIProvider {
  readonly name = 'mock';
  /** תסריט תגובות; כל קריאה שולפת את הבא בתור. */
  constructor(private script: Array<Partial<AIResponse>> = []) {}
  private callIndex = 0;

  generate(req: AIRequest): Promise<AIResponse> {
    const scripted = this.script[this.callIndex++];
    const inputTokens = countTokens(req.system + JSON.stringify(req.messages));
    const text = scripted?.text
      ?? `[MOCK] תשובה סימולטיבית של הסוכן. מודל: ${req.model}. אין קריאה אמיתית לספק AI.`;
    const outputTokens = countTokens(text);
    return Promise.resolve({
      text,
      toolCalls: scripted?.toolCalls ?? [],
      rawContent: scripted?.rawContent ?? [{ type: 'text', text }],
      stopReason: scripted?.stopReason ?? (scripted?.toolCalls?.length ? 'tool_use' : 'end_turn'),
      inputTokens, outputTokens,
      cost: 0,             // מצב mock לעולם לא נספר בתקציב
      model: req.model,
    });
  }

  async generateStructured<T>(req: AIRequest, schema: Record<string, unknown>) {
    const usage = await this.generate(req);
    // מייצר אובייקט תואם-סכימה עם ערכי דמה, כדי שהקוד שצורך אותו ירוץ
    // באותו נתיב בדיוק כמו במצב live.
    const props = (schema.properties || {}) as Record<string, any>;
    const data: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(props)) {
      data[k] = v.type === 'number' || v.type === 'integer' ? 0
        : v.type === 'boolean' ? false
        : v.type === 'array' ? []
        : v.type === 'object' ? {}
        : `[MOCK] ${k}`;
    }
    return { data: data as T, usage };
  }

  countTokens(text: string): number { return countTokens(text); }
  estimateCost(): number { return 0; }
  testConnection(): Promise<{ ok: boolean; error?: string }> {
    return Promise.resolve({ ok: true });
  }
}

/**
 * בוחר ספק. AI_PROVIDER_MODE=mock מכריח mock גם אם יש מפתח — כך אפשר
 * להריץ סביבת בדיקות מול production DB בלי לשלוח בקשה אמיתית אחת.
 */
export function getProvider(officeMode?: string): AIProvider {
  const envMode = (Deno.env.get('AI_PROVIDER_MODE') || 'live').toLowerCase();
  const mode = envMode === 'mock' || officeMode === 'mock' ? 'mock' : 'live';
  if (mode === 'mock') return new MockProvider();
  // נפילה שקטה ל-mock כשהמפתח חסר הייתה מייצרת הרצות שנראות מוצלחות
  // ומכילות טקסט "[MOCK]" מומצא, במערכת שמפיקה מסמכים משפטיים. עדיף
  // להיכשל ברעש: failRun ירשום no_api_key וההרצה תסומן כנכשלה.
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY לא מוגדר בשרת, והמשרד מוגדר למצב live. ' +
      'הגדר את המפתח, או העבר את מצב ספק ה-AI ל"הדגמה" בהגדרות.');
  }
  return new AnthropicProvider();
}

/**
 * בחירת מודל לפי סוג המשימה. אותו עיקרון של chooseModel ב-app.js:4151 —
 * ניסוח וניתוח מקבלים מודל חזק, שליפה וסיווג מקבלים מודל מהיר וזול.
 */
export function pickModel(jobType: string, agentDefault: string): string {
  const heavy = /draft|legal|review|analy|research|summar|נסח|ניתוח|ביקורת|מחקר|סיכום/i;
  if (heavy.test(jobType)) {
    return agentDefault.includes('haiku') ? 'claude-sonnet-4-6' : agentDefault;
  }
  return agentDefault;
}
