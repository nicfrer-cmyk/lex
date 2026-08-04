// ולידציית קלט לכלים — JSON Schema מצומצם.
//
// הפרומט (8.2): כל כלי חייב "validation באמצעות schema". הסיבה חזקה יותר
// מהיגיינה: הקלט לכלי מגיע *מהמודל*, שיכול להיות מושפע מתוכן מסמך זדוני.
// הוא לא קלט של מפתח. סכימה שדוחה שדות לא מוכרים היא מה שמונע ממודל
// "משוכנע" להבריח פרמטר שהכלי לא התכוון לקבל.
//
// למה לא ספריית ולידציה מוכנה: זהו קוד Deno שרץ ב-Edge Function, וכל import
// חיצוני הוא עוד תלות רשת בזמן cold start. מה שנדרש כאן הוא תת-קבוצה קטנה
// של JSON Schema, וזה בדיוק היקף הקובץ.

export type JsonSchema = {
  type?: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean';
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  description?: string;
  default?: unknown;
  /** ברירת המחדל היא false — שדה לא מוכר נדחה. ראה ההערה למעלה. */
  additionalProperties?: boolean;
};

export class ValidationError extends Error {
  // שדה מפורש ולא parameter property (`constructor(public path: ...)`) בכוונה:
  // Deno תומך בזה, אבל type-stripping של Node לא — וזה היה מונע מ-
  // test/ai-center-unit.test.js לייבא את הקובץ הזה ולבדוק אותו כלל.
  path: string;
  constructor(path: string, message: string) {
    super(`${path ? path + ': ' : ''}${message}`);
    this.path = path;
  }
}

export function validate(value: unknown, schema: JsonSchema, path = ''): unknown {
  if (schema.type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new ValidationError(path, 'נדרש אובייקט');
    }
    const obj = value as Record<string, unknown>;
    const props = schema.properties || {};
    const out: Record<string, unknown> = {};

    for (const key of schema.required || []) {
      if (obj[key] === undefined || obj[key] === null || obj[key] === '') {
        throw new ValidationError(path ? `${path}.${key}` : key, 'שדה חובה חסר');
      }
    }
    for (const [key, sub] of Object.entries(props)) {
      const p = path ? `${path}.${key}` : key;
      if (obj[key] === undefined || obj[key] === null) {
        if (sub.default !== undefined) out[key] = sub.default;
        continue;
      }
      out[key] = validate(obj[key], sub, p);
    }
    if (schema.additionalProperties !== true) {
      const unknownKeys = Object.keys(obj).filter((k) => !(k in props));
      if (unknownKeys.length) {
        throw new ValidationError(path, `שדות לא מוכרים: ${unknownKeys.join(', ')}`);
      }
    } else {
      for (const [k, v] of Object.entries(obj)) if (!(k in props)) out[k] = v;
    }
    return out;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new ValidationError(path, 'נדרש מערך');
    return schema.items ? value.map((v, i) => validate(v, schema.items!, `${path}[${i}]`)) : value;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new ValidationError(path, 'נדרש טקסט');
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      throw new ValidationError(path, `קצר מדי (מינימום ${schema.minLength})`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      throw new ValidationError(path, `ארוך מדי (מקסימום ${schema.maxLength})`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      throw new ValidationError(path, 'פורמט לא תקין');
    }
    if (schema.enum && !schema.enum.includes(value)) {
      throw new ValidationError(path, `ערך לא מותר. מותרים: ${schema.enum.join(', ')}`);
    }
    return value;
  }

  if (schema.type === 'number' || schema.type === 'integer') {
    // המודל מחזיר לפעמים "1500" כמחרוזת. זו לא חריגה שכדאי להיכשל עליה —
    // המרה מפורשת בטוחה יותר מלגרום לסוכן לנסות שוב ולשרוף עוד עלות.
    const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) throw new ValidationError(path, 'נדרש מספר');
    if (schema.type === 'integer' && !Number.isInteger(n)) {
      throw new ValidationError(path, 'נדרש מספר שלם');
    }
    if (schema.minimum !== undefined && n < schema.minimum) {
      throw new ValidationError(path, `קטן מהמינימום (${schema.minimum})`);
    }
    if (schema.maximum !== undefined && n > schema.maximum) {
      throw new ValidationError(path, `גדול מהמקסימום (${schema.maximum})`);
    }
    return n;
  }

  if (schema.type === 'boolean') {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    throw new ValidationError(path, 'נדרש ערך בוליאני');
  }

  if (schema.enum && !schema.enum.includes(value)) {
    throw new ValidationError(path, `ערך לא מותר. מותרים: ${schema.enum.join(', ')}`);
  }
  return value;
}

/** ממיר סכימה פנימית לפורמט ה-tools של Anthropic. */
export function toAnthropicSchema(schema: JsonSchema): Record<string, unknown> {
  return {
    type: 'object',
    properties: schema.properties || {},
    required: schema.required || [],
  };
}
