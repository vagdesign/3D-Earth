// Shared GLSL: an analytic single-scattering atmosphere (Chapman-function
// optical depths, Rayleigh + Mie phase) and the live cloud-map sampler.
// Everything renders in linear HDR; tone mapping happens in the final pass.

export const ATM_H = 0.0032;        // atmosphere scale height in Earth radii (~20 km, slightly exaggerated)
export const CLOUD_ALT = 0.0045;    // cloud shell altitude in Earth radii

export const COMMON = /* glsl */ `
#define PI 3.14159265359
uniform vec3 uSunDir;
uniform float uSun;
uniform vec3 uCamPos;
uniform float uHaze;         // atmosphere haze strength (setting)

const float ATM_H = ${ATM_H.toFixed(6)};
const float ATM_X = 1.0 / ATM_H;
const vec3 TAU_R = vec3(0.050, 0.115, 0.260);   // vertical Rayleigh optical depth (R, G, B)
const float TAU_M = 0.040;                      // vertical aerosol (Mie) optical depth
const vec3 TAU_E = TAU_R + vec3(TAU_M * 1.1);

// Relative optical depth (air mass x density) from altitude h (in scale heights)
// toward a direction whose zenith cosine is mu. Schüler's Chapman approximation.
float chapman(float h, float mu) {
  float c = sqrt(ATM_X + h);
  if (mu >= 0.0) return c / (c * mu + 1.0) * exp(-h);
  float x0 = sqrt(max(1.0 - mu * mu, 0.0)) * (ATM_X + h);
  float c0 = sqrt(x0);
  return 2.0 * c0 * exp(min(ATM_X - x0, 60.0)) - c / (1.0 - c * mu) * exp(-h);
}

// Planet shadow: 0 when the Sun is below the geometric horizon of a point at altitude alt.
float planetShadow(float alt, float mu) {
  float r = 1.0 + alt;
  float dip = -sqrt(max(1.0 - 1.0 / (r * r), 0.0));
  return smoothstep(dip - 0.025, dip + 0.012, mu);
}

vec3 sunTransmittance(float hScale, float mu) {
  return exp(-TAU_E * chapman(hScale, mu)) * planetShadow(hScale * ATM_H, mu);
}

vec3 phaseMix(float mu) {
  float pr = 0.75 * (1.0 + mu * mu);
  const float g = 0.76;
  float pm = (1.0 - g * g) / pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5);
  return (TAU_R * pr + vec3(TAU_M) * pm) / TAU_E;
}

// Single-scattered sunlight along a view path with transmittance Tv.
vec3 inscatter(vec3 Tv, vec3 sunT, float mu) {
  // (1 - T) of the light is scattered over the whole sphere; 1/4 matches the
  // surface's Lambert normalisation used below.
  return uSun * sunT * (1.0 - Tv) * phaseMix(mu) * 0.25 * uHaze;
}

uniform float uTime;         // seconds

float hash3(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.71, 0.113, 0.419));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash3(i), hash3(i + vec3(1, 0, 0)), f.x),
                 mix(hash3(i + vec3(0, 1, 0)), hash3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash3(i + vec3(0, 0, 1)), hash3(i + vec3(1, 0, 1)), f.x),
                 mix(hash3(i + vec3(0, 1, 1)), hash3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
// ---- clouds ----
uniform sampler2D uCloudA;
uniform sampler2D uCloudB;
uniform float uCloudMix;
uniform float uFlowT;

uniform float uCloudCover;   // setting: <1 thinner, >1 thicker
// Satellite brightness -> cloud thickness 0..1 (linear above the haze floor,
// so thin cloud stays thin instead of saturating to white).
float cloudRaw(sampler2D t, vec2 uv) {
  float v = texture2D(t, uv).r;
  return clamp((v - 0.10) / 0.80 * uCloudCover, 0.0, 1.0);
}
// Gentle two-phase flow so the cloud field breathes between satellite updates.
float cloudAt(vec2 uv) {
  float lat = (uv.y - 0.5) * PI;
  vec2 f = vec2(sin(uv.y * 57.0 + uFlowT * 0.9 + sin(uv.x * 31.0)),
                cos(uv.x * 43.0 - uFlowT * 0.7 + sin(uv.y * 37.0))) * 0.00045;
  f.x /= max(cos(lat), 0.2);
  float p = fract(uFlowT * 0.05);
  vec2 o1 = f * (p - 0.5) * 2.0, o2 = f * (fract(p + 0.5) - 0.5) * 2.0;
  float w = abs(p - 0.5) * 2.0;
  float a = mix(cloudRaw(uCloudA, uv + o1), cloudRaw(uCloudA, uv + o2), w);
  if (uCloudMix < 0.001) return a;                 // no cross-fade running: skip map B
  float b = mix(cloudRaw(uCloudB, uv + o1), cloudRaw(uCloudB, uv + o2), w);
  return mix(a, b, uCloudMix);
}
// Cheaper lookup (no flow) for self-shadow marching.
float cloudFast(vec2 uv) {
  float a = cloudRaw(uCloudA, uv);
  return uCloudMix < 0.001 ? a : mix(a, cloudRaw(uCloudB, uv), uCloudMix);
}
`;

export const SPHERE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;
varying vec3 vObjN;          // Earth-fixed direction (procedural cloud detail)
void main() {
  vUv = uv;
  vObjN = normal;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPos = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

export const EARTH_FRAG = /* glsl */ `
${COMMON}
uniform sampler2D uDay;
uniform sampler2D uLights;
uniform sampler2D uBump;
uniform sampler2D uWater;
uniform vec2 uBumpTexel;
uniform float uCloudsOn;
uniform float uLightsI;
uniform float uFlicker;      // 0 = steady city lights ... 1 = strong twinkle
uniform float uLand;         // land brightness / diffuse albedo (setting)
uniform float uGlint;        // ocean reflection strength (setting)
uniform float uRough;        // ocean roughness 0 = mirror ... 1 = matte (setting)
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;

void main() {
  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vPos);
  vec3 L = uSunDir;
  vec3 axis = vec3(0.0, 1.0, 0.0);
  vec3 eastRaw = cross(axis, N);
  float cosLat = max(length(eastRaw), 0.02);
  vec3 east = eastRaw / cosLat;
  vec3 north = cross(N, east);

  float water = texture2D(uWater, vUv).r;
  float land = 1.0 - water;

  // Relief from the elevation map (land only).
  float hx = texture2D(uBump, vUv + vec2(uBumpTexel.x, 0.0)).r - texture2D(uBump, vUv - vec2(uBumpTexel.x, 0.0)).r;
  float hy = texture2D(uBump, vUv + vec2(0.0, uBumpTexel.y)).r - texture2D(uBump, vUv - vec2(0.0, uBumpTexel.y)).r;
  vec3 Nb = normalize(N - land * 0.9 * (hx / cosLat * east + hy * north));

  float muS = dot(N, L);
  float diff = max(dot(Nb, L), 0.0) * smoothstep(-0.02, 0.04, muS);
  vec3 sunT = sunTransmittance(0.0, muS);

  vec3 albedo = texture2D(uDay, vUv).rgb;
  // Deepen the oceans slightly; Blue Marble oceans read a little bright from orbit.
  albedo = mix(albedo, albedo * vec3(0.55, 0.72, 0.95), water * 0.5);
  albedo *= mix(uLand, 1.0, water);

  float cloud = uCloudsOn > 0.5 ? cloudAt(vUv) : 0.0;
  float shadow = 1.0;
  if (uCloudsOn > 0.5) {
    float cs = max(muS, 0.12);
    vec2 off = vec2(dot(L, east) / cosLat / (2.0 * PI), dot(L, north) / PI) * (${CLOUD_ALT.toFixed(5)} / cs);
    shadow = 1.0 - 0.55 * cloudAt(vUv + off);
  }

  vec3 col = albedo * uSun * sunT * diff * shadow;

  // Ocean: energy-conserving Blinn-Phong glint with Schlick Fresnel; the
  // roughness setting widens the sun glint, the reflection setting scales it.
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  float nv = max(dot(N, V), 0.0);
  float rough = clamp(uRough, 0.02, 1.0);
  float shin = mix(3000.0, 20.0, pow(rough, 0.6));
  float Fh = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
  float spec = (shin + 8.0) / (8.0 * PI) * pow(nh, shin) * Fh * max(muS, 0.0);
  col += water * uGlint * uSun * sunT * shadow * spec * (1.0 - cloud) * 0.6;
  // Skylight reflected by the sea at grazing angles.
  float Fv = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  col += water * uGlint * Fv * vec3(0.09, 0.16, 0.32) * uSun * sunTransmittance(1.0, muS) * 0.12 * (1.0 - cloud);

  // City lights on the night side, hidden by clouds.
  float night = smoothstep(0.06, -0.14, muS);
  float lights = texture2D(uLights, vUv).r;
  // Subtle scintillation: city-sized cells brighten and dim a little over time.
  vec3 lp = vec3(vUv * vec2(2400.0, 1200.0), uTime * 1.7);
  float flick = 1.0 + uFlicker * (vnoise(lp) + 0.5 * vnoise(lp * 2.3 + 11.0) - 0.75) * 1.1;
  col += vec3(1.0, 0.74, 0.45) * lights * lights * uLightsI * flick * night * (1.0 - 0.9 * cloud);

  // Atmosphere between the ground and the camera.
  float od = chapman(0.0, max(nv, 0.0));
  vec3 Tv = exp(-TAU_E * od);
  vec3 sunAir = sunTransmittance(1.0, muS) * smoothstep(-0.08, 0.02, muS);
  col = col * Tv + inscatter(Tv, sunAir, dot(-V, L));
  // A touch of multiple scattering so the day side is not overly contrasty.
  col += uSun * sunAir * vec3(0.002, 0.005, 0.011) * smoothstep(-0.1, 0.5, muS);

  gl_FragColor = vec4(col, 1.0);
}
`;

// One shell of the layered (volumetric-looking) cloud deck. Several shells are
// stacked a few km apart: each shows only cloud thicker than its height in the
// deck, so thick storm cores stand up above thin cloud, edges get parallax at
// the limb, and tops cast shadows onto the cloud beside them.
// One shell of the layered cloud deck. The satellite map says where cloud is
// and how thick; multi-octave procedural noise (anchored to the Earth, octaves
// faded out below pixel size) adds the billows and cells a 5-10 km/pixel
// satellite map cannot show; bump lighting from that detail gives every puff
// light and shadow, like photos from the ISS.
export const CLOUD_FRAG = /* glsl */ `
${COMMON}
uniform float uOpacity;
uniform vec2 uCloudTexel;
uniform float uLayer;        // 0 = base of the deck ... 1 = cloud tops
uniform float uLayerAlpha;
uniform float uShadowSteps;
uniform float uOctaves;      // procedural detail octaves (quality)
uniform float uDetail;       // setting: 0 = satellite map only ... 1 = full detail
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;
varying vec3 vObjN;

const mat3 OCT_ROT = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);

// Billowy fbm from continent-scale bands down to ~5 km cells. Octaves smaller
// than a pixel fade out, so there is no sparkle and no shimmer while moving.
float cloudDetail(vec3 dir, float px) {
  vec3 p = dir * 14.0 + vec3(uLayer * 7.3, uLayer * 3.1, 0.0);
  float freq = 14.0, amp = 0.55, sum = 0.0, norm = 0.0;
  for (int i = 0; i < 10; i++) {
    if (float(i) >= uOctaves) break;
    float fade = 1.0 - smoothstep(0.10, 0.30, freq * px);
    if (fade <= 0.0) break;
    float n = vnoise(p);
    n = 1.0 - abs(2.0 * n - 1.0);          // billows
    sum += amp * fade * n;
    norm += amp * fade;
    p = OCT_ROT * p * 2.13 + vec3(1.7, 9.2, 3.1);   // rotate each octave: no grid artefacts
    freq *= 2.13;
    amp *= 0.58;
  }
  return norm > 0.0 ? sum / norm : 0.6;
}

void main() {
  float t = cloudAt(vUv);                          // thickness from the satellite map
  float th = uLayer * 0.55;
  // This shell holds cloud thicker than its height; no cloud where the map has none.
  float aaw = fwidth(t) * 1.5;                     // widen edges by the pixel footprint (anti-aliasing)
  float cover = smoothstep(max(th - 0.12, 0.0) - aaw, th + 0.38 + aaw, t) * smoothstep(0.0, 0.10 + aaw, t);
  if (cover < 0.002) discard;

  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vPos);
  vec3 L = uSunDir;
  vec3 eastRaw = cross(vec3(0.0, 1.0, 0.0), N);
  float cosLat = max(length(eastRaw), 0.02);
  vec3 east = eastRaw / cosLat;
  vec3 north = cross(N, east);

  vec3 dir = normalize(vObjN);
  float px = length(fwidth(dir));
  float n = mix(0.6, cloudDetail(dir, px), uDetail);

  // Density: thick cores stay solid, thin cloud and edges break into cells.
  float dens = clamp(cover * (0.25 + 1.2 * n) - (1.0 - t) * (1.0 - n) * 0.9 * uDetail, 0.0, 1.0);
  float alpha = 1.0 - exp(-4.5 * dens * (0.35 + 0.65 * t));
  if (alpha < 0.002) discard;

  // Bump lighting from the combined height (map + detail) via screen-space derivatives.
  float h = (t * 0.55 + n * 0.45 * uDetail) * 0.004;
  vec3 dpdx = dFdx(vPos), dpdy = dFdy(vPos);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpdy, N), r2 = cross(N, dpdx);
  float det = dot(dpdx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  vec3 Nb = normalize(abs(det) * N - grad * 5.0);
  float cosLatC = max(cosLat, 0.3);                // avoid radial streaks at the poles

  float muS = dot(N, L);
  vec3 sunT = sunTransmittance(1.4 + uLayer, muS);

  // Self-shadowing toward the Sun across the cloud field. Only matters when the
  // Sun is low (long shadows near the terminator); skipped otherwise.
  float occl = 0.0;
  if (muS < 0.6 && muS > -0.15) {
    vec2 sunUV = vec2(dot(L, east) / cosLatC / (2.0 * PI), dot(L, north) / PI);
    for (int i = 1; i <= 5; i++) {
      if (float(i) > uShadowSteps) break;
      float fi = float(i);
      occl += smoothstep(th, th + 0.4, cloudFast(vUv + sunUV * fi * 0.0028)) * (1.0 - 0.12 * fi);
    }
    occl *= smoothstep(0.05, 0.3, cosLat) * smoothstep(0.6, 0.35, muS);
  }
  float selfShadow = exp(-occl * 0.5 * (1.1 - uLayer));

  float lambert = clamp((dot(Nb, L) + 0.1) / 1.1, 0.0, 1.0);
  float day = smoothstep(-0.10, 0.03, muS);
  // Valleys between billows are darker (ambient occlusion); thick cores brighter.
  float ao = mix(0.58, 1.0, smoothstep(0.25, 0.9, n)) * (0.8 + 0.2 * t);
  vec3 col = vec3(0.80) * uSun * sunT * lambert * selfShadow * ao * day;
  // Blue skylight fills the shaded sides.
  col += vec3(0.018, 0.030, 0.052) * uSun * sunT * smoothstep(-0.05, 0.4, muS) * ao;
  // Thin cloud lets the light through toward the viewer (forward scattering / silver lining).
  float fwd = pow(max(dot(-V, L), 0.0), 8.0);
  col += uSun * sunT * fwd * (1.0 - alpha) * 0.5;

  float nv = max(dot(N, V), 0.0);
  vec3 Tv = exp(-TAU_E * chapman(1.4 + uLayer, nv));
  col = col * Tv + inscatter(Tv, sunT, dot(-V, L));

  gl_FragColor = vec4(col, alpha * uOpacity * uLayerAlpha);
}
`;

// Limb halo: a shell around the planet; each pixel integrates the atmosphere
// along the view ray using its tangent altitude.
export const HALO_FRAG = /* glsl */ `
${COMMON}
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;
void main() {
  vec3 rd = normalize(vPos - uCamPos);
  float tc = -dot(uCamPos, rd);
  vec3 pc = uCamPos + rd * tc;
  float rc = length(pc);
  if (rc < 1.0) discard;
  float alt = rc - 1.0;
  float hs = alt / ATM_H;
  vec3 Tv = exp(-TAU_E * 2.0 * chapman(hs, 0.0));
  float muS = dot(pc / rc, uSunDir);
  vec3 sunT = sunTransmittance(hs, muS);
  vec3 col = inscatter(Tv, sunT, dot(rd, uSunDir));
  gl_FragColor = vec4(col, 1.0);
}
`;

export const POST_FRAG = /* glsl */ `
uniform sampler2D tScene;
uniform float uExposure;
uniform vec2 uTexel;         // one output pixel in UV
uniform float uSS;           // 1 when the scene was supersampled
varying vec2 vUv;
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
vec3 tonemap(vec3 hdr) { return pow(aces(hdr * uExposure), vec3(1.0 / 2.2)); }
void main() {
  vec3 c;
  if (uSS > 0.5) {
    // Box-filter the supersampled image; tone-map before averaging so bright
    // edges (cloud rims, the limb) resolve smoothly.
    vec2 o = uTexel * 0.25;
    c = 0.25 * (tonemap(texture2D(tScene, vUv + vec2(-o.x, -o.y)).rgb) + tonemap(texture2D(tScene, vUv + vec2(o.x, -o.y)).rgb)
              + tonemap(texture2D(tScene, vUv + vec2(-o.x, o.y)).rgb) + tonemap(texture2D(tScene, vUv + vec2(o.x, o.y)).rgb));
  } else {
    c = tonemap(texture2D(tScene, vUv).rgb);
  }
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;   // dither the dark gradients of space
  gl_FragColor = vec4(c, 1.0);
}
`;
