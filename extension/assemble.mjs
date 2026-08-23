import { cpSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dist = resolve(__dirname, 'dist');

// ── Static files ─────────────────────────────────────────────────────────────

cpSync('src/popup.html', 'dist/popup.html');
cpSync('src/offscreen.html', 'dist/offscreen.html');
cpSync('src/popup.css', 'dist/popup.css');
cpSync('src/icons', 'dist/icons', { recursive: true });

// theme.css holds the design tokens and is linked from every surface. Chrome
// resolves <link> relative to the page, so it needs to exist at both depths.
cpSync('src/theme.css', 'dist/theme.css');

mkdirSync('dist/pages', { recursive: true });
cpSync('src/theme.css', 'dist/pages/theme.css');
cpSync('src/pages/panel.html', 'dist/pages/panel.html');
cpSync('src/pages/panel.css', 'dist/pages/panel.css');
cpSync('src/pages/transcript.html', 'dist/pages/transcript.html');
cpSync('src/pages/transcript.css', 'dist/pages/transcript.css');
cpSync('src/pages/summary.html', 'dist/pages/summary.html');
cpSync('src/pages/summary.css', 'dist/pages/summary.css');
cpSync('src/pages/settings.html', 'dist/pages/settings.html');
cpSync('src/pages/settings.css', 'dist/pages/settings.css');
cpSync('src/pages/history.html', 'dist/pages/history.html');
cpSync('src/pages/history.css', 'dist/pages/history.css');

// ── Manifest ─────────────────────────────────────────────────────────────────

// THIS is the manifest Chrome loads. `src/manifest.json` is an authoring copy
// with source paths (src/background.ts, src/popup.html) and nothing reads it, so
// any new key added there must be added here too or it silently never ships.

const manifest = {
  manifest_version: 3,
  name: 'Lecture AI',
  version: '0.2.0',
  description:
    'Live in-class assistant. Catch up on what you missed, and always have a question ready.',
  permissions: [
    'activeTab',
    'storage',
    'unlimitedStorage',
    'tabs',
    'tabCapture',
    'offscreen',
    'alarms',
    'sidePanel',
    // Reading the video's playhead so a transcript timestamp can map back to a
    // position, and seeking it when a line is clicked.
    'scripting',
  ],
  // The two API hosts are only reachable in BYOK mode; the localhost entries
  // keep the optional proxy working.
  host_permissions: [
    'http://localhost:3001/*',
    'http://127.0.0.1:3001/*',
    'https://api.deepgram.com/*',
    'https://generativelanguage.googleapis.com/*',
  ],
  background: { service_worker: 'background.js', type: 'module' },
  action: {
    default_popup: 'popup.html',
    default_title: 'Lecture AI',
    default_icon: { '128': 'icons/icon128.png' },
  },
  side_panel: { default_path: 'pages/panel.html' },
  options_page: 'pages/settings.html',
  // A browser-level shortcut, so "I'm lost" works without hunting for a button
  // while the professor is still talking. Chrome delivers this even when the
  // lecture tab has focus, which is the entire point.
  commands: {
    'flag-moment': {
      suggested_key: { default: 'Alt+L', mac: 'Alt+L' },
      description: 'Lost me here — mark this moment as unclear',
    },
  },
  icons: { '128': 'icons/icon128.png' },
  web_accessible_resources: [
    {
      resources: ['pages/*', 'offscreen.html', 'offscreen.js', 'chunks/*', 'assets/*'],
      matches: ['<all_urls>'],
    },
  ],
  content_security_policy: {
    extension_pages:
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src http://localhost:3001 http://127.0.0.1:3001 https://api.deepgram.com https://generativelanguage.googleapis.com; img-src 'self' data:; font-src 'self' data:; object-src 'none';",
  },
};

writeFileSync(resolve(dist, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log('Assembled dist/');
