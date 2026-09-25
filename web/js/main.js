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
import { createControls } from './controls.js';

const host = window.chrome && window.chrome.webview ? window.chrome.webview : null;
const hostLog = (message) => { try { host && host.postMessage({ type: 'log', message: String(message) }); } catch { /* ignore */ } };
window.addEventListener('error', (e) => hostLog(`error: ${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => hostLog(`unhandled: ${e.reason && (e.reason.stack || e.reason.message) || e.reason}`));
const query = new URLSearchParams(location.search);
const DATA = 'data/';
const debug = query.has('debug');
const interactive = query.has('interactive');

let settings = mergeSettings(DEFAULTS, settingsFromQuery(location.search));
let paused = false;

// ---- time: live, a custom date/time, or time-lapse (?t=ISO&timeSpeed=N for previews) ----
let timeBase = { wall: Date.now(), sim: initialSimTime() };
function initialSimTime() {
  if (query.has('t')) return new Date(query.get('t')).getTime();
  const c = settings.customTime ? Date.parse(settings.customTime) : NaN;
  return Number.isFinite(c) ? c : Date.now();
}
const timeSpeed = () => (settings.motion === 'timelapse' || query.has('timeSpeed') ? settings.timeSpeed : 1);
const simNow = () => new Date(timeBase.sim + (Date.now() - timeBase.wall) * timeSpeed());
function rebaseTime(prev) {
  const customChanged = prev.customTime !== settings.customTime;
  const backToLive = prev.motion === 'timelapse' && settings.motion !== 'timelapse';
  const sim = customChanged || backToLive ? initialSimTime() : simNow().getTime();
  timeBase = { wall: Date.now(), sim };
}

// 'spin' motion: orbit the Earth once per spinSeconds, starting above my location.
const spinStart = performance.now();
const spinQ = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);

// ---- renderer ----
const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: query.has('capture') });
renderer.autoClear = true;
renderer.setClearColor(0x000000, 1);
setMaxAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
{
  const gl = renderer.getContext();
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  hostLog(`WebGL ${renderer.capabilities.isWebGL2 ? '2' : '1'}; GPU: ${dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown'}; ` +
          `max texture ${renderer.capabilities.maxTextureSize}; ${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio}`);
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); hostLog('WebGL context lost'); });
  canvas.addEventListener('webglcontextrestored', () => { hostLog('WebGL context restored; reloading'); location.reload(); });
}

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.01, 4000);

const shared = {
  uSunDir: { value: new THREE.Vector3(1, 0, 0) },
  uSun: { value: 2.1 },
  uCamPos: { value: new THREE.Vector3() },
  uHaze: { value: 1 },
};

const earth = createEarth(shared);
scene.add(earth.group);
const moon = createMoon(shared);
scene.add(moon.mesh);
const sky = await createSky(scene);
const labels = new Labels(document.getElementById('labels'));

// Interactive controls (Preview / Explore windows and plain browsers).
const controls = interactive || !host
  ? createControls(canvas, { onClose: () => host && host.postMessage({ type: 'close' }) })
  : null;
let helpTimer = 0;
function showHelp(ms = 15000) {
  const help = document.getElementById('help');
  if (!help) return;
  help.hidden = false;
  help.classList.remove('fade');
  clearTimeout(helpTimer);
  helpTimer = setTimeout(() => help.classList.add('fade'), ms);
}
if (controls) {
  window.addEventListener('keydown', (e) => {
    if (e.key === 'h' || e.key === 'H' || e.key === '?' || e.key === 'F1') {
      e.preventDefault();
      const help = document.getElementById('help');
      if (help.hidden || help.classList.contains('fade')) showHelp(60000); else help.classList.add('fade');
    }
  });
}

// Credits (bottom-right, kept clear of the taskbar).
function applyCredits() {
  document.getElementById('credits').hidden = !settings.credits;
}
function setInsets(i) {
  const dpr = window.devicePixelRatio || 1;
  const root = document.documentElement.style;
  root.setProperty('--inset-r', `${(i.right || 0) / dpr}px`);
  root.setProperty('--inset-b', `${(i.bottom || 0) / dpr}px`);
}

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
    case 'settings': {
      const prev = settings;
      settings = mergeSettings(DEFAULTS, msg.settings);
      rebaseTime(prev);
      applyCredits();
      resize();
      render();
      break;
    }
    case 'insets':
      setInsets(msg);
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
window.__earth = { onMessage, settings: () => settings, camera, controls: () => controls };

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

let lastRender = performance.now();
function render() {
  if (!rt) return;
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastRender) / 1000);
  lastRender = now;
  eph = computeEphemeris(simNow());
  earth.group.rotation.y = eph.earthRotation;
  let view = controls ? controls.update(dt, camera, height) : null;
  let frameSettings = settings;
  if (settings.motion === 'spin') {
    // Start above my location and orbit westward once per spinSeconds, so the
    // Earth appears to turn eastward beneath the camera.
    const t = (now - spinStart) / 1000 / Math.max(5, settings.spinSeconds);
    spinQ.setFromAxisAngle(Y_AXIS, -t * Math.PI * 2);
    frameSettings = { ...settings, view: 'home' };
    view = view
      ? { ...view, rotation: view.rotation.clone().multiply(spinQ) }
      : { zoom: 1, panX: 0, panY: 0, rotation: spinQ };
  }
  frameCamera(camera, frameSettings, eph, width, height, view);
  shared.uHaze.value = settings.haze;

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
  const interval = 1000 / THREE.MathUtils.clamp(controls && !query.has('fps') ? Math.max(settings.fps, 60) : settings.fps, 1, 144);
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

applyCredits();
await refreshData(true);
if (controls) showHelp();
// Without a host, poll for new data now and then (useful when served from a folder).
if (!host) setInterval(() => refreshData(), 10 * 60 * 1000);
requestAnimationFrame(loop);
if (host) host.postMessage({ type: 'ready' });
document.documentElement.dataset.ready = '1';
