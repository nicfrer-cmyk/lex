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
    'auth.js',
    'template-manager.js',
  ].map(s => `<script src="${s}?v=${buildVersion}"></script>`).join('\n')
);
fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

// Plain, unbundled files — must stay plain scripts so top-level function declarations
// (nav(), saveCase(), etc.) stay reachable from the HTML's onclick="..." attributes.
fs.copyFileSync(path.join(src, 'legal-content.js'), path.join(outDir, 'legal-content.js'));
fs.copyFileSync(path.join(src, 'app.js'), path.join(outDir, 'app.js'));
fs.copyFileSync(path.join(src, 'auth.js'), path.join(outDir, 'auth.js'));
fs.copyFileSync(path.join(src, 'template-manager.js'), path.join(outDir, 'template-manager.js'));
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
  logLevel: 'info',
});

console.log('[build] wrote dist/ (index.html, app.js, auth.js, platform.js, template-manager.js, vendor/*)');
