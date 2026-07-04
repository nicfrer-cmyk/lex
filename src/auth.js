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

async function authSignIn() {
  authShowError('');
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) { authShowError('נא למלא אימייל וסיסמה'); return; }
  authShowStatus('מתחבר...');
  try {
    await Platform.signIn(email, password);
    authShowStatus('');
  } catch (e) {
    authShowStatus('');
    authShowError(authFriendlyError(e));
  }
}

async function authSignUp() {
  authShowError('');
  const email = document.getElementById('auth-email').value.trim();
  const password = document.getElementById('auth-password').value;
  if (!email || !password) { authShowError('נא למלא אימייל וסיסמה'); return; }
  if (password.length < 6) { authShowError('הסיסמה חייבת להכיל לפחות 6 תווים'); return; }
  authShowStatus('נרשם...');
  suppressAuthListener = true;
  try {
    await Platform.signUp(email, password);
    authShowStatus('');
    // Only now — after office creation (inside Platform.signUp) has actually finished —
    // do we transition to the app. See the race-condition comment on suppressAuthListener.
    suppressAuthListener = false;
    showApp();
  } catch (e) {
    suppressAuthListener = false;
    authShowStatus('');
    authShowError(authFriendlyError(e));
  }
}

async function authSignOut() {
  if (!confirm('להתנתק?')) return;
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
    alert('נשלח אימייל עם קישור לאיפוס סיסמה. בדוק/י את תיבת הדואר.');
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
    alert('הסיסמה עודכנה בהצלחה!');
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
  document.getElementById('auth-recovery-form').style.display = 'block';
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
        alert('שגיאה בהצטרפות למשרד: ' + e.message);
      }
      // Clean the token out of the URL either way — redeeming twice is a harmless
      // no-op (fails the "not already a member" check with a clear error), but
      // there's no reason to keep offering it after the first attempt.
      history.replaceState(null, '', location.pathname);
    }
    bootApp();
  }
}
function showAuthGate() {
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('app-root').style.display = 'none';
  document.getElementById('auth-login-form').style.display = 'block';
  document.getElementById('auth-recovery-form').style.display = 'none';
}

window.supabaseClient.auth.onAuthStateChange((event, session) => {
  if (suppressAuthListener) return;
  if (event === 'PASSWORD_RECOVERY') { inPasswordRecovery = true; showPasswordRecoveryForm(); return; }
  if (inPasswordRecovery) return;
  if (session) showApp(); else showAuthGate();
});
