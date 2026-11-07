'use strict';
/**
 * Builds dist/rankscope/ - a folder you upload as-is to Hostinger (File Manager or FTP),
 * e.g. into public_html/rankscope/ or the root of a subdomain.
 *   npm run bundle
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'public');
const OUT = path.join(ROOT, 'dist', 'rankscope');
const SKIP = new Set([path.join(SRC, 'api', 'config.php'), path.join(SRC, 'api', 'cache')]);

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const a = path.join(from, name), b = path.join(to, name);
    if (SKIP.has(a)) continue;
    if (fs.statSync(a).isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}

fs.rmSync(OUT, { recursive: true, force: true });
copyDir(SRC, OUT);
fs.writeFileSync(path.join(OUT, '.htaccess'), [
  '# RankScope',
  'Options -Indexes',
  'DirectoryIndex index.html',
  '<IfModule mod_headers.c>',
  '  Header set X-Content-Type-Options "nosniff"',
  '  Header set Referrer-Policy "strict-origin-when-cross-origin"',
  '  <FilesMatch "\\.(js|css|svg)$">',
  '    Header set Cache-Control "public, max-age=3600"',
  '  </FilesMatch>',
  '</IfModule>',
  '',
].join('\n'));
console.log('Bundle ready: ' + path.relative(ROOT, OUT));
console.log('Next: copy api/config.sample.php to api/config.php on the server and add any API keys.');

