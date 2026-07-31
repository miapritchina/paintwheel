// Watercolor pigment definitions with Kubelka-Munk absorption (K) and
// scattering (S) coefficients.
//
// This palette reproduces the artist's real paint wheel (see repo issue
// images): 16 single-pigment paints identified by their Colour Index codes.
// K and S are derived from two colors per paint — its mass tone over white
// (w) and its undertone over black (b) — using the inversion from Appendix A
// of Curtis et al., "Computer-Generated Watercolor" (SIGGRAPH 1997):
//   a = 0.5 * (Rw + (Rb - Rw + 1) / Rb)
//   b = sqrt(a^2 - 1)
//   S = (1/b) * arccoth((b^2 - (a - Rw)(a - 1)) / (b (1 - Rw)))
//   K = S (a - 1)
// Transparent staining paints (quinacridone, dioxazine, prussian) barely
// lighten black; opaque ones (cadmium, cobalt turquoise) do.
//
// Behavior parameters follow real pigment chemistry:
//   rho   (density)     - deposition rate
//   omega (staining, >=1) - divides re-lifting; high = stains the paper
//   gamma (granulation) - settles into paper-texture valleys
// e.g. Potters Pink PR233 is famously granulating and non-staining, while
// Quinacridone Pink PR122 is a transparent stainer that granulates not at all.

'use strict';

const PIGMENTS = (() => {
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  const arccoth = (x) => 0.5 * Math.log((x + 1) / (x - 1));

  function ksFrom(Rw, Rb) {
    const K = [0, 0, 0], S = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const rw = clamp(Rw[i], 0.005, 0.985);
      const rb = clamp(Math.min(Rb[i], rw - 0.004), 0.001, 0.98);
      const a = 0.5 * (rw + (rb - rw + 1) / rb);
      const b = Math.sqrt(Math.max(a * a - 1, 1e-8));
      const arg = (b * b - (a - rw) * (a - 1)) / (b * (1 - rw));
      S[i] = Math.max(arccoth(Math.max(arg, 1 + 1e-6)) / b, 1e-4);
      K[i] = S[i] * (a - 1);
    }
    return { K, S };
  }

  const hex = (h) => [
    parseInt(h.slice(1, 3), 16) / 255,
    parseInt(h.slice(3, 5), 16) / 255,
    parseInt(h.slice(5, 7), 16) / 255,
  ];
  const lin = (c) => c.map((v) => Math.pow(v, 2.2));

  // name, CI code, mass tone (over white), undertone (over black),
  // density, staining, granulation
  const defs = [
    { name: 'Cadmium Lemon',      ci: 'PY35',  w: '#efe049', b: '#4e4a16', rho: 0.07, omega: 1.2, gamma: 0.15 },
    { name: 'Irgazin Yellow',     ci: 'PY129', w: '#d9a916', b: '#201703', rho: 0.03, omega: 2.5, gamma: 0.10 },
    { name: 'Raw Siena',          ci: 'PBr7',  w: '#b98a3a', b: '#271a08', rho: 0.07, omega: 1.5, gamma: 0.70 },
    { name: 'Italian Burnt Siena',ci: 'PBr7',  w: '#b46325', b: '#1f0f05', rho: 0.06, omega: 2.0, gamma: 0.65 },
    { name: 'Titian Red',         ci: 'PO36',  w: '#d96a2e', b: '#2a1004', rho: 0.04, omega: 2.0, gamma: 0.30 },
    { name: 'Pyrrole Scarlet',    ci: 'PR255', w: '#d63c2a', b: '#2b0a06', rho: 0.03, omega: 4.0, gamma: 0.20 },
    { name: 'Carmine',            ci: 'PR176', w: '#b62245', b: '#22040c', rho: 0.02, omega: 5.0, gamma: 0.10 },
    { name: 'Quinacridone Pink',  ci: 'PR122', w: '#c93a86', b: '#1e0616', rho: 0.02, omega: 5.5, gamma: 0.08 },
    { name: 'Potters Pink',       ci: 'PR233', w: '#c98d92', b: '#3a2426', rho: 0.08, omega: 1.0, gamma: 0.95 },
    { name: 'Dioxazine Purple',   ci: 'PV23',  w: '#7a52b5', b: '#12081f', rho: 0.02, omega: 6.0, gamma: 0.15 },
    { name: 'Ultramarine',        ci: 'PB29',  w: '#3b4fc0', b: '#0a0d2e', rho: 0.05, omega: 3.1, gamma: 0.91 },
    { name: 'Cobalt Blue',        ci: 'PB28',  w: '#4a68c8', b: '#0c1233', rho: 0.06, omega: 1.3, gamma: 0.75 },
    { name: 'Prussian Blue',      ci: 'PB27',  w: '#2e4a6b', b: '#050a12', rho: 0.02, omega: 6.5, gamma: 0.15 },
    { name: 'Cobalt Turquoise',   ci: 'PB36',  w: '#45a8b8', b: '#0d2a2e', rho: 0.08, omega: 1.2, gamma: 0.85 },
    { name: 'Emerald Green',      ci: 'PG7+',  w: '#46b48f', b: '#0a2419', rho: 0.04, omega: 2.0, gamma: 0.30 },
    { name: 'Green',              ci: 'PG8',   w: '#567f36', b: '#0c1607', rho: 0.04, omega: 3.0, gamma: 0.35 },
  ];

  // KM reflectance of a layer of thickness x over white, for UI swatches.
  function kmMix(K, S, x) {
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const s = Math.max(S[i], 1e-4);
      const a = 1 + K[i] / s;
      const b = Math.sqrt(Math.max(a * a - 1, 1e-8));
      const c = Math.min(b * s * x, 20);
      const sh = Math.sinh(c), ch = Math.cosh(c);
      const R = sh / (a * sh + b * ch);
      const T = b / (a * sh + b * ch);
      const Rp = 0.92;
      const Rtot = R + (T * T * Rp) / (1 - R * Rp);
      out[i] = Math.round(255 * Math.pow(clamp(Rtot, 0, 1), 1 / 2.2));
    }
    return `rgb(${out[0]},${out[1]},${out[2]})`;
  }

  const list = defs.map((d) => {
    const { K, S } = ksFrom(lin(hex(d.w)), lin(hex(d.b)));
    return { name: d.name, ci: d.ci, K, S, rho: d.rho, omega: d.omega, gamma: d.gamma, swatch: kmMix(K, S, 8.0) };
  });

  // KM color of an arbitrary mixture: parts is an array of 16 weights.
  list.kmColor = (parts, x = 8.0) => {
    const K = [0, 0, 0], S = [0, 0, 0];
    let total = 0;
    parts.forEach((p) => { total += p; });
    if (total <= 0) return 'rgb(240,238,232)';
    parts.forEach((p, i) => {
      const c = p / total;
      for (let j = 0; j < 3; j++) { K[j] += c * list[i].K[j]; S[j] += c * list[i].S[j]; }
    });
    return kmMix(K, S, x);
  };
  return list;
})();

// Number of RGBA texture pairs used to carry pigment concentrations.
const PIG_TEXTURES = 4; // 16 pigments / 4 channels
