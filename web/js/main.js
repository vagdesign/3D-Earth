import * as THREE from 'three';
import { DEFAULTS, mergeSettings, settingsFromQuery } from './settings.js';
import { computeEphemeris, latLonToVec } from './astro.js';
import { createEarth } from './earth.js';
import { createSky } from './sky.js';
import { createMoon } from './moon.js';
import { frameCamera } from './framing.js';
import { Labels, hiddenByEarth } from './labels.js';
import { POST_FRAG } from './shaders.js';
import { setMaxAnisotropy, fetchJson } from './textures.js';

const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
const query = new URLSearchParams(location.search);
const DATA = 'data/';
const debug = query.has('debug');

let settings = mergeSettings(DEFAULTS, settingsFromQuery(location.search));
let paused = false;

// ---- time (real time by default; ?t=ISO and ?timeSpeed=N for previews) ----
const wallStart = Date.now();
const simStart = query.has('t') ? new Date(query.get('t')).getTime() : wallStart;
const simNow = () => new Date(simStart + (Date.now() - wallStart) * settings.timeSpeed);

// ---- renderer ----
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: query.has('capture') });
renderer.autoClear = true;
renderer.setClearColor(0x000000, 1);
setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 4000);

const shared = {
  uSunDir: { value: new THREE.Vector3(1, 0, 0) },
  uSun: { value: 2.1 },
  uCamPos: { value: new THREE.Vector3() },
};

const earth = createEarth(shared);
scene.add(earth.group);
const moon = createMoon(shared);
scene.add(moon.mesh);
const sky = await createSky(scene);
const labels = new Labels(document.getElementById('labels'));

// HDR target + tone-mapping pass.
let rt = null;
const post = new THREE.Mesh(
  new THREE.PlaneGeometry(2, 2),
  new THREE.ShaderMaterial({
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: POST_FRAG,
    uniforms: { tScene: { value: null }, uExposure: { value: 1 } },
    depthTest: false, depthWrite: false,
  }),
);
const postScene = new THREE.Scene();
postScene.add(post);
const postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

let width = 0, height = 0, pixelRatio = 1;
function resize() {
  const q = { low: 0.75, medium: 1, high: 1 }[settings.quality] ?? 1;
  pixelRatio = (window.devicePixelRatio || 1) * THREE.MathUtils.clamp(settings.renderScale, 0.4, 2) * q;
  width = window.innerWidth; height = window.innerHeight;
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(width, height, false);
  const samples = settings.quality === 'low' ? 0 : 4;
  const w = Math.max(1, Math.round(width * pixelRatio)), h = Math.max(1, Math.round(height * pixelRatio));
  if (!rt || rt.width !== w || rt.height !== h || rt.samples !== samples) {
    if (rt) rt.dispose();
    rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples, depthBuffer: true });
    post.material.uniforms.tScene.value = rt.texture;
  }
}
window.addEventListener('resize', () => { resize(); render(); });
resize();

// ---- data (clouds, storms, higher-resolution textures from the host) ----
let manifest = null;
let storms = [];

async function refreshData(first = false) {
  const m = await fetchJson(`${DATA}manifest.json`);
  const cloudsVer = m && m.clouds ? m.clouds : null;
  if (first || !manifest || (cloudsVer && cloudsVer !== manifest.clouds)) {
    const urls = [];
    if (m && m.cloudsFile) urls.push(`${DATA}${m.cloudsFile}?v=${encodeURIComponent(cloudsVer || Date.now())}`);
    if (first) urls.push('assets/clouds_fallback.jpg');
    if (urls.length) await earth.setClouds(urls);
  }
  if (first || !manifest || (m && m.textures !== manifest.textures)) {
    await earth.loadBaseTextures(DATA);
    await moon.loadTexture(DATA);
  }
  const st = await fetchJson(`${DATA}storms.json`);
  storms = Array.isArray(st) ? st : (st && Array.isArray(st.storms) ? st.storms : []);
  manifest = m || {};
  render();
}

// ---- host messages ----
function onMessage(msg) {
  if (!msg || typeof msg !== 'object') return;
  switch (msg.type) {
    case 'settings':
      settings = mergeSettings(DEFAULTS, msg.settings);
      resize();
      render();
      break;
    case 'data':
      refreshData();
      break;
    case 'pause':
      setPaused(!!msg.paused);
      break;
  }
}
if (host) host.addEventListener('message', (e) => onMessage(e.data));
window.__earth = { onMessage, settings: () => settings };

// ---- frame ----
let eph = computeEphemeris(simNow());
const stormPos = new THREE.Vector3();

function stormLabel(s) {
  const kind = s.kind || 'Storm';
  const cat = s.category ? ` · ${s.category}` : '';
  const wind = s.windKt ? ` · ${Math.round(s.windKt)} kt` : '';
  const color = s.windKt >= 96 ? '#ff8a6a' : s.windKt >= 64 ? '#ffc46a' : '#bfe3ff';
  return `<i style="color:${color}"></i><span>${escapeHtml(kind)} ${escapeHtml(s.name || '')}<small>${escapeHtml(cat + wind)}</small></span>`;
}
function escapeHtml(t) { return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

function render() {
  if (!rt) return;
  const now = performance.now();
  eph = computeEphemeris(simNow());
  earth.group.rotation.y = eph.earthRotation;
  frameCamera(camera, settings, eph, width, height);

  shared.uSunDir.value.copy(eph.sunDir);
  shared.uCamPos.value.copy(camera.position);
  earth.update(now, settings);
  moon.update(eph, settings);
  sky.update(camera, eph, settings, pixelRatio);
  post.material.uniforms.uExposure.value = settings.exposure;

  renderer.setRenderTarget(rt);
  renderer.render(scene, camera);
  renderer.setRenderTarget(null);
  renderer.render(postScene, postCam);

  // Labels
  labels.begin();
  if (settings.labels) {
    const moonHidden = hiddenByEarth(camera.position, eph.moonPos);
    labels.place('moon', 'body', 'Moon', eph.moonPos, camera, width, height, 0, 14, !moonHidden);
    for (const p of eph.planets) {
      const w = p.dir.clone().multiplyScalar(900).add(camera.position);
      const blocked = hiddenByEarth(camera.position, p.dir.clone().multiplyScalar(5000));
      labels.place(p.name, 'body', p.name, w, camera, width, height, 8, 4, !blocked);
    }
  }
  if (settings.storms) {
    storms.forEach((s, i) => {
      latLonToVec(s.lat, s.lon, stormPos).applyAxisAngle(THREE.Object3D.DEFAULT_UP, eph.earthRotation);
      const facing = stormPos.dot(camera.position.clone().sub(stormPos).normalize()) > 0.2;
      stormPos.multiplyScalar(1.01);
      labels.place(`storm${i}`, 'storm', stormLabel(s), stormPos, camera, width, height, -6, -8, facing);
    });
  }
  labels.end();

  if (debug) showDebug(now);
}

let lastFrame = 0, frames = 0, fpsShown = 0, fpsT = 0;
function loop(now) {
  if (paused) return;
  requestAnimationFrame(loop);
  const interval = 1000 / THREE.MathUtils.clamp(settings.fps, 1, 144);
  if (now - lastFrame < interval - 2) return;
  lastFrame = now;
  render();
  frames++;
}
function setPaused(p) {
  if (p === paused) return;
  paused = p;
  if (!paused) requestAnimationFrame(loop);
}

let dbg = null;
function showDebug(now) {
  if (!dbg) { dbg = document.createElement('div'); dbg.id = 'debug'; document.body.appendChild(dbg); }
  if (now - fpsT > 1000) { fpsShown = frames; frames = 0; fpsT = now; }
  dbg.textContent = `${simNow().toISOString()}  ${fpsShown} fps  view=${settings.view}  ${width}x${height}@${pixelRatio.toFixed(2)}`;
}

await refreshData(true);
// Without a host, poll for new data now and then (useful when served from a folder).
if (!host) setInterval(() => refreshData(), 10 * 60 * 1000);
requestAnimationFrame(loop);
if (host) host.postMessage({ type: 'ready' });
document.documentElement.dataset.ready = '1';
