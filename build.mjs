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
    'vendor/pdf-lib.min.js',
    'vendor/html2canvas.min.js',
    'legal-content.js',
    'app.js',
    // practice.js (litigation/contracts/deadlines/billing) uses app.js's globals.
    'practice.js',
    'auth.js',
    'template-manager.js',
    // ai-center.js must load AFTER app.js: it calls app.js's globals (db, saveDB,
    // notify, escapeHtml, uid, openModal) at call time, and app.js in turn calls
    // ai-center.js's AiMatterActions/renderAiCenter behind `typeof x === 'function'`
    // guards — so neither breaks if the other is missing, but this order is what
    // makes both halves actually work.
    'ai-center.js',
    // automations.js נטען אחרי ai-center.js: הוא משתמש ב-aiSb/aiInvoke/
    // aiUpdateChecked/aiJsAttr שלו, ובגלובלים של app.js.
    'automations.js',
  ].map(s => `<script src="${s}?v=${buildVersion}"></script>`).join('\n')
);
fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

// Plain, unbundled files — must stay plain scripts so top-level function declarations
// (nav(), saveCase(), etc.) stay reachable from the HTML's onclick="..." attributes.
fs.copyFileSync(path.join(src, 'legal-content.js'), path.join(outDir, 'legal-content.js'));
fs.copyFileSync(path.join(src, 'app.js'), path.join(outDir, 'app.js'));
fs.copyFileSync(path.join(src, 'practice.js'), path.join(outDir, 'practice.js'));
fs.copyFileSync(path.join(src, 'auth.js'), path.join(outDir, 'auth.js'));
fs.copyFileSync(path.join(src, 'template-manager.js'), path.join(outDir, 'template-manager.js'));
fs.copyFileSync(path.join(src, 'ai-center.js'), path.join(outDir, 'ai-center.js'));
fs.copyFileSync(path.join(src, 'automations.js'), path.join(outDir, 'automations.js'));
// sw.js is registered via navigator.serviceWorker.register('/sw.js'), not a <script>
// tag — must stay at the site root (not versioned/cache-busted) so its scope covers
// the whole origin; a service worker can only control paths at or below its own URL.
fs.copyFileSync(path.join(src, 'sw.js'), path.join(outDir, 'sw.js'));

// Prebuilt browser/UMD dist files straight from node_modules.
fs.copyFileSync(path.join(root, 'node_modules/docx/dist/index.umd.cjs'), path.join(vendorDir, 'docx.umd.js'));
fs.copyFileSync(path.join(root, 'node_modules/pizzip/dist/pizzip.min.js'), path.join(vendorDir, 'pizzip.min.js'));
fs.copyFileSync(path.join(root, 'node_modules/mammoth/mammoth.browser.min.js'), path.join(vendorDir, 'mammoth.browser.min.js'));
// pdf-lib — builds the actual downloadable e-filing PDF (real page copying/embedding,
// not just a print dialog); see downloadEfilingPDF() in app.js.
fs.copyFileSync(path.join(root, 'node_modules/pdf-lib/dist/pdf-lib.min.js'), path.join(vendorDir, 'pdf-lib.min.js'));
// html2canvas — rasterizes the cover/TOC/.docx-page HTML this feature generates
// itself into images to embed as PDF pages. A hand-rolled SVG <foreignObject>
// rasterizer was tried first to avoid this dependency, but it silently duplicated
// content when the HTML contained a <table> (confirmed via a real Chromium
// screenshot, not just a hunch) — not something to risk shipping on a legal document.
fs.copyFileSync(path.join(root, 'node_modules/html2canvas/dist/html2canvas.min.js'), path.join(vendorDir, 'html2canvas.min.js'));

// pdf.js — the "legacy" build (broader browser/webview compatibility, see the doc
// preview's renderPdfPages()) ships as ES modules only, loaded via dynamic import(),
// not a plain <script> tag like the other vendor files above. cmaps/standard_fonts are
// pdf.js's own recommended bundle for correctly rendering PDFs whose fonts aren't fully
// embedded (common in scanned/exported court-system documents this app handles).
fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.min.mjs'), path.join(vendorDir, 'pdf.min.mjs'));
fs.copyFileSync(path.join(root, 'node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs'), path.join(vendorDir, 'pdf.worker.min.mjs'));
fs.cpSync(path.join(root, 'node_modules/pdfjs-dist/cmaps'), path.join(vendorDir, 'cmaps'), { recursive: true });
fs.cpSync(path.join(root, 'node_modules/pdfjs-dist/standard_fonts'), path.join(vendorDir, 'standard_fonts'), { recursive: true });

// platform.web.js needs real bundling: @supabase/supabase-js, buffer, docxtemplater.
await esbuild.build({
  entryPoints: [path.join(src, 'platform.web.js')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2019',
  outfile: path.join(outDir, 'platform.js'),
  // ~600KB unminified (supabase-js + docxtemplater + buffer), parsed before anything
  // else on every page load. Minifying is safe here: it's a self-contained IIFE whose
  // only public surface is the window.* properties it assigns.
  minify: true,
  logLevel: 'info',
});

// Response headers, as a _headers file in the published folder. The [[headers]] rules
// in netlify.toml were never applied to this site (not even index.html's no-cache), so
// the headers are shipped the way Netlify always honours: dist/_headers. Keep the
// policy in sync with netlify.toml's comment; it is the single source from here on.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
  "img-src 'self' data: blob: https://syxutnwbpjsvzlwfpvyc.supabase.co",
  "connect-src 'self' https://syxutnwbpjsvzlwfpvyc.supabase.co wss://syxutnwbpjsvzlwfpvyc.supabase.co",
  "worker-src 'self' blob:",
  "frame-src 'self' blob: https://syxutnwbpjsvzlwfpvyc.supabase.co",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
fs.writeFileSync(path.join(outDir, '_headers'), [
  '/*',
  '  X-Frame-Options: DENY',
  '  X-Content-Type-Options: nosniff',
  '  Referrer-Policy: strict-origin-when-cross-origin',
  '  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()',
  // Report-only first: inline onclick handlers/styles are still everywhere, and a wrong
  // enforced policy would break the site for every user at once.
  `  Content-Security-Policy-Report-Only: ${CSP}`,
  // Vendor bundles never change in place (every build stamps a new ?v=), so the browser
  // can keep them instead of re-downloading ~3MB of libraries on each visit.
  '/vendor/*',
  '  Cache-Control: public, max-age=31536000, immutable',
  '/',
  '  Cache-Control: no-cache, must-revalidate',
  '/index.html',
  '  Cache-Control: no-cache, must-revalidate',
  '',
].join('\n'));

console.log('[build] wrote dist/ (index.html, app.js, auth.js, platform.js, template-manager.js, vendor/*, _headers)');
