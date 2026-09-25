import * as THREE from 'three';
import { loadFirst, fetchJson } from './textures.js';

const SKY_R = 1000;
const SUN_ANGULAR_RADIUS = THREE.MathUtils.degToRad(0.2666);

// Approximate colour of a star from its B-V index.
function bvToRgb(bv) {
  const t = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62)) / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.47 * Math.log(t) - 161.12; b = t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04; }
  else { r = 329.7 * Math.pow(t - 60, -0.1332); g = 288.12 * Math.pow(t - 60, -0.0755); b = 255; }
  const c = (v) => Math.min(255, Math.max(0, v)) / 255;
  // Desaturate: stars look mostly white to the eye/camera.
  const k = 0.55;
  return [1 - k + k * c(r), 1 - k + k * c(g), 1 - k + k * c(b)];
}

const POINT_VERT = /* glsl */ `
attribute float aSize;
attribute vec3 aColor;
uniform float uScale;
varying vec3 vColor;
void main() {
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale;
  gl_Position = projectionMatrix * mv;
}`;
const POINT_FRAG = /* glsl */ `
uniform float uIntensity;
varying vec3 vColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = exp(-d * d * 5.0) * smoothstep(1.0, 0.7, d);
  gl_FragColor = vec4(vColor * uIntensity * a, 1.0);
}`;

function pointsMaterial() {
  return new THREE.ShaderMaterial({
    vertexShader: POINT_VERT,
    fragmentShader: POINT_FRAG,
    uniforms: { uScale: { value: 1 }, uIntensity: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}

const PLANET_COLORS = {
  Mercury: [0.85, 0.8, 0.75], Venus: [1.0, 0.96, 0.88], Mars: [1.0, 0.62, 0.42],
  Jupiter: [1.0, 0.93, 0.82], Saturn: [1.0, 0.9, 0.72], Uranus: [0.72, 0.9, 1.0], Neptune: [0.6, 0.72, 1.0],
};

const SUN_FRAG = /* glsl */ `
uniform float uGlow;
varying vec2 vUv;
void main() {
  float r = length(vUv * 2.0 - 1.0) * 60.0;            // in solar radii
  float disc = smoothstep(1.03, 0.97, r) * 60.0;
  float corona = 0.9 / (r * r + 0.3) * uGlow;
  vec3 c = vec3(1.0, 0.97, 0.92) * (disc + corona) * smoothstep(60.0, 40.0, r);
  gl_FragColor = vec4(c, 1.0);
}`;
const GLARE_FRAG = /* glsl */ `
uniform float uVis;
uniform float uAspect;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float a = atan(p.y, p.x);
  float glow = exp(-r * 7.0) * 1.2 + exp(-r * 2.2) * 0.12;
  float rays = pow(abs(cos(a * 3.0 + 0.3)), 240.0) * exp(-r * 6.0) * 0.18;
  vec3 c = vec3(1.0, 0.95, 0.86) * (glow + rays) * uVis * smoothstep(1.0, 0.6, r);
  gl_FragColor = vec4(c, 1.0);
}`;
const BILLBOARD_VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

export async function createSky(scene) {
  const group = new THREE.Group();       // centred on the camera every frame
  const celestial = new THREE.Group();   // J2000 -> equator of date
  celestial.matrixAutoUpdate = false;
  group.add(celestial);
  scene.add(group);

  // Milky Way (equirectangular, RA/Dec), drawn first.
  const mwTex = await loadFirst(['assets/milkyway.jpg'], { srgb: true });
  const mwMat = new THREE.ShaderMaterial({
    vertexShader: BILLBOARD_VERT,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap; uniform float uI; varying vec2 vUv;
      void main() { gl_FragColor = vec4(texture2D(uMap, vUv).rgb * uI, 1.0); }`,
    uniforms: { uMap: { value: mwTex }, uI: { value: 0.05 } },
    side: THREE.BackSide, depthWrite: false, transparent: true, blending: THREE.AdditiveBlending,
  });
  const milkyWay = new THREE.Mesh(new THREE.SphereGeometry(SKY_R, 96, 48), mwMat);
  milkyWay.renderOrder = -10;
  milkyWay.visible = !!mwTex;
  celestial.add(milkyWay);

  // Stars (Yale Bright Star Catalogue, V <= 6).
  const catalog = (await fetchJson('assets/stars.json')) || [];
  const pos = new Float32Array(catalog.length * 3);
  const col = new Float32Array(catalog.length * 3);
  const size = new Float32Array(catalog.length);
  catalog.forEach(([ra, dec, mag, bv], i) => {
    const a = THREE.MathUtils.degToRad(ra), d = THREE.MathUtils.degToRad(dec);
    // RA/Dec -> scene axes (x, z, -y)
    pos.set([Math.cos(d) * Math.cos(a) * SKY_R * 0.98, Math.sin(d) * SKY_R * 0.98, -Math.cos(d) * Math.sin(a) * SKY_R * 0.98], i * 3);
    const flux = Math.pow(10, -0.4 * (mag - 0.5));
    const [r, g, b] = bvToRgb(bv);
    const k = Math.min(1.0, 0.07 + flux * 0.9);
    col.set([r * k, g * k, b * k], i * 3);
    size[i] = Math.min(5.5, 1.6 + 2.0 * Math.sqrt(flux));
  });
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  starGeo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
  starGeo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  const starMat = pointsMaterial();
  const stars = new THREE.Points(starGeo, starMat);
  stars.renderOrder = -9;
  stars.frustumCulled = false;
  celestial.add(stars);

  // Planets: bright points at their true directions.
  const planetGeo = new THREE.BufferGeometry();
  planetGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(7 * 3), 3));
  planetGeo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(7 * 3), 3));
  planetGeo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(7), 1));
  const planetMat = pointsMaterial();
  const planets = new THREE.Points(planetGeo, planetMat);
  planets.renderOrder = -8;
  planets.frustumCulled = false;
  group.add(planets);

  // The Sun: HDR disc + corona, occluded by the Earth through the depth buffer.
  const sunSize = SKY_R * 0.95 * Math.tan(SUN_ANGULAR_RADIUS) * 60 * 2;
  const sunMat = new THREE.ShaderMaterial({
    vertexShader: BILLBOARD_VERT, fragmentShader: SUN_FRAG,
    uniforms: { uGlow: { value: 1 } },
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const sun = new THREE.Mesh(new THREE.PlaneGeometry(sunSize, sunSize), sunMat);
  sun.renderOrder = -7;
  group.add(sun);

  // Lens glare, drawn over everything and scaled by how much of the Sun is visible.
  const glareMat = new THREE.ShaderMaterial({
    vertexShader: BILLBOARD_VERT, fragmentShader: GLARE_FRAG,
    uniforms: { uVis: { value: 0 }, uAspect: { value: 1 } },
    transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
  });
  const glare = new THREE.Mesh(new THREE.PlaneGeometry(SKY_R * 1.1, SKY_R * 1.1), glareMat);
  glare.renderOrder = 100;
  glare.frustumCulled = false;
  group.add(glare);

  const tmp = new THREE.Vector3();

  function update(camera, eph, settings, pixelRatio) {
    group.position.copy(camera.position);
    celestial.matrix.copy(eph.starMatrix);
    celestial.matrixWorldNeedsUpdate = true;

    const pr = pixelRatio;
    starMat.uniforms.uScale.value = pr;
    starMat.uniforms.uIntensity.value = 1.6 * settings.stars;
    stars.visible = settings.stars > 0.001;
    mwMat.uniforms.uI.value = 0.09 * settings.milkyWay;
    milkyWay.visible = settings.milkyWay > 0.001 && !!mwTex;

    const pp = planetGeo.attributes.position, pc = planetGeo.attributes.aColor, ps = planetGeo.attributes.aSize;
    eph.planets.forEach((p, i) => {
      tmp.copy(p.dir).multiplyScalar(SKY_R * 0.97);
      pp.setXYZ(i, tmp.x, tmp.y, tmp.z);
      const flux = Math.pow(10, -0.4 * (p.mag + 1.0));
      const k = Math.min(3.0, 0.12 + flux * 1.4);
      const c = PLANET_COLORS[p.name] || [1, 1, 1];
      pc.setXYZ(i, c[0] * k, c[1] * k, c[2] * k);
      ps.setX(i, Math.min(7, 2.4 + 2.2 * Math.sqrt(flux)));
    });
    pp.needsUpdate = pc.needsUpdate = ps.needsUpdate = true;
    planetMat.uniforms.uScale.value = pr;
    planetMat.uniforms.uIntensity.value = 1.5 * Math.max(settings.stars, 0.35);

    sun.position.copy(eph.sunDir).multiplyScalar(SKY_R * 0.95);
    sun.quaternion.copy(camera.quaternion);
    glare.position.copy(eph.sunDir).multiplyScalar(SKY_R * 0.9);
    glare.quaternion.copy(camera.quaternion);

    // Fraction of the solar disc not hidden behind the Earth.
    const dist = camera.position.length();
    const earthAng = Math.asin(Math.min(1, 1.0 / dist));
    tmp.copy(camera.position).multiplyScalar(-1 / dist);
    const sep = Math.acos(THREE.MathUtils.clamp(tmp.dot(eph.sunDir), -1, 1));
    const vis = THREE.MathUtils.clamp((sep - earthAng + SUN_ANGULAR_RADIUS) / (2 * SUN_ANGULAR_RADIUS), 0, 1);
    glareMat.uniforms.uVis.value = vis;
    return { sunVisible: vis };
  }

  return { group, update };
}
