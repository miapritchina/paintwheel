// Paint definitions with Kubelka-Munk absorption (K) and scattering (S).
//
// PAINTBOX is the artist's full collection (from their hand-painted paint
// wheel, identified by Colour Index codes). PIGMENTS is the active working
// palette: 8 paints selected from the box, each mapped to one texture
// channel in the simulation (2 RGBA pairs).
//
// Per paint:
//   w, b  - mass tone over white / undertone over black; K,S are inverted
//           from these via Curtis et al. 1997 Appendix A
//   tint  - tinting strength: scales K and S. This is what makes a touch of
//           Prussian Blue overpower a pool of yellow while Potters Pink
//           barely tints a mix.
//   rho   - density: deposition (settling) rate
//   omega - staining (>=1): divides re-lifting once deposited
//   gamma - granulation: settles into paper-texture valleys
//
// "Tuning a paint" = adjusting these six knobs plus the two colors. New
// "brands" are just alternate parameter sets for the same hue.

'use strict';

const PIG_TEXTURES = 2; // 8 working colors: 2 RGBA pairs (suspended+deposited)

const { PAINTBOX, PIGMENTS, setActivePalette } = (() => {
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

  const defs = [
    { name: 'Cadmium Lemon',       short: 'Lemon',    ci: 'PY35',  w: '#efe049', b: '#4e4a16', tint: 1.0,  rho: 0.07, omega: 1.2, gamma: 0.15 },
    { name: 'Cadmium Yellow Med.', short: 'Cad Yel',  ci: 'PY35',  w: '#f0c020', b: '#463409', tint: 1.0,  rho: 0.07, omega: 1.2, gamma: 0.20 },
    { name: 'Irgazin Yellow',      short: 'Irgazin',  ci: 'PY129', w: '#d9a916', b: '#201703', tint: 1.5,  rho: 0.03, omega: 2.5, gamma: 0.10 },
    { name: 'Raw Siena',           short: 'Raw Sien', ci: 'PBr7',  w: '#b98a3a', b: '#271a08', tint: 0.8,  rho: 0.07, omega: 1.5, gamma: 0.70 },
    { name: 'Italian Burnt Siena', short: 'B. Siena', ci: 'PBr7',  w: '#b46325', b: '#1f0f05', tint: 0.9,  rho: 0.06, omega: 2.0, gamma: 0.65 },
    { name: 'Titian Red',          short: 'Titian',   ci: 'PO36',  w: '#d96a2e', b: '#2a1004', tint: 1.2,  rho: 0.04, omega: 2.0, gamma: 0.30 },
    { name: 'Cadmium Red Light',   short: 'Cad Red',  ci: 'PR108', w: '#d94f2a', b: '#3c1007', tint: 1.0,  rho: 0.07, omega: 1.3, gamma: 0.35 },
    { name: 'Pyrrole Scarlet',     short: 'Pyrrole',  ci: 'PR255', w: '#d63c2a', b: '#2b0a06', tint: 1.5,  rho: 0.03, omega: 4.0, gamma: 0.20 },
    { name: 'Carmine',             short: 'Carmine',  ci: 'PR176', w: '#b62245', b: '#22040c', tint: 1.8,  rho: 0.02, omega: 5.0, gamma: 0.10 },
    { name: 'Opera Rose',          short: 'Opera',    ci: 'PR122+',w: '#e0447f', b: '#2a0715', tint: 2.0,  rho: 0.02, omega: 5.0, gamma: 0.05 },
    { name: 'Quinacridone Pink',   short: 'Q. Pink',  ci: 'PR122', w: '#c93a86', b: '#1e0616', tint: 2.0,  rho: 0.02, omega: 5.5, gamma: 0.08 },
    { name: 'Potters Pink',        short: 'Potters',  ci: 'PR233', w: '#c98d92', b: '#3a2426', tint: 0.35, rho: 0.08, omega: 1.0, gamma: 0.95 },
    { name: 'Dioxazine Purple',    short: 'Diox.',    ci: 'PV23',  w: '#7a52b5', b: '#12081f', tint: 2.2,  rho: 0.02, omega: 6.0, gamma: 0.15 },
    { name: 'Ultramarine Violet',  short: 'U. Violet',ci: 'PV15',  w: '#7a6ab8', b: '#191430', tint: 0.7,  rho: 0.06, omega: 1.5, gamma: 0.80 },
    { name: 'Ultramarine',         short: 'Ultram.',  ci: 'PB29',  w: '#3b4fc0', b: '#0a0d2e', tint: 1.1,  rho: 0.05, omega: 3.1, gamma: 0.91 },
    { name: 'Cobalt Blue',         short: 'Cobalt',   ci: 'PB28',  w: '#4a68c8', b: '#0c1233', tint: 0.9,  rho: 0.06, omega: 1.3, gamma: 0.75 },
    { name: 'Cobalt Sea Blue',     short: 'C. Sea',   ci: 'PB28+', w: '#2f6fa8', b: '#0a1a2a', tint: 0.9,  rho: 0.07, omega: 1.3, gamma: 0.80 },
    { name: 'Phthalo Blue',        short: 'Phthalo',  ci: 'PB15:3',w: '#1a5fb0', b: '#04101f', tint: 3.0,  rho: 0.02, omega: 6.0, gamma: 0.05 },
    { name: 'Prussian Blue',       short: 'Prussian', ci: 'PB27',  w: '#2e4a6b', b: '#050a12', tint: 3.0,  rho: 0.02, omega: 6.5, gamma: 0.15 },
    { name: 'Cobalt Turquoise',    short: 'C. Turq',  ci: 'PB36',  w: '#45a8b8', b: '#0d2a2e', tint: 0.8,  rho: 0.08, omega: 1.2, gamma: 0.85 },
    { name: 'Emerald Green',       short: 'Emerald',  ci: 'PG7+',  w: '#46b48f', b: '#0a2419', tint: 2.2,  rho: 0.04, omega: 2.0, gamma: 0.30 },
    { name: 'Green',               short: 'Green',    ci: 'PG8',   w: '#567f36', b: '#0c1607', tint: 1.8,  rho: 0.04, omega: 3.0, gamma: 0.35 },
  ];

  // KM reflectance of a layer of thickness x over near-white, for swatches.
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

  const box = defs.map((d, id) => {
    const { K, S } = ksFrom(lin(hex(d.w)), lin(hex(d.b)));
    // tinting strength scales optical power per unit concentration
    for (let i = 0; i < 3; i++) { K[i] *= d.tint; S[i] *= d.tint; }
    return {
      id, name: d.name, short: d.short, ci: d.ci, K, S,
      tint: d.tint, rho: d.rho, omega: d.omega, gamma: d.gamma,
      // pans show the darkest possible mass tone, like real dried pans
      swatch: kmMix(K, S, 14.0),
    };
  });

  const active = [];
  active.version = 0;
  active.ids = [];
  active.kmColor = (parts, x = 8.0) => {
    const K = [0, 0, 0], S = [0, 0, 0];
    let total = 0;
    parts.forEach((p) => { total += p; });
    if (total <= 0) return 'rgb(240,238,232)';
    parts.forEach((p, i) => {
      if (!active[i]) return;
      const c = p / total;
      for (let j = 0; j < 3; j++) { K[j] += c * active[i].K[j]; S[j] += c * active[i].S[j]; }
    });
    return kmMix(K, S, x);
  };

  function setPalette(ids) {
    active.splice(0, active.length, ...ids.map((i) => box[i]));
    active.ids = ids.slice();
    active.version++;
  }

  // default working palette, tuned to the artist's landscape/abstract style
  setPalette([
    box.findIndex((p) => p.short === 'Lemon'),
    box.findIndex((p) => p.short === 'Irgazin'),
    box.findIndex((p) => p.short === 'B. Siena'),
    box.findIndex((p) => p.short === 'Q. Pink'),
    box.findIndex((p) => p.short === 'Ultram.'),
    box.findIndex((p) => p.short === 'Prussian'),
    box.findIndex((p) => p.short === 'C. Turq'),
    box.findIndex((p) => p.short === 'Emerald'),
  ]);

  return { PAINTBOX: box, PIGMENTS: active, setActivePalette: setPalette };
})();
