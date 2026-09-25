import * as THREE from 'three';
import { SPHERE_VERT, EARTH_FRAG, CLOUD_FRAG, HALO_FRAG, CLOUD_ALT, ATM_H } from './shaders.js';
import { loadFirst, solidTexture } from './textures.js';

// Earth = surface + live cloud shell + atmospheric limb halo.
export function createEarth(shared) {
  const group = new THREE.Group();          // rotates with the Earth (sidereal time)

  const cloudUniforms = {
    uCloudA: { value: solidTexture(0, 0, 0) },
    uCloudB: { value: solidTexture(0, 0, 0) },
    uCloudMix: { value: 0 },
    uFlowT: { value: 0 },
  };

  const earthMat = new THREE.ShaderMaterial({
    vertexShader: SPHERE_VERT,
    fragmentShader: EARTH_FRAG,
    uniforms: {
      ...shared, ...cloudUniforms,
      uDay: { value: solidTexture(40, 70, 120) },
      uLights: { value: solidTexture(0, 0, 0) },
      uBump: { value: solidTexture(0, 0, 0) },
      uWater: { value: solidTexture(255, 255, 255) },
      uBumpTexel: { value: new THREE.Vector2(1 / 2048, 1 / 1024) },
      uCloudsOn: { value: 1 },
      uLightsI: { value: 1.5 },
    },
  });
  const surface = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), earthMat);
  group.add(surface);

  const cloudMat = new THREE.ShaderMaterial({
    vertexShader: SPHERE_VERT,
    fragmentShader: CLOUD_FRAG,
    uniforms: {
      ...shared, ...cloudUniforms,
      uOpacity: { value: 1 },
      uCloudTexel: { value: new THREE.Vector2(1 / 2048, 1 / 1024) },
    },
    transparent: true,
    depthWrite: false,
  });
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(1 + CLOUD_ALT, 256, 128), cloudMat);
  clouds.renderOrder = 1;
  group.add(clouds);

  const haloMat = new THREE.ShaderMaterial({
    vertexShader: SPHERE_VERT,
    fragmentShader: HALO_FRAG,
    uniforms: { ...shared },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const halo = new THREE.Mesh(new THREE.SphereGeometry(1 + ATM_H * 14, 192, 96), haloMat);
  halo.renderOrder = 2;
  // Halo is not rotated with the Earth (it is symmetric) but keeping it in the group is harmless.
  group.add(halo);

  let cloudFade = null;

  async function loadBaseTextures(dataBase) {
    const [day, lights, bump, water] = await Promise.all([
      loadFirst([`${dataBase}earth_day.jpg`, 'assets/earth_day.jpg'], { srgb: true }),
      loadFirst([`${dataBase}earth_lights.jpg`, 'assets/earth_lights.jpg']),
      loadFirst(['assets/earth_bump.jpg']),
      loadFirst(['assets/earth_water.jpg']),
    ]);
    const u = earthMat.uniforms;
    if (day) u.uDay.value = day;
    if (lights) u.uLights.value = lights;
    if (bump) { u.uBump.value = bump; u.uBumpTexel.value.set(1 / bump.image.width, 1 / bump.image.height); }
    if (water) u.uWater.value = water;
  }

  // Swap in a new cloud map with a slow cross-fade (the real "animation" of the weather).
  async function setClouds(urls) {
    const tex = await loadFirst(urls);
    if (!tex) return false;
    tex.generateMipmaps = true;
    const cu = cloudUniforms;
    if (cu.uCloudA.value.image && cu.uCloudA.value.image.width > 1) {
      cu.uCloudB.value = tex;
      cu.uCloudMix.value = 0;
      cloudFade = { start: performance.now(), dur: 45000 };
    } else {
      cu.uCloudA.value = tex;
      cu.uCloudB.value = tex;
    }
    cloudMat.uniforms.uCloudTexel.value.set(1 / tex.image.width, 1 / tex.image.height);
    return true;
  }

  function update(now, settings) {
    const cu = cloudUniforms;
    cu.uFlowT.value = now / 1000 * 0.08;
    if (cloudFade) {
      const k = Math.min(1, (now - cloudFade.start) / cloudFade.dur);
      cu.uCloudMix.value = k * k * (3 - 2 * k);
      if (k >= 1) {
        const old = cu.uCloudA.value;
        cu.uCloudA.value = cu.uCloudB.value;
        cu.uCloudMix.value = 0;
        cloudFade = null;
        if (old !== cu.uCloudA.value) old.dispose();
      }
    }
    clouds.visible = settings.clouds;
    earthMat.uniforms.uCloudsOn.value = settings.clouds ? 1 : 0;
    cloudMat.uniforms.uOpacity.value = settings.cloudOpacity;
  }

  return { group, surface, clouds, halo, loadBaseTextures, setClouds, update };
}
