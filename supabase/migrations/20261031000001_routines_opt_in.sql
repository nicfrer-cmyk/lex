-- שגרות הצוות רצות רק במשרד שהפעיל אותן במפורש.
--
-- למה: יש 43 משרדים במסד (רובם ניסיונות ורישומים ישנים). בלי המתג, המתזמן
-- היה מריץ 10 סוכנים ביום בכל אחד מהם — עם מפתח Anthropic של בעל המערכת.
-- ברירת המחדל כבויה; הפעלה מלשונית "הגדרות וחיבורים".
alter table public.ai_settings
  add column if not exists routines_enabled boolean not null default false;

-- משרד שאין לו שורת הגדרות מקבל אחת (כבויה), כדי שהמתג יהיה ניתן לשינוי מהממשק.
insert into public.ai_settings (office_id)
select o.id from public.offices o
where not exists (select 1 from public.ai_settings s where s.office_id = o.id);
