// Login/signup gate. Shows #auth-gate until a Supabase session exists, then reveals
// #app-root and calls app.js's bootApp() exactly once. Relies on window.supabaseClient,
// which platform.web.js sets up.

let appBooted = false;
// Guards against a real race: supabase.auth.signUp() establishes the session (which
// fires onAuthStateChange -> showApp() -> bootApp() -> loadDB()) BEFORE Platform.signUp()
// has finished creating the office/office_members rows that loadDB() needs. While this
// flag is set, the auth-state listener stands down; authSignUp() calls showApp() itself
// once office creation is fully done.
let suppressAuthListener = false;

// Set true while the user is on the "set new password" screen reached via a Supabase
// recovery-link redirect — stays true until they actually submit a new password, so the
// auth-state listener doesn't route them straight into the app on the temporary recovery
// session Supabase establishes when the page loads with a recovery link's URL hash.
let inPasswordRecovery = false;

// Google's OAuth policy blocks sign-in from an embedded WebView (exactly what the
// installed Android app's "remote URL" shell is) — it forces the flow out to the
// system browser instead, and there's no way back into the native app from there
// without native deep-link plumbing this project doesn't have yet. Hiding the button
// here avoids offering something that visibly fails; email/password still works fine
// in the installed app, and Google sign-in still works fine in a normal browser tab.
if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
  const el = document.getElementById('auth-google-wrap');
  if (el) el.style.display = 'none';
}

function authShowError(msg) {
  const el = document.getElementById('auth-error');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}
function authShowStatus(msg) {
  document.getElementById('auth-status').textContent = msg || '';
}
function authFriendlyError(e) {
  const msg = (e && e.message) || String(e);
  if (/Invalid login credentials/i.test(msg)) return 'אימייל או סיסמה שגויים';
  if (/already registered/i.test(msg)) return 'כתובת האימייל כבר רשומה במערכת — נסה להתחבר במקום';
  if (/Password should be/i.test(msg)) return 'הסיסמה קצרה מדי — נדרשים לפחות 6 תווים';
  return msg;
}

async function authSignIn(btn) {
  authShowError('');
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) { authShowError('נא למלא אימייל וסיסמה'); return; }
  authShowStatus('מתחבר...');
  if (btn) btn.disabled = true;
  try {
    await Platform.signIn(email, password);
    authShowStatus('');
    // Left disabled on success — the auth-gate is about to be hidden by showApp()
    // anyway, and re-enabling would just flash the button an instant before that.
  } catch (e) {
    authShowStatus('');
    authShowError(authFriendlyError(e));
    if (btn) btn.disabled = false;
  }
}

// Full registration — separate from the simple login form's email+password (see
// #auth-signup-form in app.html): collects real contact/business details and shows
// the plan up front, closer to a real SaaS signup than the original bare form.
async function authFullSignUp(btn) {
  authShowError('');
  const fullName = document.getElementById('signup-fullname').value.trim();
  const officeName = document.getElementById('signup-office-name').value.trim();
  const phone = document.getElementById('signup-phone').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const address = document.getElementById('signup-address').value.trim();
  const password = document.getElementById('signup-password').value;
  if (!fullName || !officeName || !phone || !email || !password) {
    authShowError('נא למלא את כל השדות המסומנים בכוכבית (*)');
    return;
  }
  if (password.length < 6) { authShowError('הסיסמה חייבת להכיל לפחות 6 תווים'); return; }
  if (!document.getElementById('signup-accept-terms').checked) {
    authShowError('יש לאשר את תנאי השימוש ומדיניות הפרטיות כדי להמשיך');
    return;
  }
  authShowStatus('נרשם ומתחיל תקופת ניסיון...');
  if (btn) btn.disabled = true;
  suppressAuthListener = true;
  try {
    await Platform.signUp(email, password, { fullName, officeName, phone, address });
    authShowStatus('');
    // showApp() itself now creates the solo office (via ensureSoloOffice(), so the
    // same bootstrap covers Google sign-in too) — calling it explicitly here, only
    // after Platform.signUp() resolves, is what the suppressAuthListener guard above
    // exists for: without it, the auth-state listener would race to call showApp()
    // the instant supabase.auth.signUp() establishes a session, before we're ready.
    suppressAuthListener = false;
    showApp();
  } catch (e) {
    suppressAuthListener = false;
    authShowStatus('');
    authShowError(authFriendlyError(e));
    if (btn) btn.disabled = false;
  }
}

async function authSignInWithGoogle(btn) {
  authShowError('');
  authShowStatus('מפנה ל-Google...');
  if (btn) btn.disabled = true;
  try {
    await Platform.signInWithGoogle();
    // No showApp() call here: signInWithOAuth() navigates the browser away to
    // Google immediately, then back — this code doesn't keep running across that
    // redirect. The returning page load's onAuthStateChange fires showApp() itself
    // once Supabase's client detects the session in the redirect URL.
  } catch (e) {
    authShowStatus('');
    authShowError(authFriendlyError(e));
    if (btn) btn.disabled = false;
  }
}

async function authSignOut() {
  if (!await customConfirm('להתנתק?', { title: 'התנתקות' })) return;
  await Platform.signOut();
  location.reload();
}

async function authForgotPassword() {
  authShowError('');
  const email = document.getElementById('auth-email').value.trim();
  if (!email) { authShowError('נא להזין למעלה את כתובת האימייל שלך, ואז ללחוץ שוב על "שכחת סיסמה"'); return; }
  authShowStatus('שולח קישור לאיפוס סיסמה...');
  try {
    await Platform.resetPasswordForEmail(email);
    authShowStatus('');
    await customAlert('נשלח אימייל עם קישור לאיפוס סיסמה. בדוק/י את תיבת הדואר.');
  } catch (e) {
    authShowStatus('');
    authShowError(authFriendlyError(e));
  }
}

async function authSetNewPassword() {
  authShowError('');
  const pw = document.getElementById('auth-new-password').value;
  if (!pw || pw.length < 6) { authShowError('הסיסמה חייבת להכיל לפחות 6 תווים'); return; }
  authShowStatus('מעדכן סיסמה...');
  try {
    await Platform.updatePassword(pw);
    authShowStatus('');
    inPasswordRecovery = false;
    await customAlert('הסיסמה עודכנה בהצלחה!');
    showApp();
  } catch (e) {
    authShowStatus('');
    authShowError(authFriendlyError(e));
  }
}

function showPasswordRecoveryForm() {
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('app-root').style.display = 'none';
  document.getElementById('auth-login-form').style.display = 'none';
  document.getElementById('auth-signup-form').style.display = 'none';
  document.getElementById('auth-recovery-form').style.display = 'block';
}

function showSignupForm() {
  authShowError('');
  document.getElementById('auth-login-form').style.display = 'none';
  document.getElementById('auth-signup-form').style.display = 'block';
}
function showLoginForm() {
  authShowError('');
  document.getElementById('auth-signup-form').style.display = 'none';
  document.getElementById('auth-login-form').style.display = 'block';
}

async function showApp() {
  document.getElementById('auth-gate').style.display = 'none';
  document.getElementById('app-root').style.display = 'flex';
  if (!appBooted) {
    appBooted = true;
    const inviteToken = new URLSearchParams(location.search).get('invite');
    if (inviteToken) {
      try {
        await Platform.redeemInvite(inviteToken);
        notify('הצטרפת למשרד בהצלחה!');
      } catch (e) {
        // A denied insert (RLS) is the expected shape for every real failure reason
        // here — wrong/already-redeemed/expired invite, or the invite's email not
        // matching the signed-in account — but Postgres's raw message ("new row
        // violates row-level security policy...") means nothing to a non-technical
        // user, so translate it to the actual likely causes instead.
        const msg = /row-level security/i.test(e.message)
          ? 'לא ניתן להצטרף עם קישור זה — ייתכן שההזמנה כבר נוצלה/פגה, שאתה כבר חבר במשרד אחר, או שנרשמת עם כתובת אימייל שונה מזו שהוזמנה.'
          : e.message;
        await customAlert('שגיאה בהצטרפות למשרד: ' + msg);
      }
      // Clean the token out of the URL either way — redeeming twice is a harmless
      // no-op (fails the "not already a member" check with a clear error), but
      // there's no reason to keep offering it after the first attempt.
      history.replaceState(null, '', location.pathname);
    } else {
      // No invite in the URL: make sure this user has SOME office before bootApp()'s
      // loadDB() needs one. Used to only happen inside Platform.signUp(), which
      // silently broke a first-time Google sign-in — OAuth has no separate "signUp"
      // step to hang that on, it just lands here via the normal session-restored path.
      try {
        await Platform.ensureSoloOffice();
      } catch (e) {
        await customAlert('שגיאה ביצירת משרד: ' + e.message);
      }
    }
    bootApp();
  }
}
function showAuthGate() {
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('app-root').style.display = 'none';
  document.getElementById('auth-login-form').style.display = 'block';
  document.getElementById('auth-signup-form').style.display = 'none';
  document.getElementById('auth-recovery-form').style.display = 'none';
}

window.supabaseClient.auth.onAuthStateChange((event, session) => {
  if (suppressAuthListener) return;
  if (event === 'PASSWORD_RECOVERY') { inPasswordRecovery = true; showPasswordRecoveryForm(); return; }
  if (inPasswordRecovery) return;
  if (session) showApp(); else showAuthGate();
});
