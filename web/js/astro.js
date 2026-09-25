// Ephemeris: real positions of the Sun, Moon and planets for a moment in time.
//
// Scene frame: Earth-centred, equator and equinox of date, Three.js y-up:
//   three.x = equinox direction, three.y = north celestial pole,
//   three.z = -(RA 90° direction). Unit of length = one Earth radius.
import * as THREE from 'three';

const A = window.Astronomy;
const EARTH_RADIUS_KM = 6371.0;
const AU_IN_EARTH_RADII = 149597870.7 / EARTH_RADIUS_KM;

export const PLANETS = ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

const eqToThree = (v) => new THREE.Vector3(v.x, v.z, -v.y);

// Geographic latitude/longitude (degrees) to a unit vector in the Earth-fixed frame.
// Matches THREE.SphereGeometry UVs of an equirectangular map (lon 0 on +X, east toward -Z).
export function latLonToVec(latDeg, lonDeg, out = new THREE.Vector3()) {
  const la = THREE.MathUtils.degToRad(latDeg);
  const lo = THREE.MathUtils.degToRad(lonDeg);
  return out.set(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
}

let planetCache = { at: 0, list: [] };

export function computeEphemeris(date) {
  const time = A.MakeTime(date);
  const rot = A.Rotation_EQJ_EQD(time);
  const toScene = (v) => eqToThree(A.RotateVector(rot, v));

  const sunDir = toScene(A.GeoVector(A.Body.Sun, time, true)).normalize();
  const moonPos = toScene(A.GeoMoon(time)).multiplyScalar(AU_IN_EARTH_RADII);

  // Planets move slowly across the sky: refresh them once a minute of simulated time.
  if (Math.abs(date - planetCache.at) > 60000 || !planetCache.list.length) {
    planetCache = {
      at: +date,
      list: PLANETS.map((name) => {
        const v = toScene(A.GeoVector(name, time, true));
        let mag = 5;
        try { mag = A.Illumination(name, time).mag; } catch { /* keep default */ }
        return { name, dir: v.clone().normalize(), distAU: v.length(), mag };
      }),
    };
  }

  // J2000 star catalogue -> equator of date (precession, ~0.35° today).
  const f = (x, y, z) => toScene({ x, y: -z, z: y, t: time });
  const starMatrix = new THREE.Matrix4().makeBasis(f(1, 0, 0), f(0, 1, 0), f(0, 0, 1));

  // Greenwich apparent sidereal time -> rotation of the Earth-fixed frame about the pole.
  const earthRotation = (A.SiderealTime(time) / 24) * Math.PI * 2;

  return { date, sunDir, moonPos, planets: planetCache.list, starMatrix, earthRotation };
}
