// Tiny static file server (no dependencies). Usage: node serve.mjs <folder> [port]
// Dev only: --allow-upload accepts POST /__upload?name=file.png and writes into <folder>/img (used to save renders).
import http from 'node:http';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const root = path.resolve(args[0] || '.');
const port = +(args[1] || 47830);
const upload = process.argv.includes('--allow-upload');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2', '.zip': 'application/zip', '.txt': 'text/plain; charset=utf-8' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (upload && req.method === 'POST' && url.pathname === '/__upload') {
      const name = path.basename(url.searchParams.get('name') || '');
      if (!/^[\w.-]+\.(png|jpg|webp)$/.test(name)) { res.writeHead(400); return res.end('bad name'); }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      await mkdir(path.join(root, 'img'), { recursive: true });
      await writeFile(path.join(root, 'img', name), Buffer.concat(chunks));
      res.writeHead(200); return res.end('ok');
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.resolve(root, '.' + rel);
    if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
    if ((await stat(file).catch(() => null))?.isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Serving ${root} at http://localhost:${port}/`));
