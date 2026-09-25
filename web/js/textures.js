import * as THREE from 'three';

const loader = new THREE.TextureLoader();
let maxAniso = 1;
export function setMaxAnisotropy(n) { maxAniso = n; }

function prepare(tex, { srgb = false, wrap = true } = {}) {
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  if (wrap) tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = maxAniso;
  tex.needsUpdate = true;
  return tex;
}

// Load the first URL that works; resolves null if none do.
export function loadFirst(urls, opts) {
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (i >= urls.length) return resolve(null);
      const url = urls[i++];
      loader.load(url, (t) => { t.userData.url = url; resolve(prepare(t, opts)); }, undefined, next);
    };
    next();
  });
}

export function solidTexture(r, g, b) {
  const t = new THREE.DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.needsUpdate = true;
  return t;
}

export async function fetchJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}
