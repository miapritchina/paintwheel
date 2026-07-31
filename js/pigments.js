// Paint definitions with Kubelka-Munk absorption (K) and scattering (S).
//
// PAINTBOX  - the artist's full collection (from their hand-painted wheel).
// CHANNELS  - 16 simulation channels (4 RGBA texture pairs). Each channel is
//             bound to one paint. Pans reference channels; swapping a pan's
//             paint allocates a NEW channel, so strokes already on paper
//             keep the old paint's identity and color.
// PANS      - the 8 working pans: { paint, chan }.
//
// Per paint:
//   w, b   - mass tone over white / undertone over black -> K,S via the
//            inversion in Curtis et al. 1997 Appendix A
//   tint   - tinting strength: scales K,S (Prussian overpowers yellow)
//   rho    - density: settling rate
//   omega  - staining (>=1): divides re-lifting once deposited
//   gamma  - granulation strength: settles into paper-texture valleys
//   grain  - granulation SIZE: 0 = fine speckle following the paper tooth,
//            1 = coarse flocs following the big grain structure

'use strict';

const PIG_TEXTURES = 4;
const N_CHANNELS = PIG_TEXTURES * 4;

const { PAINTBOX, CHANNELS, PANS, assignPan } = (() => {
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
    { name: 'Cadmium Lemon',       short: 'Lemon',    ci: 'PY35',  w: '#efe049', b: '#4e4a16', tint: 1.0,  rho: 0.07, omega: 1.2, gamma: 0.15, grain: 0.2 },
    { name: 'Cadmium Yellow Med.', short: 'Cad Yel',  ci: 'PY35',  w: '#f0c020', b: '#463409', tint: 1.0,  rho: 0.07, omega: 1.2, gamma: 0.20, grain: 0.25 },
    { name: 'Irgazin Yellow',      short: 'Irgazin',  ci: 'PY129', w: '#d9a916', b: '#201703', tint: 1.5,  rho: 0.03, omega: 2.5, gamma: 0.10, grain: 0.1 },
    { name: 'Raw Siena',           short: 'Raw Sien', ci: 'PBr7',  w: '#b98a3a', b: '#271a08', tint: 0.8,  rho: 0.07, omega: 1.5, gamma: 0.70, grain: 0.5 },
    { name: 'Italian Burnt Siena', short: 'B. Siena', ci: 'PBr7',  w: '#b46325', b: '#1f0f05', tint: 0.9,  rho: 0.06, omega: 2.0, gamma: 0.65, grain: 0.5 },
    { name: 'Titian Red',          short: 'Titian',   ci: 'PO36',  w: '#d96a2e', b: '#2a1004', tint: 1.2,  rho: 0.04, omega: 2.0, gamma: 0.30, grain: 0.3 },
    { name: 'Cadmium Red Light',   short: 'Cad Red',  ci: 'PR108', w: '#d94f2a', b: '#3c1007', tint: 1.0,  rho: 0.07, omega: 1.3, gamma: 0.35, grain: 0.3 },
    { name: 'Pyrrole Scarlet',     short: 'Pyrrole',  ci: 'PR255', w: '#d63c2a', b: '#2b0a06', tint: 1.5,  rho: 0.03, omega: 4.0, gamma: 0.20, grain: 0.15 },
    { name: 'Carmine',             short: 'Carmine',  ci: 'PR176', w: '#b62245', b: '#22040c', tint: 1.8,  rho: 0.02, omega: 5.0, gamma: 0.10, grain: 0.1 },
    { name: 'Opera Rose',          short: 'Opera',    ci: 'PR122+',w: '#e0447f', b: '#2a0715', tint: 2.0,  rho: 0.02, omega: 5.0, gamma: 0.05, grain: 0.1 },
    { name: 'Quinacridone Pink',   short: 'Q. Pink',  ci: 'PR122', w: '#c93a86', b: '#1e0616', tint: 2.0,  rho: 0.02, omega: 5.5, gamma: 0.08, grain: 0.1 },
    { name: 'Potters Pink',        short: 'Potters',  ci: 'PR233', w: '#c98d92', b: '#3a2426', tint: 0.35, rho: 0.08, omega: 1.0, gamma: 0.95, grain: 0.75 },
    { name: 'Dioxazine Purple',    short: 'Diox.',    ci: 'PV23',  w: '#7a52b5', b: '#12081f', tint: 2.2,  rho: 0.02, omega: 6.0, gamma: 0.15, grain: 0.1 },
    { name: 'Ultramarine Violet',  short: 'U. Violet',ci: 'PV15',  w: '#7a6ab8', b: '#191430', tint: 0.7,  rho: 0.06, omega: 1.5, gamma: 0.80, grain: 0.7 },
    { name: 'Ultramarine',         short: 'Ultram.',  ci: 'PB29',  w: '#3b4fc0', b: '#0a0d2e', tint: 1.1,  rho: 0.05, omega: 3.1, gamma: 0.91, grain: 0.9 },
    { name: 'Cobalt Blue',         short: 'Cobalt',   ci: 'PB28',  w: '#4a68c8', b: '#0c1233', tint: 0.9,  rho: 0.06, omega: 1.3, gamma: 0.75, grain: 0.6 },
    { name: 'Cobalt Sea Blue',     short: 'C. Sea',   ci: 'PB28+', w: '#2f6fa8', b: '#0a1a2a', tint: 0.9,  rho: 0.07, omega: 1.3, gamma: 0.80, grain: 0.6 },
    { name: 'Phthalo Blue',        short: 'Phthalo',  ci: 'PB15:3',w: '#1a5fb0', b: '#04101f', tint: 3.0,  rho: 0.02, omega: 6.0, gamma: 0.05, grain: 0.05 },
    { name: 'Prussian Blue',       short: 'Prussian', ci: 'PB27',  w: '#2e4a6b', b: '#050a12', tint: 3.0,  rho: 0.02, omega: 6.5, gamma: 0.15, grain: 0.1 },
    { name: 'Cobalt Turquoise',    short: 'C. Turq',  ci: 'PB36',  w: '#45a8b8', b: '#0d2a2e', tint: 0.8,  rho: 0.08, omega: 1.2, gamma: 0.85, grain: 0.7 },
    { name: 'Emerald Green',       short: 'Emerald',  ci: 'PG7+',  w: '#46b48f', b: '#0a2419', tint: 2.2,  rho: 0.04, omega: 2.0, gamma: 0.30, grain: 0.25 },
    { name: 'Green',               short: 'Green',    ci: 'PG8',   w: '#567f36', b: '#0c1607', tint: 1.8,  rho: 0.04, omega: 3.0, gamma: 0.35, grain: 0.25 },
  ];

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
    for (let i = 0; i < 3; i++) { K[i] *= d.tint; S[i] *= d.tint; }
    return {
      id, name: d.name, short: d.short, ci: d.ci, K, S,
      tint: d.tint, rho: d.rho, omega: d.omega, gamma: d.gamma, grain: d.grain,
      swatch: kmMix(K, S, 14.0), // pans show the darkest possible mass tone
    };
  });

  const channels = new Array(N_CHANNELS).fill(null);
  channels.version = 0;
  channels.kmColor = (parts, x = 8.0) => {
    const K = [0, 0, 0], S = [0, 0, 0];
    let total = 0;
    parts.forEach((p) => { total += p; });
    if (total <= 0) return 'rgb(240,238,232)';
    parts.forEach((p, i) => {
      if (!channels[i] || p <= 0) return;
      const c = p / total;
      for (let j = 0; j < 3; j++) { K[j] += c * channels[i].K[j]; S[j] += c * channels[i].S[j]; }
    });
    return kmMix(K, S, x);
  };

  const pans = [];

  // Bind a paint to a pan. Reuses the paint's existing channel if it already
  // has one (strokes match); otherwise takes a free channel; as a last
  // resort recycles the oldest channel no pan references (its old strokes
  // would recolor — with 16 channels and 8 pans that needs 8+ swaps).
  function assign(slot, paintId) {
    const paint = box[paintId];
    let chan = channels.findIndex((c) => c && c.id === paintId);
    if (chan < 0) chan = channels.findIndex((c) => c === null);
    if (chan < 0) {
      const used = new Set(pans.map((p) => p.chan));
      chan = channels.findIndex((_, i) => !used.has(i));
      if (chan < 0) chan = 0;
    }
    channels[chan] = paint;
    pans[slot] = { paint, chan };
    channels.version++;
  }

  // default working palette (artist will finalize later)
  ['Lemon', 'Irgazin', 'B. Siena', 'Q. Pink', 'Ultram.', 'Prussian', 'C. Turq', 'Emerald']
    .forEach((short, slot) => assign(slot, box.findIndex((p) => p.short === short)));

  return { PAINTBOX: box, CHANNELS: channels, PANS: pans, assignPan: assign };
})();
