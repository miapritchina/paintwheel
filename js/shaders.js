// GLSL ES 3.00 shader sources for the watercolor simulation.
//
// Pipeline per frame (all fragment-shader passes over the sim grid):
//   1. velocity  - shallow-water momentum: pressure gradient from water depth
//                  + paper relief, viscous drag, boundary outward bias
//   2. height    - continuity: move water by divergence of h*vel
//   3. moisture  - evaporation (boosted at wash edges -> edge darkening),
//                  absorption into the capillary layer of the paper
//   4. capillary - fiber wicking: saturation diffuses to neighbors; damp
//                  cells that pass the threshold rejoin the wet mask (backruns)
//   5. advect    - semi-Lagrangian transport + diffusion of suspended pigment
//   6. transfer  - pigment deposition onto / lifting off the paper, with
//                  per-pigment density, staining and granulation
//   7. render    - Kubelka-Munk optical compositing of the 8 pigment layers
//                  over textured paper, plus wet-sheen shading
//
// State textures (RGBA16F, ping-ponged):
//   flow  : x = water height h, y = u, z = v, w = wet mask
//   sat   : x = capillary saturation, y = "was ever wet" (for drying rings)
//   suspA : suspended concentration of pigments 0..3
//   suspB : suspended concentration of pigments 4..7
//   depA  : deposited concentration of pigments 0..3
//   depB  : deposited concentration of pigments 4..7
//   paper : static; x = surface height, y = absorbency capacity, z = fiber noise

'use strict';

const SHADERS = {};

SHADERS.vert = `#version 300 es
layout(location=0) in vec2 aPos;
out vec2 vUV;
void main() {
  vUV = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const COMMON = `
precision highp float;
precision highp sampler2D;
uniform vec2 uTexel;   // 1 / grid size
uniform float uDt;
in vec2 vUV;
`;

// ---------------------------------------------------------------- paper ----
SHADERS.paper = `#version 300 es
${COMMON}
uniform float uSeed;
out vec4 frag;

float hash(vec2 p) {
  p = fract(p * vec2(234.34, 435.345) + uSeed);
  p += dot(p, p + 34.23);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    v += a * vnoise(p);
    p = p * 2.03 + 17.7;
    a *= 0.55;
  }
  return v;
}
void main() {
  vec2 p = vUV / uTexel;
  // cold-press style grain: mid-frequency bumps + fine tooth + faint fibers
  float grain = fbm(p * 0.045);
  float tooth = fbm(p * 0.35);
  float fiberH = vnoise(vec2(p.x * 0.9, p.y * 0.08));
  float fiberV = vnoise(vec2(p.x * 0.07, p.y * 0.85));
  float height = clamp(0.55 * grain + 0.35 * tooth + 0.05 * fiberH + 0.05 * fiberV, 0.0, 1.0);
  float capacity = 0.55 + 0.45 * fbm(p * 0.02 + 91.7);
  float fibers = vnoise(p * 0.6 + 3.1);
  frag = vec4(height, capacity, fibers, 1.0);
}`;

// ---------------------------------------------------------------- splat ----
// Brush dab: adds water + suspended pigment. MRT: flow, suspA, suspB.
SHADERS.splat = `#version 300 es
${COMMON}
uniform sampler2D uFlow;
uniform sampler2D uSuspA;
uniform sampler2D uSuspB;
uniform sampler2D uPaper;
uniform vec2 uCenter;      // uv
uniform float uRadius;     // uv units (x-scaled)
uniform vec2 uAspect;      // to make round dabs on non-square grids
uniform float uWaterAmt;
uniform vec4 uPigA;
uniform vec4 uPigB;
uniform float uWetness;    // 0 dry brush .. 1 flooded
layout(location=0) out vec4 oFlow;
layout(location=1) out vec4 oSuspA;
layout(location=2) out vec4 oSuspB;

void main() {
  vec4 f = texture(uFlow, vUV);
  vec4 ga = texture(uSuspA, vUV);
  vec4 gb = texture(uSuspB, vUV);
  vec4 pap = texture(uPaper, vUV);

  vec2 d = (vUV - uCenter) * uAspect;
  float r = length(d) / max(uRadius, 1e-5);
  float m = 1.0 - smoothstep(0.55, 1.0, r);

  // Dry-brush: with little water the brush only touches the raised tooth of
  // the paper; with lots of water it floods the valleys too.
  float contact = smoothstep(pap.x - 0.55, pap.x + 0.1, uWetness * 1.25 + 0.15);
  m *= mix(contact, 1.0, smoothstep(0.75, 1.0, uWetness));
  // slightly ragged rim following paper fibers
  m *= 0.75 + 0.5 * pap.z;

  if (m > 0.0) {
    f.x += uWaterAmt * m;
    f.w = max(f.w, smoothstep(0.0, 0.08, m * uWaterAmt * 40.0));
    ga += uPigA * m;
    gb += uPigB * m;
  }
  oFlow = f;
  oSuspA = ga;
  oSuspB = gb;
}`;

// ------------------------------------------------------------- velocity ----
SHADERS.velocity = `#version 300 es
${COMMON}
uniform sampler2D uFlow;
uniform sampler2D uPaper;
uniform float uGrav;       // pull of water-surface slope
uniform float uPaperSlope; // influence of paper relief on flow
uniform float uVisc;       // drag
uniform float uEdgeFlow;   // outward bias at wash boundary (edge darkening)
uniform float uMaxSpeed;
out vec4 frag;

void main() {
  vec4 f = texture(uFlow, vUV);
  float h = f.x;
  vec2 vel = f.yz;
  float w = f.w;

  vec4 fl = texture(uFlow, vUV - vec2(uTexel.x, 0.0));
  vec4 fr = texture(uFlow, vUV + vec2(uTexel.x, 0.0));
  vec4 fb = texture(uFlow, vUV - vec2(0.0, uTexel.y));
  vec4 ft = texture(uFlow, vUV + vec2(0.0, uTexel.y));

  float pl = texture(uPaper, vUV - vec2(uTexel.x, 0.0)).x;
  float pr = texture(uPaper, vUV + vec2(uTexel.x, 0.0)).x;
  float pb = texture(uPaper, vUV - vec2(0.0, uTexel.y)).x;
  float pt = texture(uPaper, vUV + vec2(0.0, uTexel.y)).x;

  // water surface = depth + scaled paper relief
  vec2 grad = 0.5 * vec2((fr.x + pr * uPaperSlope) - (fl.x + pl * uPaperSlope),
                         (ft.x + pt * uPaperSlope) - (fb.x + pb * uPaperSlope));
  vel += -uGrav * uDt * grad;

  // outward drift at the wash boundary: evaporation at the edge pulls water
  // (and pigment) from the interior toward the rim -> dark edges when dry
  float wavg = 0.25 * (fl.w + fr.w + ft.w + fb.w);
  vec2 gw = 0.5 * vec2(fr.w - fl.w, ft.w - fb.w);
  vel += -uEdgeFlow * uDt * gw * smoothstep(0.0, 0.01, h);

  vel *= clamp(1.0 - uVisc * uDt, 0.0, 1.0);

  // no flow outside the wet region or in a nearly-dry film
  vel *= w * smoothstep(0.0005, 0.006, h);

  float sp = length(vel);
  if (sp > uMaxSpeed) vel *= uMaxSpeed / sp;

  frag = vec4(h, vel, w);
}`;

// --------------------------------------------------------------- height ----
SHADERS.height = `#version 300 es
${COMMON}
uniform sampler2D uFlow;
uniform float uSmooth;
out vec4 frag;

void main() {
  vec4 f = texture(uFlow, vUV);
  vec4 fl = texture(uFlow, vUV - vec2(uTexel.x, 0.0));
  vec4 fr = texture(uFlow, vUV + vec2(uTexel.x, 0.0));
  vec4 fb = texture(uFlow, vUV - vec2(0.0, uTexel.y));
  vec4 ft = texture(uFlow, vUV + vec2(0.0, uTexel.y));

  // continuity: dh/dt = -div(h * vel), central differences
  float div = 0.5 * ((fr.x * fr.y - fl.x * fl.y) + (ft.x * ft.z - fb.x * fb.z));
  float h = f.x - uDt * div;

  // small diffusion keeps the explicit scheme stable and mimics surface tension
  float avg = 0.25 * (fl.x + fr.x + fb.x + ft.x);
  h = mix(h, avg, uSmooth * f.w);

  frag = vec4(max(h, 0.0), f.yz, f.w);
}`;

// ------------------------------------------------------------- moisture ----
// Evaporation + absorption into paper. MRT: flow, sat.
SHADERS.moisture = `#version 300 es
${COMMON}
uniform sampler2D uFlow;
uniform sampler2D uSat;
uniform sampler2D uPaper;
uniform float uEvap;
uniform float uEdgeEvap;   // extra evaporation at wash edges
uniform float uAbsorb;
uniform float uSatEvap;
uniform float uWetThresh;
layout(location=0) out vec4 oFlow;
layout(location=1) out vec4 oSat;

void main() {
  vec4 f = texture(uFlow, vUV);
  vec4 s = texture(uSat, vUV);
  vec4 pap = texture(uPaper, vUV);
  float h = f.x;
  float w = f.w;

  float wavg = 0.0;
  for (int j = -1; j <= 1; j++)
    for (int i = -1; i <= 1; i++)
      wavg += texture(uFlow, vUV + vec2(float(i), float(j)) * uTexel * 2.0).w;
  wavg /= 9.0;
  float edge = clamp(w - wavg, 0.0, 1.0); // ~0 inside wash, >0 at rim

  // evaporation, faster at the rim (thin film, more exposed perimeter)
  h -= uDt * uEvap * (1.0 + uEdgeEvap * edge) * smoothstep(0.0, 0.0005, h);

  // absorption into the sheet, limited by local fiber capacity
  float cap = pap.y;
  float absorb = min(uAbsorb * uDt * max(cap - s.x, 0.0), max(h, 0.0));
  s.x += absorb;
  h -= absorb;
  h = max(h, 0.0);

  // wet mask follows surface water; a damp (saturated) cell stays semi-wet
  if (h > uWetThresh) {
    w = min(w + uDt * 6.0, 1.0);
  } else {
    float damp = smoothstep(0.05, 0.5, s.x);
    w = max(w - uDt * 0.9 * (1.0 - 0.7 * damp), 0.0);
  }
  // paper itself slowly dries
  s.x = max(s.x - uDt * uSatEvap, 0.0);
  s.y = max(s.y, w);

  oFlow = vec4(h, f.yz, w);
  oSat = s;
}`;

// ------------------------------------------------------------ capillary ----
// Wicking through fibers; re-wetted damp cells create backruns. MRT: flow, sat.
SHADERS.capillary = `#version 300 es
${COMMON}
uniform sampler2D uFlow;
uniform sampler2D uSat;
uniform sampler2D uPaper;
uniform float uWick;        // wicking rate
uniform float uWickThresh;  // saturation needed before a cell wicks outward
uniform float uBackrun;     // threshold at which a wicked cell rejoins wet mask
layout(location=0) out vec4 oFlow;
layout(location=1) out vec4 oSat;

void main() {
  vec4 f = texture(uFlow, vUV);
  vec4 s = texture(uSat, vUV);
  float cap = texture(uPaper, vUV).y;

  float transfer = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 off = k == 0 ? vec2(uTexel.x, 0.0) : k == 1 ? vec2(-uTexel.x, 0.0)
             : k == 2 ? vec2(0.0, uTexel.y) : vec2(0.0, -uTexel.y);
    float sn = texture(uSat, vUV + off).x;
    // fibers pull water from the more saturated cell toward the drier one
    if (sn > uWickThresh) transfer += max(sn - s.x, 0.0);
    if (s.x > uWickThresh) transfer -= max(s.x - sn, 0.0);
  }
  s.x = clamp(s.x + uWick * uDt * transfer, 0.0, cap * 1.2);

  // backrun: capillary water sneaking into a drying wash re-wets it and
  // releases a little free water that shoves pigment ahead of the front
  if (s.x > uBackrun && f.w < 0.6) {
    f.w = max(f.w, 0.65);
    f.x += uDt * 0.35 * (s.x - uBackrun);
    s.x -= uDt * 0.3 * (s.x - uBackrun);
  }
  oFlow = f;
  oSat = s;
}`;

// --------------------------------------------------------------- advect ----
// Semi-Lagrangian pigment transport + Fickian diffusion. MRT: suspA, suspB.
SHADERS.advect = `#version 300 es
${COMMON}
uniform sampler2D uFlow;
uniform sampler2D uSuspA;
uniform sampler2D uSuspB;
uniform float uPigDiff;
layout(location=0) out vec4 oSuspA;
layout(location=1) out vec4 oSuspB;

void main() {
  vec4 f = texture(uFlow, vUV);
  vec2 back = vUV - f.yz * uDt * uTexel;
  vec4 ga = texture(uSuspA, back);
  vec4 gb = texture(uSuspB, back);

  // diffusion only where there is enough free water to brown-move in
  float mob = f.w * smoothstep(0.0005, 0.01, f.x);
  if (mob > 0.0) {
    vec4 aavg = vec4(0.0), bavg = vec4(0.0);
    for (int k = 0; k < 4; k++) {
      vec2 off = k == 0 ? vec2(uTexel.x, 0.0) : k == 1 ? vec2(-uTexel.x, 0.0)
               : k == 2 ? vec2(0.0, uTexel.y) : vec2(0.0, -uTexel.y);
      // pigment can only diffuse into wet cells
      float wn = texture(uFlow, vUV + off).w;
      aavg += mix(ga, texture(uSuspA, vUV + off), wn);
      bavg += mix(gb, texture(uSuspB, vUV + off), wn);
    }
    ga = mix(ga, aavg * 0.25, uPigDiff * uDt * mob);
    gb = mix(gb, bavg * 0.25, uPigDiff * uDt * mob);
  }
  oSuspA = ga;
  oSuspB = gb;
}`;

// ------------------------------------------------------------- transfer ----
// Deposition / lifting between suspension and paper surface.
// MRT: suspA, suspB, depA, depB.
SHADERS.transfer = `#version 300 es
${COMMON}
uniform sampler2D uFlow;
uniform sampler2D uPaper;
uniform sampler2D uSuspA;
uniform sampler2D uSuspB;
uniform sampler2D uDepA;
uniform sampler2D uDepB;
uniform vec4 uRhoA, uRhoB;       // density: settle rate
uniform vec4 uOmegaA, uOmegaB;   // staining power (>= 1): divides re-lifting
uniform vec4 uGammaA, uGammaB;   // granulation: paper height modulates rates
uniform float uSettle;           // global time scale on Curtis' per-step rates
uniform float uLift;
layout(location=0) out vec4 oSuspA;
layout(location=1) out vec4 oSuspB;
layout(location=2) out vec4 oDepA;
layout(location=3) out vec4 oDepB;

void main() {
  vec4 f = texture(uFlow, vUV);
  vec4 pap = texture(uPaper, vUV);
  vec4 ga = texture(uSuspA, vUV);
  vec4 gb = texture(uSuspB, vUV);
  vec4 da = texture(uDepA, vUV);
  vec4 db = texture(uDepB, vUV);

  float h = f.x;
  float w = f.w;
  float ph = pap.x;

  // Curtis et al. 1997 Section 4.5, run only inside the wet mask:
  //   down = g * (1 - h_paper * gamma) * rho
  //   up   = d * (1 + (h_paper - 1) * gamma) * rho / omega
  // Granulating pigments (high gamma) settle into valleys (low paper height)
  // and are lifted mostly off the peaks; staining pigments (high omega)
  // barely lift once deposited.
  float dtn = uDt * uSettle;
  // As the wash loses its free water, settle rate ramps up so everything in
  // suspension lands where it stands (drying), and lifting shuts off.
  float dryBoost = 1.0 + 8.0 * (1.0 - smoothstep(0.0, 0.01, h));
  float liftGate = uLift * w * smoothstep(0.002, 0.015, h) * (0.3 + length(f.yz) * 2.0);

  vec4 downA = ga * clamp((vec4(1.0) - ph * uGammaA) * uRhoA * dtn * dryBoost, 0.0, 1.0) * max(w, 0.35);
  vec4 downB = gb * clamp((vec4(1.0) - ph * uGammaB) * uRhoB * dtn * dryBoost, 0.0, 1.0) * max(w, 0.35);
  vec4 upA = da * clamp((vec4(1.0) + (ph - 1.0) * uGammaA) * uRhoA / uOmegaA * dtn * liftGate, 0.0, 1.0);
  vec4 upB = db * clamp((vec4(1.0) + (ph - 1.0) * uGammaB) * uRhoB / uOmegaB * dtn * liftGate, 0.0, 1.0);

  // Curtis clamps both reservoirs to 1 (a full monolayer)
  downA = min(downA, max(vec4(1.0) - da, 0.0));
  downB = min(downB, max(vec4(1.0) - db, 0.0));
  upA = min(upA, max(vec4(1.0) - ga, 0.0));
  upB = min(upB, max(vec4(1.0) - gb, 0.0));

  oSuspA = ga - downA + upA;
  oSuspB = gb - downB + upB;
  oDepA = da + downA - upA;
  oDepB = db + downB - upB;
}`;

// --------------------------------------------------------------- render ----
SHADERS.render = `#version 300 es
${COMMON}
uniform sampler2D uFlow;
uniform sampler2D uSat;
uniform sampler2D uPaper;
uniform sampler2D uSuspA;
uniform sampler2D uSuspB;
uniform sampler2D uDepA;
uniform sampler2D uDepB;
uniform vec3 uK[8];
uniform vec3 uS[8];
out vec4 frag;

// Kubelka-Munk reflectance & transmittance of one pigment layer over a
// substrate. K,S here are already scaled by concentration (optical depth).
void km(vec3 K, vec3 S, out vec3 R, out vec3 T) {
  vec3 a = (K + S) / max(S, vec3(1e-6));
  vec3 b = sqrt(max(a * a - vec3(1.0), vec3(1e-8)));
  vec3 c = clamp(b * S, vec3(0.0), vec3(20.0)); // clamp: layer already opaque
  vec3 sh = sinh(c), ch = cosh(c);
  vec3 denom = a * sh + b * ch;
  R = sh / denom;
  T = b / denom;
}

void main() {
  vec4 f = texture(uFlow, vUV);
  vec4 s = texture(uSat, vUV);
  vec4 pap = texture(uPaper, vUV);
  vec4 ga = texture(uSuspA, vUV);
  vec4 gb = texture(uSuspB, vUV);
  vec4 da = texture(uDepA, vUV);
  vec4 db = texture(uDepB, vUV);

  // total optical thickness per pigment (suspended + deposited)
  float x[8];
  x[0]=ga.x+da.x; x[1]=ga.y+da.y; x[2]=ga.z+da.z; x[3]=ga.w+da.w;
  x[4]=gb.x+db.x; x[5]=gb.y+db.y; x[6]=gb.z+db.z; x[7]=gb.w+db.w;

  vec3 K = vec3(0.0), S = vec3(0.0);
  float total = 0.0;
  for (int i = 0; i < 8; i++) {
    K += x[i] * uK[i];
    S += x[i] * uS[i];
    total += x[i];
  }

  // paper: warm white, shaded by grain relief
  vec2 e = uTexel;
  float hx = texture(uPaper, vUV + vec2(e.x, 0.0)).x - texture(uPaper, vUV - vec2(e.x, 0.0)).x;
  float hy = texture(uPaper, vUV + vec2(0.0, e.y)).x - texture(uPaper, vUV - vec2(0.0, e.y)).x;
  vec3 n = normalize(vec3(-hx * 2.2, -hy * 2.2, 1.0));
  vec3 lightDir = normalize(vec3(0.45, 0.55, 0.8));
  float lam = 0.88 + 0.12 * max(dot(n, lightDir), 0.0);
  vec3 Rpaper = vec3(0.94, 0.92, 0.87) * lam * (0.96 + 0.04 * pap.z);

  vec3 Rtot = Rpaper;
  if (total > 1e-5) {
    vec3 R, T;
    km(K, S + vec3(1e-5), R, T);
    Rtot = R + T * T * Rpaper / (vec3(1.0) - R * Rpaper);
  }

  // wet areas look darker & glossier
  float wetvis = clamp(f.w * 0.5 + smoothstep(0.0, 0.04, f.x) * 0.6 + s.x * 0.15, 0.0, 1.0);
  Rtot *= mix(1.0, 0.86, wetvis);

  // faint specular sheen off the water film surface
  float wx = texture(uFlow, vUV + vec2(e.x, 0.0)).x - texture(uFlow, vUV - vec2(e.x, 0.0)).x;
  float wy = texture(uFlow, vUV + vec2(0.0, e.y)).x - texture(uFlow, vUV - vec2(0.0, e.y)).x;
  vec3 wn = normalize(vec3(-wx * 30.0, -wy * 30.0, 1.0));
  float spec = pow(max(dot(wn, normalize(lightDir + vec3(0.0, 0.0, 1.0))), 0.0), 60.0);
  Rtot += spec * 0.06 * smoothstep(0.002, 0.03, f.x);

  frag = vec4(pow(clamp(Rtot, 0.0, 1.0), vec3(1.0 / 2.2)), 1.0);
}`;

// ---------------------------------------------------------------- clear ----
SHADERS.clear = `#version 300 es
${COMMON}
uniform vec4 uValue;
out vec4 frag;
void main() { frag = uValue; }`;
