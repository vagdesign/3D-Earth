// Builds the global cloud map published on the 3D Earth data site (GitHub Pages).
//
// Method adapted from Matt Eason's live-cloud-maps (CC0 1.0,
// https://github.com/matteason/live-cloud-maps): EUMETSAT's public WMS layers
// (IR 10.8 µm world cloud map, Dust RGB, Natural colour RGB) are combined into a
// greyscale cloud map. Contains modified EUMETSAT data.
//
//   node generate.mjs <outDir> [--prev-hash <irHash>] [--input-dir <dir>]
//
// Writes <outDir>/clouds/{8192x4096,4096x2048,2048x1024}/clouds.jpg and
// <outDir>/clouds/status.json. Exit codes: 0 = new map written, 3 = EUMETSAT
// still serves the same IR image as the previous run (nothing written),
// 1 = failure (nothing written). --input-dir reads <type>.png files instead of
// downloading (testing).
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

sharp.cache(false);
sharp.concurrency(2);

const W = 8192, H = 4096, HALF = H;   // each WMS half is H x H
const WMS = 'https://view.eumetsat.int/geoserver/ows?service=WMS&request=GetMap&version=1.3.0&styles=&format=image/png&crs=EPSG:4326';
const LAYERS = { IR: 'mumi:worldcloudmap_ir108', DUST: 'mumi:wideareacoverage_rgb_dust', VIS: 'mumi:wideareacoverage_rgb_natural' };
const BBOX = { LEFT: '-90,-180,90,0', RIGHT: '-90,0,90,180' };

const args = process.argv.slice(2);
const outDir = args[0];
const opt = (name) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : null; };
const prevHash = opt('--prev-hash');
const inputDir = opt('--input-dir');
if (!outDir) { console.error('usage: node generate.mjs <outDir> [--prev-hash h] [--input-dir d]'); process.exit(1); }

async function fetchPng(type, url) {
  if (inputDir) return readFile(path.join(inputDir, `${type}.png`));
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(120_000), headers: { 'User-Agent': '3DEarth-cloudservice (+https://github.com/vagdesign/3D-Earth)' } });
      const type_ = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!type_.startsWith('image/png')) throw new Error(`unexpected ${type_}: ${buf.subarray(0, 200).toString()}`);
      return buf;
    } catch (e) {
      last = e;
      console.warn(`${type} attempt ${attempt}: ${e.message}`);
      await new Promise((r) => setTimeout(r, attempt * 15_000));
    }
  }
  throw new Error(`${type}: ${last?.message}`);
}

// Decodes a WMS half into raw RGB, checking size and that it is not blank.
async function rgb(type, buf) {
  const { data, info } = await sharp(buf, { limitInputPixels: false }).removeAlpha().toColourspace('srgb').raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== HALF || info.height !== HALF || info.channels !== 3) throw new Error(`${type}: got ${info.width}x${info.height}x${info.channels}`);
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 997) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 10) throw new Error(`${type}: blank image`);
  return data;
}

// Joins two halves the wrong way round (right half on the left), as the original
// does, so the antimeridian gap lands in the middle where it is easy to fill.
function joinSwapped(left, right, channels) {
  const out = Buffer.alloc(W * H * channels);
  const rowHalf = HALF * channels;
  for (let y = 0; y < H; y++) {
    right.copy(out, y * W * channels, y * rowHalf, (y + 1) * rowHalf);
    left.copy(out, y * W * channels + rowHalf, y * rowHalf, (y + 1) * rowHalf);
  }
  return out;
}

const lerp = (fromA, toA, fromB, toB, v) => v < fromA ? fromB : v > toA ? toB : fromB + (toB - fromB) * (v - fromA) / (toA - fromA);
const screen = (a, b) => (1 - (1 - a / 255) * (1 - b / 255)) * 255;
const gamma = (g, v) => 255 * Math.pow(v / 255, 1 / g);

async function main() {
  const urls = [];
  for (const [k, layer] of Object.entries(LAYERS))
    for (const [s, bbox] of Object.entries(BBOX))
      urls.push([`${k}_${s}`, `${WMS}&layers=${layer}&bbox=${bbox}&width=${HALF}&height=${HALF}`]);
  const raw = {};
  for (const [type, url] of urls) raw[type] = await fetchPng(type, url);

  // Unchanged IR imagery means EUMETSAT has not published anything new.
  const irHash = createHash('sha256').update(raw.IR_LEFT).update(raw.IR_RIGHT).digest('hex').slice(0, 16);
  if (prevHash && prevHash === irHash) { console.log(`IR imagery unchanged (${irHash}); keeping the previous map`); process.exit(3); }

  const px = {};
  for (const type of Object.keys(raw)) px[type] = await rgb(type, raw[type]);
  const ir = joinSwapped(px.IR_LEFT, px.IR_RIGHT, 3);
  const dust = joinSwapped(px.DUST_LEFT, px.DUST_RIGHT, 3);
  const vis = joinSwapped(px.VIS_LEFT, px.VIS_RIGHT, 3);
  for (const k of Object.keys(px)) delete px[k];

  const out = Buffer.alloc(W * H);
  const fadeStart = W * 0.4, fadeEnd = W * 0.6, GAP = 3;
  for (let y = 0; y < H; y++) {
    let gapStartX = null, gapStartVal = 0, after = 0;
    const fillGaps = y > H / 8 && y < H - H / 8;     // the poles are mirrored later
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 3;
      const dustB = 255 - dust[i + 2];
      const dustV = screen((dust[i] / 255) * (dustB / 255) * 255, 0.5 * dustB);
      const irV = gamma(1.46, lerp(72, 178, 0, 255, ir[i]));
      let v = gamma(2.0, screen(dustV, irV * 0.77));
      const r = vis[i], g = vis[i + 1], b = vis[i + 2];
      const diff = Math.max(r, g, b) - Math.min(r, g, b);
      if (diff < 25 || (r < g && Math.abs(g - b) < 11 && g > 150)) {
        // Grey/white in the visible image: small clouds the IR misses (daylight only).
        const visV = gamma(1.5, Math.max(r, g, b));
        const am = x > fadeStart && x < fadeEnd && visV < 255 ? Math.abs(lerp(fadeStart, fadeEnd, -1, 1, x)) : 1;
        v = Math.max(visV * am, v);
      }
      v = Math.max(0, Math.min(255, Math.round(v)));
      out[p] = v;

      // Fill the no-data gap at the antimeridian with a gradient.
      if (!fillGaps) continue;
      if (v === 255 && gapStartX === null) {
        gapStartX = Math.max(0, x - GAP);
        gapStartVal = out[y * W + gapStartX];
      } else if (gapStartX !== null && v < 255 && after < GAP) {
        after++;
      } else if (gapStartX !== null && v < 255 && after === GAP) {
        const step = (v - gapStartVal) / (x - gapStartX);
        for (let gx = gapStartX; gx <= x; gx++) out[y * W + gx] = Math.max(0, Math.min(255, Math.round(gapStartVal + (gx - gapStartX) * step)));
        gapStartX = null; after = 0;
      }
    }
  }

  // Swap the halves back so the map is centred on the prime meridian.
  const map = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    out.copy(map, y * W, y * W + W / 2, (y + 1) * W);
    out.copy(map, y * W + W / 2, y * W, y * W + W / 2);
  }
  // No data at the poles: mirror the rows next to them.
  const m = H / 8;
  for (let y = 0; y < m; y++) {
    map.copy(map, y * W, (2 * m - 1 - y) * W, (2 * m - y) * W);
    map.copy(map, (H - 1 - y) * W, (H - 2 * m + y) * W, (H - 2 * m + y + 1) * W);
  }

  const dir = path.join(outDir, 'clouds');
  for (const [w, h] of [[8192, 4096], [4096, 2048], [2048, 1024]]) {
    const sub = path.join(dir, `${w}x${h}`);
    await mkdir(sub, { recursive: true });
    await sharp(map, { raw: { width: W, height: H, channels: 1 }, limitInputPixels: false })
      .resize(w, h, { kernel: 'lanczos3' }).toColourspace('b-w').jpeg({ quality: 82, mozjpeg: true }).toFile(path.join(sub, 'clouds.jpg'));
  }
  const status = { time: new Date().toISOString(), irHash, source: 'EUMETSAT WMS (IR 10.8, Dust RGB, Natural colour RGB)', attribution: 'Contains modified EUMETSAT data' };
  await writeFile(path.join(dir, 'status.json'), JSON.stringify(status, null, 2));
  console.log(`Cloud map written (${irHash})`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
