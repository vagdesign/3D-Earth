// Renders the wallpaper page headlessly and saves PNG screenshots.
// Usage: node tools/screenshot.mjs [outDir] [query ...]
// Needs Playwright + Chromium. Serves ./web on a local port.
import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'web');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0);
const port = server.address().port;

const outDir = process.argv[2] || 'out';
const queries = process.argv.slice(3);
if (!queries.length) queries.push('view=moon', 'view=home', 'view=sunrise');
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => console.log('[page]', m.text()));
let failed = false;
page.on('pageerror', (e) => { failed = true; console.log('[error]', e.message); });
for (const [i, q] of queries.entries()) {
  const [qs, size] = q.split('@');
  if (size) { const [w, h] = size.split('x').map(Number); await page.setViewportSize({ width: w, height: h }); }
  await page.goto(`http://localhost:${port}/index.html?capture&fps=2&${qs}`);
  await page.waitForFunction(() => document.documentElement.dataset.ready === '1', null, { timeout: 120000 });
  await page.waitForTimeout(2500);
  const file = path.join(outDir, `${String(i).padStart(2, '0')}-${qs.replace(/[^a-z0-9=.-]+/gi, '_')}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}
await browser.close();
server.close();
if (failed) { console.error('page errors occurred'); process.exit(1); }
