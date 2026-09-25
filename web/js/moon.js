import * as THREE from 'three';
import { SPHERE_VERT } from './shaders.js';
import { loadFirst } from './textures.js';

const MOON_RADIUS = 1737.4 / 6371.0;   // in Earth radii

// Rough procedural Moon used until/unless a real lunar map is available.
// Maria are placed at their true selenographic positions.
function proceduralMoon() {
  const w = 1024, h = 512;
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#9a9690'; g.fillRect(0, 0, w, h);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const xy = (lon, lat) => [((lon + 180) / 360) * w, ((90 - lat) / 180) * h];
  const blob = (lon, lat, r, color, alpha) => {
    const [x, y] = xy(lon, lat);
    const rx = (r / 360) * w / Math.max(Math.cos(lat * Math.PI / 180), 0.3), ry = (r / 180) * h;
    for (let k = 0; k < 14; k++) {
      const ox = (rnd() - 0.5) * rx, oy = (rnd() - 0.5) * ry;
      const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, Math.max(rx, ry) * (0.5 + rnd() * 0.5));
      gr.addColorStop(0, `rgba(${color},${alpha})`); gr.addColorStop(1, `rgba(${color},0)`);
      g.fillStyle = gr;
      g.beginPath(); g.ellipse(x + ox, y + oy, rx * (0.5 + rnd() * 0.6), ry * (0.5 + rnd() * 0.6), 0, 0, Math.PI * 2); g.fill();
    }
  };
  const maria = [[-15, 33, 16], [17, 28, 9], [31, 8, 11], [59, 17, 6], [51, -8, 8], [-17, -21, 9],
    [-57, 18, 22], [-40, 40, 10], [0, 56, 7], [35, -15, 5], [-39, -24, 5], [-5, 5, 6], [-25, 10, 8]];
  maria.forEach(([lo, la, r]) => blob(lo, la, r, '52,52,56', 0.35));
  for (let i = 0; i < 900; i++) {           // craters
    const x = rnd() * w, y = rnd() * h, r = Math.pow(rnd(), 3) * 12 + 0.6;
    g.fillStyle = `rgba(255,255,250,${0.05 + rnd() * 0.12})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = `rgba(40,40,40,${0.05 + rnd() * 0.1})`;
    g.beginPath(); g.arc(x + r * 0.2, y + r * 0.2, r * 0.8, 0, Math.PI * 2); g.fill();
  }
  blob(-11, -43, 2, '255,255,250', 0.5);     // Tycho
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const MOON_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uSunDir;
uniform float uSun;
uniform vec3 uCamPos;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;
void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vPos);
  float mu0 = max(dot(N, uSunDir), 0.0);
  float mu = max(dot(N, V), 0.0);
  vec3 alb = texture2D(uMap, vUv).rgb * 0.42;
  // Lommel-Seeliger: the full Moon looks flat, as it really does.
  float ls = 2.0 * mu0 / (mu0 + mu + 1e-4);
  vec3 c = alb * uSun * ls * smoothstep(0.0, 0.02, mu0);
  c += alb * 0.004;                                // earthshine
  gl_FragColor = vec4(c, 1.0);
}`;

export function createMoon(shared) {
  const mat = new THREE.ShaderMaterial({
    vertexShader: SPHERE_VERT,
    fragmentShader: MOON_FRAG,
    uniforms: { ...shared, uMap: { value: proceduralMoon() } },
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(MOON_RADIUS, 96, 48), mat);

  async function loadTexture(dataBase) {
    const t = await loadFirst([`${dataBase}moon.jpg`], { srgb: true });
    if (t) mat.uniforms.uMap.value = t;
  }

  const x = new THREE.Vector3(), y = new THREE.Vector3(), z = new THREE.Vector3(), m = new THREE.Matrix4();
  function update(eph, settings) {
    mesh.position.copy(eph.moonPos);
    mesh.scale.setScalar(Math.max(0.2, settings.moonScale));
    // Tidally locked: selenographic longitude 0 faces the Earth, north up.
    x.copy(eph.moonPos).multiplyScalar(-1).normalize();
    y.set(0, 1, 0).addScaledVector(x, -x.y).normalize();
    z.crossVectors(x, y);
    mesh.quaternion.setFromRotationMatrix(m.makeBasis(x, y, z));
  }

  return { mesh, loadTexture, update, radius: MOON_RADIUS };
}
