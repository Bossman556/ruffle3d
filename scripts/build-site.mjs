// Static site generator for the Ruffle3D website (no dependencies).
//   site/site.json      company details and contact addresses
//   site/layout.html    shared page shell (header, footer)
//   site/pages/**.html  page bodies; the first line is a JSON comment: <!-- {"title": "...", "description": "..."} -->
//   site/assets/**      css, js, fonts, images (copied as-is)
// Output: website/ (the deployable folder). website/app and website/downloads come from `npm run package`.
// Usage: npm run site:build
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, cpSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'site');
const out = path.join(root, 'website');
const cfg = JSON.parse(readFileSync(path.join(src, 'site.json'), 'utf8'));
const layout = readFileSync(path.join(src, 'layout.html'), 'utf8');

// release details from the last `npm run package`
let release = { version: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version, file: '', bytes: 0, sha256: '', date: '' };
const relFile = path.join(out, 'downloads', 'latest.json');
if (existsSync(relFile)) release = { ...release, ...JSON.parse(readFileSync(relFile, 'utf8')) };
else console.warn('! website/downloads/latest.json not found: run `npm run package` first so download links work');

const missing = new Set();
const ctx = {
  ...cfg,
  year: String(new Date().getFullYear()),
  release: {
    ...release, sizeMB: (release.bytes / 1e6).toFixed(1), href: release.file ? `downloads/${release.file}` : 'download.html',
    // per-platform packages (older latest.json files only have the combined one)
    ...Object.fromEntries(['windows', 'mac', 'linux'].map((os) => {
      const r = release.platforms?.[os] || release;
      return [os, { file: r.file, sha256: r.sha256, sizeMB: (r.bytes / 1e6).toFixed(1), href: r.file ? `downloads/${r.file}` : 'download.html' }];
    })),
  },
};
const get = (obj, key) => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const fill = (html, extra = {}) => html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
  const v = get(extra, key) ?? get(ctx, key);
  if (key.startsWith('page.')) return v ?? '';
  if (v === undefined || v === '') { missing.add(key); return `<span class="todo">[${key}]</span>`; }
  return String(v);
});

// clean generated pages but keep the app build and downloads
for (const n of existsSync(out) ? readdirSync(out) : []) if (!['app', 'downloads'].includes(n)) rmSync(path.join(out, n), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(path.join(src, 'assets'), path.join(out, 'assets'), { recursive: true });

const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : p.endsWith('.html') ? [p] : []; });
const pagesDir = path.join(src, 'pages');
const pages = walk(pagesDir);
for (const file of pages) {
  const rel = path.relative(pagesDir, file).split(path.sep).join('/');
  const raw = readFileSync(file, 'utf8');
  const m = raw.match(/^<!--\s*(\{[\s\S]*?\})\s*-->\s*/);
  const meta = m ? JSON.parse(m[1]) : {};
  const body = m ? raw.slice(m[0].length) : raw;
  const depth = rel.split('/').length - 1;
  const base = depth ? '../'.repeat(depth) : '';
  const section = meta.section || rel.split('/')[0].replace('.html', '');
  const page = { base, title: meta.title || cfg.name, description: meta.description || cfg.tagline, section, canonical: `${cfg.url}/${rel === 'index.html' ? '' : rel}`, bodyClass: meta.bodyClass || '' };
  let html = layout.replace('{{content}}', body);
  html = fill(html, { page });
  // mark the current section in the navigation
  html = html.replace(new RegExp(`data-nav="${section}"`, 'g'), `data-nav="${section}" aria-current="page"`);
  const dest = path.join(out, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, html);
}
writeFileSync(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${cfg.url}/sitemap.xml\n`);
writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
  .map((f) => path.relative(pagesDir, f).split(path.sep).join('/')).filter((r) => r !== '404.html')
  .map((r) => `  <url><loc>${cfg.url}/${r === 'index.html' ? '' : r}</loc></url>`).join('\n')}\n</urlset>\n`);
console.log(`Built ${pages.length} pages into website/`);
if (missing.size) console.warn(`! Fill these in site/site.json (shown as [placeholders] on the site): ${[...missing].join(', ')}`);
