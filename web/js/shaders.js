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
  return uSun * sunT * (1.0 - Tv) * phaseMix(mu) * 0.25;
}

// ---- clouds ----
uniform sampler2D uCloudA;
uniform sampler2D uCloudB;
uniform float uCloudMix;
uniform float uFlowT;

float cloudRaw(sampler2D t, vec2 uv) {
  float v = texture2D(t, uv).r;
  return smoothstep(0.06, 0.82, v);
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
  float b = mix(cloudRaw(uCloudB, uv + o1), cloudRaw(uCloudB, uv + o2), w);
  return mix(a, b, uCloudMix);
}
`;

export const SPHERE_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;
void main() {
  vUv = uv;
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

  float cloud = uCloudsOn > 0.5 ? cloudAt(vUv) : 0.0;
  float shadow = 1.0;
  if (uCloudsOn > 0.5) {
    float cs = max(muS, 0.12);
    vec2 off = vec2(dot(L, east) / cosLat / (2.0 * PI), dot(L, north) / PI) * (${CLOUD_ALT.toFixed(5)} / cs);
    shadow = 1.0 - 0.55 * cloudAt(vUv + off);
  }

  vec3 col = albedo * uSun * sunT * diff * shadow;

  // Specular sun glint on water.
  vec3 H = normalize(L + V);
  float nh = max(dot(N, H), 0.0);
  float nv = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - nv, 5.0);
  float glint = pow(nh, 350.0) * 0.6 + pow(nh, 60.0) * 0.018;
  col += water * uSun * sunT * shadow * glint * (0.25 + fres) * step(0.0, muS) * (1.0 - cloud);

  // City lights on the night side, hidden by clouds.
  float night = smoothstep(0.06, -0.14, muS);
  float lights = texture2D(uLights, vUv).r;
  col += vec3(1.0, 0.74, 0.45) * lights * lights * uLightsI * night * (1.0 - 0.9 * cloud);

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
export const CLOUD_FRAG = /* glsl */ `
${COMMON}
uniform float uOpacity;
uniform vec2 uCloudTexel;
uniform float uLayer;        // 0 = base of the deck ... 1 = cloud tops
uniform float uLayerAlpha;
uniform float uShadowSteps;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vPos;

void main() {
  float c = cloudAt(vUv);
  float th = uLayer * 0.6;
  float d = smoothstep(th, th + 0.28, c);
  if (d < 0.003) discard;

  vec3 N = normalize(vN);
  vec3 V = normalize(uCamPos - vPos);
  vec3 L = uSunDir;
  vec3 eastRaw = cross(vec3(0.0, 1.0, 0.0), N);
  float cosLat = max(length(eastRaw), 0.02);
  vec3 east = eastRaw / cosLat;
  vec3 north = cross(N, east);

  // Thicker cloud bulges: the density gradient acts as a height map.
  vec2 tx = vec2(uCloudTexel.x * 1.5, 0.0), ty = vec2(0.0, uCloudTexel.y * 1.5);
  float cx = cloudAt(vUv + tx) - cloudAt(vUv - tx);
  float cy = cloudAt(vUv + ty) - cloudAt(vUv - ty);
  vec3 Nc = normalize(N - (0.25 + 0.45 * uLayer) * (cx / cosLat * east + cy * north));

  float muS = dot(N, L);
  vec3 sunT = sunTransmittance(1.4 + uLayer, muS);

  // Self-shadowing: march toward the Sun across the cloud field. Near the
  // terminator the Sun is low and towering clouds shade their neighbours.
  vec2 sunUV = vec2(dot(L, east) / cosLat / (2.0 * PI), dot(L, north) / PI);
  float occl = 0.0;
  for (int i = 1; i <= 5; i++) {
    if (float(i) > uShadowSteps) break;
    float fi = float(i);
    occl += smoothstep(th, th + 0.4, cloudAt(vUv + sunUV * fi * 0.0028)) * (1.0 - 0.12 * fi);
  }
  float selfShadow = exp(-occl * 0.55 * (1.1 - uLayer));

  float lit = clamp((dot(Nc, L) + 0.15) / 1.15, 0.0, 1.0) * smoothstep(-0.10, 0.03, muS);
  vec3 col = vec3(0.94) * uSun * sunT * lit * selfShadow * (0.72 + 0.28 * uLayer);
  // Blue skylight fills the shaded sides so they are not black.
  col += vec3(0.020, 0.032, 0.055) * uSun * sunT * smoothstep(-0.05, 0.4, muS);
  // Silver lining when looking toward the Sun through thin edges.
  float fwd = pow(max(dot(-V, L), 0.0), 8.0);
  col += uSun * sunT * fwd * (1.0 - d) * 0.6;

  float nv = max(dot(N, V), 0.0);
  vec3 Tv = exp(-TAU_E * chapman(1.4 + uLayer, nv));
  col = col * Tv + inscatter(Tv, sunT, dot(-V, L));

  gl_FragColor = vec4(col, d * uOpacity * uLayerAlpha);
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
varying vec2 vUv;
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec3 c = texture2D(tScene, vUv).rgb * uExposure;
  c = aces(c);
  c = pow(c, vec3(1.0 / 2.2));
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;   // dither the dark gradients of space
  gl_FragColor = vec4(c, 1.0);
}
`;
