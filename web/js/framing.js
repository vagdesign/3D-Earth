// Camera framing: Earth always fills the chosen share of the screen height,
// optionally shifted left/right with an off-axis (lens-shift) projection so it
// stays a perfect circle. The viewpoint is physically real in every mode:
//   home    - hovering above the user's location (geostationary-like)
//   moon    - a real vantage point from which the Moon appears beside the Earth
//   sunrise - the Sun just behind the Earth's limb, lighting the atmosphere
import * as THREE from 'three';
import { latLonToVec } from './astro.js';

const deg = THREE.MathUtils.degToRad;
const Y = new THREE.Vector3(0, 1, 0);

function perpendicular(v) {
  const a = Math.abs(v.y) < 0.9 ? Y : new THREE.Vector3(1, 0, 0);
  return new THREE.Vector3().crossVectors(v, a).normalize();
}

// Orient the camera so that a target direction lands at camera-space direction vcam
// while the camera looks at the Earth's centre from distance d.
// dirFn(camPos|null) -> unit direction from the camera to the target.
// perpFn(m) -> unit vector perpendicular to m choosing the free rotation around it.
function solve(camera, d, vcam, dirFn, perpFn) {
  const theta = Math.acos(THREE.MathUtils.clamp(-vcam.z, -1, 1));
  let m = dirFn(null);
  const c = new THREE.Vector3();
  for (let i = 0; i < 4; i++) {
    const p = perpFn(m);
    c.copy(m).multiplyScalar(Math.cos(theta)).addScaledVector(p, Math.sin(theta)).multiplyScalar(-1).normalize();
    m = dirFn(c.clone().multiplyScalar(d));
  }
  const q = m.clone().addScaledVector(c, -m.dot(c));
  if (q.lengthSq() < 1e-10) return false;
  q.normalize();
  const w = new THREE.Vector3().crossVectors(c, q);
  const len = Math.hypot(vcam.x, vcam.y) || 1;
  const a = vcam.x / len, b = vcam.y / len;
  const right = q.clone().multiplyScalar(a).addScaledVector(w, -b);
  const up = q.clone().multiplyScalar(b).addScaledVector(w, a);
  camera.position.copy(c).multiplyScalar(d);
  camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, c));
  camera.updateMatrixWorld(true);
  return true;
}

let moonChoice = null;

export function frameCamera(camera, settings, eph, width, height) {
  const aspect = width / height;
  const fill = THREE.MathUtils.clamp(settings.earthFill, 0.2, 1.2);
  camera.fov = THREE.MathUtils.clamp(settings.fov, 10, 90);
  camera.aspect = aspect;
  const tanHalf = Math.tan(deg(camera.fov / 2));
  const rho = Math.atan(fill * tanHalf);          // Earth's angular radius
  const d = 1 / Math.sin(rho);

  // Horizontal lens shift, in NDC, of the Earth's centre.
  const rNdcX = fill / aspect;
  const ex = THREE.MathUtils.clamp(settings.earthPosition, -1, 1) * Math.max(0, 1 - rNdcX);
  camera.setViewOffset(width, height, (-ex * width) / 2, 0, width, height);
  camera.near = 0.01;
  camera.far = 4000;
  camera.updateProjectionMatrix();

  const earthRot = eph.earthRotation;
  const home = latLonToVec(settings.homeLat, settings.homeLon).applyAxisAngle(Y, earthRot);
  const s = eph.sunDir;

  const homeView = () => {
    camera.position.copy(home).multiplyScalar(d);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld(true);
  };

  const ndcDir = (x, y) => new THREE.Vector3(x, y, 0.5).applyMatrix4(camera.projectionMatrixInverse).normalize();

  if (settings.view === 'moon') {
    // Put the Moon in the larger empty band beside the Earth. The rotation of the
    // camera around the Moon direction is free: pick the one that keeps north up and
    // the Sun at the requested angle, and only revisit that choice now and then so
    // the view never jumps.
    const side = settings.earthPosition > 0.1 ? -1 : 1;
    const limb = ex + side * rNdcX;
    const xt = limb + (side - limb) * 0.42;
    const wantSun = deg(THREE.MathUtils.clamp(settings.sunsideBias, 0, 90));
    const moonDir = (camPos) => (camPos ? eph.moonPos.clone().sub(camPos) : eph.moonPos.clone()).normalize();
    const perpAt = (phi) => (m) => {
      const b1 = perpendicular(m);
      const b2 = new THREE.Vector3().crossVectors(m, b1);
      return b1.multiplyScalar(Math.cos(phi)).addScaledVector(b2, Math.sin(phi));
    };
    const key = `${settings.earthPosition}|${settings.sunsideBias}|${settings.fov}|${settings.earthFill}|${width}x${height}`;
    const score = () => {
      const c = camera.position.clone().normalize();
      const up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      const north = Y.clone().addScaledVector(c, -Y.dot(c));
      const northUp = north.lengthSq() > 1e-6 ? up.dot(north.normalize()) : 0;
      const sunErr = Math.abs(Math.acos(THREE.MathUtils.clamp(c.dot(s), -1, 1)) - wantSun);
      return northUp * 1.0 - sunErr * 1.2;
    };
    const now = +eph.date;
    if (!moonChoice || moonChoice.key !== key || Math.abs(now - moonChoice.at) > 10 * 60 * 1000) {
      let best = null;
      for (const yt of [0.34, -0.34]) {
        const vcam = ndcDir(xt, yt);
        for (let k = 0; k < 36; k++) {
          const phi = (k / 36) * Math.PI * 2;
          if (!solve(camera, d, vcam, moonDir, perpAt(phi))) continue;
          const sc = score();
          if (!best || sc > best.sc) best = { sc, yt, phi };
        }
      }
      // Hysteresis: keep the previous choice unless the new one is clearly better.
      if (best && moonChoice && moonChoice.key === key) {
        solve(camera, d, ndcDir(xt, moonChoice.yt), moonDir, perpAt(moonChoice.phi));
        if (score() > best.sc - 0.25) best = { sc: score(), yt: moonChoice.yt, phi: moonChoice.phi };
      }
      moonChoice = best ? { key, at: now, yt: best.yt, phi: best.phi } : null;
    }
    if (!moonChoice || !solve(camera, d, ndcDir(xt, moonChoice.yt), moonDir, perpAt(moonChoice.phi))) homeView();
  } else if (settings.view === 'sunrise') {
    const side = settings.earthPosition > 0.1 ? -1 : 1;
    const a = rho - deg(0.22);
    const psi = side > 0 ? deg(38) : deg(142);
    const vcam = new THREE.Vector3(Math.sin(a) * Math.cos(psi), Math.sin(a) * Math.sin(psi), -Math.cos(a));
    const perp = (m) => {
      // Keep the user's home region on the visible (night-side) disc if possible.
      let hp = home.clone().addScaledVector(m, -home.dot(m));
      hp = hp.lengthSq() < 1e-8 ? perpendicular(m) : hp.normalize();
      return hp.multiplyScalar(-1);
    };
    if (!solve(camera, d, vcam, () => s.clone(), perp)) homeView();
  } else {
    homeView();
  }
  return { distance: d, angularRadius: rho, centerNdcX: ex };
}
