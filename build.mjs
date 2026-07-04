// Phase 2: single web build. Netlify runs `node build.mjs` and publishes dist/.
// Electron and the Android app (Capacitor "remote URL" mode) both just load the deployed
// site, so this is now the only build target that matters.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const root = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(root, 'src');
const outDir = path.join(root, 'dist');
const vendorDir = path.join(outDir, 'vendor');

fs.mkdirSync(vendorDir, { recursive: true });

// Cache-busting query string appended to every script tag below. Without this, a
// deploy that only changes app.js/platform.js etc. (not index.html's own bytes)
// can leave phones/browsers serving a stale cached copy of those scripts indefinitely
// — the exact "I fixed it but the site still does the old thing" trap. index.html
// itself is also marked no-cache in netlify.toml so the browser always re-fetches it
// and picks up this new query string.
const buildVersion = Date.now();

// index.html: markup/CSS from src/app.html, with the real script tags injected.
const appHtml = fs.readFileSync(path.join(src, 'app.html'), 'utf8');
const html = appHtml.replace(
  '<!-- SCRIPTS: injected by build.mjs per target (electron vs www) -->',
  [
    // platform.js MUST load first: it sets window.Buffer (a polyfill). JSZip, bundled
    // inside vendor/docx.umd.js, feature-detects "is Buffer available" ONCE at that
    // script's own load time and caches the result — if the polyfill isn't there yet,
    // JSZip permanently decides nodebuffer output isn't supported, and every docx
    // generation (AI agent reports, ATF/POA templates) fails at Packer.toBuffer()
    // with "nodebuffer is not supported by this platform", even though the polyfill
    // exists by the time it's actually called. Confirmed via a real headless Chromium
    // test, not just guessed.
    'platform.js',
    'vendor/docx.umd.js',
    'vendor/pizzip.min.js',
    'vendor/mammoth.browser.min.js',
    'app.js',
    'auth.js',
    'template-manager.js',
  ].map(s => `<script src="${s}?v=${buildVersion}"></script>`).join('\n')
);
fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

// Plain, unbundled files — must stay plain scripts so top-level function declarations
// (nav(), saveCase(), etc.) stay reachable from the HTML's onclick="..." attributes.
fs.copyFileSync(path.join(src, 'app.js'), path.join(outDir, 'app.js'));
fs.copyFileSync(path.join(src, 'auth.js'), path.join(outDir, 'auth.js'));
fs.copyFileSync(path.join(src, 'template-manager.js'), path.join(outDir, 'template-manager.js'));

// Prebuilt browser/UMD dist files straight from node_modules.
fs.copyFileSync(path.join(root, 'node_modules/docx/dist/index.umd.cjs'), path.join(vendorDir, 'docx.umd.js'));
fs.copyFileSync(path.join(root, 'node_modules/pizzip/dist/pizzip.min.js'), path.join(vendorDir, 'pizzip.min.js'));
fs.copyFileSync(path.join(root, 'node_modules/mammoth/mammoth.browser.min.js'), path.join(vendorDir, 'mammoth.browser.min.js'));

// platform.web.js needs real bundling: @supabase/supabase-js, buffer, docxtemplater.
await esbuild.build({
  entryPoints: [path.join(src, 'platform.web.js')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2019',
  outfile: path.join(outDir, 'platform.js'),
  logLevel: 'info',
});

console.log('[build] wrote dist/ (index.html, app.js, auth.js, platform.js, template-manager.js, vendor/*)');
