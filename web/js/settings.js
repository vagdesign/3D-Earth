// Default wallpaper settings. The Windows host sends its saved settings on
// startup; when the page is opened in a normal browser the URL query string
// can override any of these (e.g. ?view=home&homeLon=23.7).
export const DEFAULTS = {
  view: 'moon',          // 'moon' | 'home' | 'sunrise'
  homeLat: 38.0,
  homeLon: 23.7,
  earthFill: 0.96,       // Earth diameter as a fraction of the screen height
  earthPosition: 0.0,    // -1 = left edge, 0 = centred, 1 = right edge
  fov: 40,               // vertical field of view in degrees
  sunsideBias: 30,       // 'moon' view: 0 = fully lit Earth, 90 = half lit
  moonScale: 1,          // 1 = true size
  clouds: true,
  cloudOpacity: 1,
  storms: true,
  labels: true,
  credits: true,
  stars: 0.6,
  milkyWay: 0.5,
  exposure: 1.0,
  quality: 'medium',     // 'low' | 'medium' | 'high'
  fps: 30,
  renderScale: 1,
  timeSpeed: 1,
};

const NUMERIC = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'number');
const BOOL = Object.keys(DEFAULTS).filter((k) => typeof DEFAULTS[k] === 'boolean');

export function mergeSettings(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (!(k in DEFAULTS) || v === null || v === undefined) continue;
    if (NUMERIC.includes(k)) { const n = Number(v); if (Number.isFinite(n)) out[k] = n; }
    else if (BOOL.includes(k)) out[k] = v === true || v === 'true' || v === '1' || v === 1;
    else out[k] = String(v);
  }
  return out;
}

export function settingsFromQuery(search) {
  const p = new URLSearchParams(search);
  const o = {};
  for (const k of Object.keys(DEFAULTS)) if (p.has(k)) o[k] = p.get(k);
  return o;
}
