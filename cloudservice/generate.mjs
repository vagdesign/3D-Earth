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
const WMS = process.env.WMS_BASE || 'https://view.eumetsat.int/geoserver/ows?service=WMS&request=GetMap&version=1.3.0&styles=&format=image/png&crs=EPSG:4326';
const LAYERS = { IR: 'mumi:worldcloudmap_ir108', DUST: 'mumi:wideareacoverage_rgb_dust', VIS: 'mumi:wideareacoverage_rgb_natural' };
const BBOX = { LEFT: '-90,-180,90,0', RIGHT: '-90,0,90,180' };

const args = process.argv.slice(2);
const outDir = args[0];
const opt = (name) => { const i = args.indexOf(name); return i > 0 ? args[i + 1] : null; };
const prevHash = opt('--prev-hash');
const inputDir = opt('--input-dir');
if (!outDir) { console.error('usage: node generate.mjs <outDir> [--prev-hash h] [--input-dir d]'); process.exit(1); }

const TILES = 4, TILE = HALF / TILES;   // EUMETSAT times out on 4096 px requests: ask for 1024 px tiles
const POOL = 6;

async function fetchPng(type, url) {
  let last;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const t0 = Date.now();
      const res = await fetch(url, { signal: AbortSignal.timeout(90_000), headers: { 'User-Agent': '3DEarth-cloudservice (+https://github.com/vagdesign/3D-Earth)' } });
      const type_ = res.headers.get('content-type') || '';
      const buf = Buffer.from(await res.arrayBuffer());
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!type_.startsWith('image/png')) throw new Error(`unexpected ${type_}: ${buf.subarray(0, 200).toString()}`);
      if (attempt > 1 || Date.now() - t0 > 30_000) console.log(`${type}: ${Math.round((Date.now() - t0) / 1000)} s (attempt ${attempt})`);
      return buf;
    } catch (e) {
      last = e;
      console.warn(`${type} attempt ${attempt}: ${e.message}`);
      await new Promise((r) => setTimeout(r, attempt * 10_000));
    }
  }
  throw new Error(`${type}: ${last?.message}`);
}

async function decodeRgb(buf, w, h, what) {
  const { data, info } = await sharp(buf, { limitInputPixels: false }).removeAlpha().toColourspace('srgb').raw()
    .toBuffer({ resolveWithObject: true });
  if (info.width !== w || info.height !== h || info.channels !== 3) throw new Error(`${what}: got ${info.width}x${info.height}x${info.channels}`);
  return data;
}

// One hemisphere of one layer as raw RGB (HALF x HALF), fetched as TILES x TILES
// small WMS requests. Returns { data, hash } or throws.
async function loadHalf(layer, side) {
  const type = `${layer}_${side}`;
  const hash = createHash('sha256');
  let data;
  if (inputDir) {
    const buf = await readFile(path.join(inputDir, `${type}.png`));
    hash.update(buf);
    data = await decodeRgb(buf, HALF, HALF, type);
  } else {
    data = Buffer.alloc(HALF * HALF * 3);
    const lon0 = side === 'LEFT' ? -180 : 0, step = 180 / TILES;
    const jobs = [];
    for (let r = 0; r < TILES; r++) for (let c = 0; c < TILES; c++) jobs.push([r, c]);
    const bufs = new Array(jobs.length);
    let next = 0;
    await Promise.all(Array.from({ length: POOL }, async () => {
      while (next < jobs.length) {
        const j = next++, [r, c] = jobs[j];
        const latMax = 90 - r * step, latMin = latMax - step, lonMin = lon0 + c * step, lonMax = lonMin + step;
        const url = `${WMS}&layers=${LAYERS[layer]}&bbox=${latMin},${lonMin},${latMax},${lonMax}&width=${TILE}&height=${TILE}`;
        bufs[j] = await fetchPng(`${type}[${r},${c}]`, url);
      }
    }));
    for (let j = 0; j < jobs.length; j++) {
      const [r, c] = jobs[j];
      hash.update(bufs[j]);
      const tile = await decodeRgb(bufs[j], TILE, TILE, `${type}[${r},${c}]`);
      for (let y = 0; y < TILE; y++)
        tile.copy(data, ((r * TILE + y) * HALF + c * TILE) * 3, y * TILE * 3, (y + 1) * TILE * 3);
    }
  }
  let min = 255, max = 0;
  for (let i = 0; i < data.length; i += 997) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 10) throw new Error(`${type}: blank image`);
  return { data, hash: hash.digest('hex') };
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
  // IR is required; the dust and visible layers only add detail, so the map is
  // still made (IR only) when EUMETSAT cannot deliver them.
  const t0 = Date.now();
  const irL = await loadHalf('IR', 'LEFT'), irR = await loadHalf('IR', 'RIGHT');
  const irHash = createHash('sha256').update(irL.hash).update(irR.hash).digest('hex').slice(0, 16);
  console.log(`IR loaded in ${Math.round((Date.now() - t0) / 1000)} s (${irHash})`);
  // Unchanged IR imagery means EUMETSAT has not published anything new.
  if (prevHash && prevHash === irHash) { console.log('IR imagery unchanged; keeping the previous map'); process.exit(3); }
  const ir = joinSwapped(irL.data, irR.data, 3);
  const optional = async (layer) => {
    try { return joinSwapped((await loadHalf(layer, 'LEFT')).data, (await loadHalf(layer, 'RIGHT')).data, 3); }
    catch (e) { console.warn(`::warning::${layer} layer unavailable (${e.message}); continuing without it`); return null; }
  };
  const dust = await optional('DUST');
  const vis = await optional('VIS');

  const out = Buffer.alloc(W * H);
  const fadeStart = W * 0.4, fadeEnd = W * 0.6, GAP = 3;
  for (let y = 0; y < H; y++) {
    let gapStartX = null, gapStartVal = 0, after = 0;
    const fillGaps = y > H / 8 && y < H - H / 8;     // the poles are mirrored later
    for (let x = 0; x < W; x++) {
      const p = y * W + x, i = p * 3;
      let dustV = 0;
      if (dust) {
        const dustB = 255 - dust[i + 2];
        dustV = screen((dust[i] / 255) * (dustB / 255) * 255, 0.5 * dustB);
      }
      const irV = gamma(1.46, lerp(72, 178, 0, 255, ir[i]));
      let v = gamma(2.0, screen(dustV, irV * 0.77));
      const r = vis ? vis[i] : 0, g = vis ? vis[i + 1] : 128, b = vis ? vis[i + 2] : 255;
      const diff = Math.max(r, g, b) - Math.min(r, g, b);
      if (vis && (diff < 25 || (r < g && Math.abs(g - b) < 11 && g > 150))) {
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
  const layers = ['IR 10.8', dust && 'Dust RGB', vis && 'Natural colour RGB'].filter(Boolean).join(', ');
  const status = { time: new Date().toISOString(), irHash, source: `EUMETSAT WMS (${layers})`, attribution: 'Contains modified EUMETSAT data' };
  await writeFile(path.join(dir, 'status.json'), JSON.stringify(status, null, 2));
  console.log(`Cloud map written (${irHash})`);
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
