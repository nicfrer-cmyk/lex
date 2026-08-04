-- ============================================================================
-- המרת הכללים הקיימים לפורמט הפעולות של מרכז האוטומציות
-- ============================================================================
--
-- ## מה היה שבור
-- שמונת הכללים שנזרעו במיגרציה 20260804000001 שמרו פעולות בפורמט הישן:
--
--   {"agent":"office-manager","job_type":"stuck_matter","goal":"...","priority":6}
--
-- אין בו שדה `type`, ולכן מנוע הפעולות החדש לא מזהה אותו וכל הפעלה
-- מסתיימת ב"פעולה לא מוכרת". נבדק בפועל: טיק על המשרד יצר 13 הרצות
-- ואפס פעולות.
--
-- ## מה משתנה
-- 1. הפורמט הישן עטוף כ-`{"type":"invoke_agent", ...}` — שקול לחלוטין,
--    זו בדיוק הפעולה שהמנוע הישן ביצע.
-- 2. הכללים שיש להם תבנית מקבילה מקבלים את הפעולות של התבנית, שהן
--    התראה ומשימה במקום הפעלת סוכן.
--
-- ## למה 2 ולא רק 1
-- הפעלת סוכן עולה כסף ומחזירה טקסט. "יש לך משימה באיחור 9 ימים" היא
-- שאילתה — היא לא צריכה מודל, היא מיידית, והיא אמינה. הפעלת סוכן נשארת
-- במקום היחיד שבו היא באמת מוסיפה: ניתוח מסמך.
--
-- ⚠ מוגן: נוגע **רק** בכללים שהפעולה הראשונה שלהם חסרת `type`, כלומר
-- בפורמט הישן בלבד. כלל שהמשתמש ערך כבר לפורמט החדש לא נדרס.
-- ============================================================================

-- ---- 1. הכללים שיש להם תבנית: מאמצים את פעולות התבנית ----
update public.automation_rules r
set actions = t.default_actions,
    execution_level = case when r.requires_approval then 'prepare' else t.default_execution_level end,
    cooldown_minutes = t.default_cooldown_minutes,
    estimated_minutes_saved = t.estimated_minutes_saved,
    severity = t.default_severity,
    category = t.category,
    template_key = t.key,
    version = r.version + 1
from public.automation_templates t
where r.template_key = t.key
  and jsonb_array_length(coalesce(r.actions, '[]'::jsonb)) > 0
  and not (r.actions -> 0 ? 'type');       -- פורמט ישן בלבד

-- ---- 2. כללים בלי תבנית: עטיפה שקולה ----
update public.automation_rules r
set actions = (
      select jsonb_agg(
        case when a ? 'type' then a
        else jsonb_build_object('type','invoke_agent') || a end
      )
      from jsonb_array_elements(r.actions) a
    ),
    version = r.version + 1
where jsonb_array_length(coalesce(r.actions, '[]'::jsonb)) > 0
  and not (r.actions -> 0 ? 'type');


-- ============================================================
-- ניקוי ההרצות שנוצרו מהפורמט השבור
-- ============================================================
-- ⚠ מחיקה של היסטוריה נעשית כאן במכוון ובאופן צר: **רק** הרצות שאין להן
-- אף שורת פעולה. אלה ההרצות שנוצרו בבדיקה לפני התיקון, והן חסרות ערך —
-- הן לא מתעדות שום דבר שקרה. השארתן הייתה משאירה את מפתח הייחודיות
-- תפוס להיום, כלומר הכללים לא היו רצים שוב עד מחר, והמשתמש היה רואה
-- מרכז אוטומציות ריק ביום הראשון.
delete from public.automation_runs ar
where not exists (
  select 1 from public.automation_action_logs l where l.automation_run_id = ar.id
);

-- מדדים שנצברו מאותן הרצות ריקות
delete from public.automation_metrics
where run_count > 0 and actions_executed = 0 and minutes_saved = 0;
