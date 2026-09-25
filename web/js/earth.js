import * as THREE from 'three';
import { SPHERE_VERT, EARTH_FRAG, CLOUD_FRAG, HALO_FRAG, CLOUD_ALT, ATM_H } from './shaders.js';
import { loadFirst, solidTexture } from './textures.js';

// Earth = surface + layered live cloud deck + atmospheric limb halo.
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
      uLand: { value: 1 },
      uGlint: { value: 1 },
      uRough: { value: 0.35 },
    },
  });
  const surface = new THREE.Mesh(new THREE.SphereGeometry(1, 256, 128), earthMat);
  group.add(surface);

  // Layered cloud deck (see CLOUD_FRAG). Quality decides how many shells draw.
  const MAX_LAYERS = 5;
  const cloudShared = {
    uOpacity: { value: 1 },
    uCloudTexel: { value: new THREE.Vector2(1 / 2048, 1 / 1024) },
    uShadowSteps: { value: 4 },
  };
  const cloudLayers = [];
  for (let i = 0; i < MAX_LAYERS; i++) {
    const mat = new THREE.ShaderMaterial({
      vertexShader: SPHERE_VERT,
      fragmentShader: CLOUD_FRAG,
      uniforms: { ...shared, ...cloudUniforms, ...cloudShared, uLayer: { value: 0 }, uLayerAlpha: { value: 1 } },
      transparent: true,
      depthWrite: false,
    });
    const r = 1 + CLOUD_ALT * (0.75 + 0.18 * i);
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(r, 256, 128), mat);
    mesh.renderOrder = 1 + i * 0.01;          // bottom of the deck first
    group.add(mesh);
    cloudLayers.push(mesh);
  }
  const clouds = cloudLayers[0];
  let layerCount = -1;

  function setLayerCount(n) {
    if (n === layerCount) return;
    layerCount = n;
    cloudLayers.forEach((m, i) => {
      m.userData.active = i < n;
      m.material.uniforms.uLayer.value = n <= 1 ? 0 : i / (n - 1);
      m.material.uniforms.uLayerAlpha.value = i === 0 ? 1 : 0.88;
    });
  }

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
    cloudShared.uCloudTexel.value.set(1 / tex.image.width, 1 / tex.image.height);
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
    const q = settings.quality;
    setLayerCount(q === 'low' ? 1 : q === 'high' ? 5 : 3);
    cloudShared.uShadowSteps.value = q === 'low' ? 2 : q === 'high' ? 5 : 4;
    cloudLayers.forEach((m) => { m.visible = settings.clouds && m.userData.active; });
    earthMat.uniforms.uCloudsOn.value = settings.clouds ? 1 : 0;
    earthMat.uniforms.uLand.value = settings.landBrightness;
    earthMat.uniforms.uGlint.value = settings.oceanReflection;
    earthMat.uniforms.uRough.value = settings.oceanRoughness;
    cloudShared.uOpacity.value = settings.cloudOpacity;
  }

  return { group, surface, clouds, halo, loadBaseTextures, setClouds, update };
}
