// Login/signup gate. Shows #auth-gate until a Supabase session exists, then reveals
// #app-root and calls app.js's bootApp() exactly once. Relies on window.supabaseClient,
// which platform.web.js sets up.

let appBooted = false;

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
  try {
    await Platform.signUp(email, password);
    authShowStatus('');
    alert('נרשמת בהצלחה! בדוק את תיבת המייל שלך לאישור החשבון, ואז התחבר.');
  } catch (e) {
    authShowStatus('');
    authShowError(authFriendlyError(e));
  }
}

async function authSignOut() {
  if (!confirm('להתנתק?')) return;
  await Platform.signOut();
  location.reload();
}

function showApp() {
  document.getElementById('auth-gate').style.display = 'none';
  document.getElementById('app-root').style.display = 'flex';
  if (!appBooted) { appBooted = true; bootApp(); }
}
function showAuthGate() {
  document.getElementById('auth-gate').style.display = 'flex';
  document.getElementById('app-root').style.display = 'none';
}

window.supabaseClient.auth.onAuthStateChange((_event, session) => {
  if (session) showApp(); else showAuthGate();
});
