// Paint definitions with Kubelka-Munk absorption (K) and scattering (S).
//
// PAINTBOX  - the artist's full collection (from their hand-painted wheel).
// CHANNELS  - 12 simulation channels (3 RGBA texture pairs), one per pan.
// PANS      - the 12 working pans: { paint, chan }, where chan === slot.
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
//   metal  - 0 = ordinary transparent watercolor (Kubelka-Munk optics);
//            >0 = metallic/mica paint, which is not transparent at all: it
//            lies ON TOP as opaque flakes that catch the light. Rendered as
//            a covering layer with a glint instead of an absorbing one.

'use strict';

// A pan IS a channel: slot i always paints with channel i. Swapping a pan's
// paint therefore recolours earlier strokes made with the paint that left —
// the alternative was spare channels nobody paints with, at a quarter of
// every simulation step.
//
// The palette's SIZE is variable, and the cost of it comes in blocks of
// four, because one RGBA texture carries four channels:
//     1-4 colours  -> 1 texture pair
//     5-8 colours  -> 2
//     9-12 colours -> 3
// So a three-colour painting runs a third of the pigment work of a twelve,
// and adding a fourth colour to it is free. Crossing a boundary (4 -> 5)
// allocates another pair and recompiles the pigment shaders, which the
// engine can do without disturbing the painting.
const MAX_CHANNELS = 12;
const N_CHANNELS = MAX_CHANNELS; // JS-side arrays are always full size
let PIG_TEXTURES = 3;            // texture pairs actually allocated
const texturesFor = (colours) => Math.max(1, Math.ceil(colours / 4));

const { PAINTBOX, CHANNELS, PANS, assignPan, restoreBindings, setPalette, addPan, removePan } = (() => {
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
    // PY129 is a green-gold: Roman Szmal's Irgazin leans distinctly green,
    // not orange. Masstone is a dark olive-gold, undertone a green-tinged
    // shadow — that green bias is what makes it mix such clean greens.
    { name: 'Irgazin Yellow',      short: 'Irgazin',  ci: 'PY129', w: '#c3b022', b: '#1b1c05', tint: 1.5,  rho: 0.03, omega: 2.5, gamma: 0.10, grain: 0.1 },
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
    // PBk11 (Mars/"lunar" black): coarse magnetite, the most violently
    // granulating pigment there is — heavy, non-staining, settles into every
    // pit of the tooth as black flecks and lifts almost completely.
    { name: 'Granulating Black',   short: 'Gran. Bk', ci: 'PBk11', w: '#3a3835', b: '#090908', tint: 1.3,  rho: 0.11, omega: 1.0, gamma: 1.0,  grain: 1.0 },
    // Metallics: mica flakes in gum, i.e. gouache, not watercolor. They
    // cover rather than glaze, sit heavy in the water, settle fast and stay
    // put — which is exactly why they work for linework over a dry wash.
    { name: 'Gold',                short: 'Gold',     ci: 'mica',  w: '#c9a227', b: '#6b5210', tint: 1.0,  rho: 0.14, omega: 3.0, gamma: 0.25, grain: 0.6, metal: 1.0 },
    { name: 'Silver',              short: 'Silver',   ci: 'mica',  w: '#c2c6cc', b: '#6e7278', tint: 1.0,  rho: 0.14, omega: 3.0, gamma: 0.25, grain: 0.6, metal: 1.0 },
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
    const metal = d.metal || 0;
    const rgb = hex(d.w);
    return {
      id, name: d.name, short: d.short, ci: d.ci, K, S,
      tint: d.tint, rho: d.rho, omega: d.omega, gamma: d.gamma, grain: d.grain,
      metal,
      mcol: lin(rgb), // the metal's own reflectance colour (linear)
      // pans show the darkest possible mass tone; a metallic pan instead
      // shows its own colour, since it never darkens by glazing
      swatch: metal > 0 ? `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})` : kmMix(K, S, 14.0),
      // A paint is not one colour, it is a range: mass tone straight from the
      // pan through to a thin wash. Dark pigments are nearly indistinguishable
      // at full strength and only show what they are when they are let down,
      // so the paint box needs the whole ramp rather than the top of it. Each
      // step is a real Kubelka-Munk render at a decreasing optical depth.
      // The dilute steps are divided by tinting strength: Prussian at three
      // times the strength of a cadmium is still solid black where the
      // cadmium has already opened up, so a fixed ramp showed four identical
      // black chips and one colour. Scaled, every paint spends its ramp
      // across the range where it actually changes.
      ramp: (metal > 0
        ? [1, 1, 0.75, 0.5, 0.28]
        : [14.0, 5.0 / d.tint, 2.0 / d.tint, 0.8 / d.tint, 0.3 / d.tint]
      ).map((x) => (metal > 0
        ? `rgb(${rgb.map((v) => Math.round(255 * Math.min(1, v * (0.5 + x * 0.7)))).join(',')})`
        : kmMix(K, S, x))),
    };
  });

  const channels = new Array(N_CHANNELS).fill(null);
  channels.version = 0;
  channels.kmColor = (parts, x = 8.0) => {
    const K = [0, 0, 0], S = [0, 0, 0];
    const mc = [0, 0, 0];
    let total = 0, metal = 0;
    parts.forEach((p) => { total += p; });
    if (total <= 0) return 'rgb(240,238,232)';
    parts.forEach((p, i) => {
      if (!channels[i] || p <= 0) return;
      const c = p / total;
      const ch = channels[i];
      for (let j = 0; j < 3; j++) { K[j] += c * ch.K[j]; S[j] += c * ch.S[j]; }
      if (ch.metal > 0) {
        metal += c * ch.metal;
        for (let j = 0; j < 3; j++) mc[j] += c * ch.metal * ch.mcol[j];
      }
    });
    const km = kmMix(K, S, x);
    if (metal < 0.02) return km;
    // metallics cover rather than glaze, so the brush shows metal, not the
    // dark absorbing colour its K/S would imply
    const base = km.match(/\d+/g).map(Number);
    const met = mc.map((v) => Math.round(255 * Math.pow(clamp(v / metal, 0, 1), 1 / 2.2)));
    const out = base.map((b, j) => Math.round(b * (1 - metal) + met[j] * metal));
    return `rgb(${out[0]},${out[1]},${out[2]})`;
  };

  // Kubelka-Munk for ONE pixel, given a per-channel optical thickness. The
  // brush preview needs to vary each pigment's concentration pixel by pixel
  // (that is what granulation IS), so the whole-mixture helper above cannot
  // do it. Mirrors the render shader, metals included: mica does not absorb
  // transparently, it covers, so it is laid over the result instead of
  // joining the mixture.
  channels.kmPixel = (conc, paperRGB) => {
    const K = [0, 0, 0], S = [0, 0, 0], mc = [0, 0, 0];
    let total = 0, metal = 0;
    for (let i = 0; i < conc.length; i++) {
      const c = conc[i];
      const ch = channels[i];
      if (!ch || c <= 0) continue;
      if (ch.metal > 0) {
        metal += c * ch.metal;
        for (let j = 0; j < 3; j++) mc[j] += c * ch.metal * ch.mcol[j];
        continue;
      }
      total += c;
      for (let j = 0; j < 3; j++) { K[j] += c * ch.K[j]; S[j] += c * ch.S[j]; }
    }
    const out = [0, 0, 0];
    for (let j = 0; j < 3; j++) {
      const Rp = paperRGB[j];
      let R = Rp;
      if (total > 1e-6) {
        const sj = Math.max(S[j], 1e-6);
        const a = 1 + K[j] / sj;
        const b = Math.sqrt(Math.max(a * a - 1, 1e-8));
        const c = Math.min(b * sj, 20);
        const sh = Math.sinh(c), ch2 = Math.cosh(c);
        const den = a * sh + b * ch2;
        const Rl = sh / den, Tl = b / den;
        R = Rl + (Tl * Tl * Rp) / (1 - Rl * Rp);
      }
      if (metal > 1e-4) {
        const cover = 1 - Math.exp(-metal * 5);
        R = R * (1 - cover) + Math.min(1, mc[j] / metal) * cover;
      }
      out[j] = clamp(R, 0, 1);
    }
    return out;
  };

  const pans = [];

  // Bind a paint to a pan. Slot i owns channel i, full stop.
  function assign(slot, paintId) {
    const paint = box[paintId];
    if (!paint || slot < 0 || slot >= MAX_CHANNELS) return;
    channels[slot] = paint;
    pans[slot] = { paint, chan: slot };
    channels.version++;
  }

  // Append a colour. Returns its slot, or -1 if the palette is full.
  function add(paintId) {
    if (pans.length >= MAX_CHANNELS) return -1;
    const slot = pans.length;
    assign(slot, paintId);
    return slot;
  }

  // Drop a colour. Every pan after it shifts down a slot, which means it
  // also changes channel — so this is only safe on an empty sheet, and the
  // UI only offers it when starting a new painting.
  function remove(slot) {
    if (pans.length <= 1 || slot < 0 || slot >= pans.length) return;
    pans.splice(slot, 1);
    channels.fill(null);
    pans.forEach((p, i) => { p.chan = i; channels[i] = p.paint; });
    channels.version++;
  }

  // Replace the whole palette (a new painting).
  function setAll(paintIds) {
    pans.length = 0;
    channels.fill(null);
    paintIds.slice(0, MAX_CHANNELS).forEach((id, i) => assign(i, id));
    if (!pans.length) assign(0, 0);
    channels.version++;
  }

  // Restore pan bindings from a persisted session. Sessions saved by older
  // builds carry 16 channels and their own pan->channel map; only the first
  // N_CHANNELS pans can be honoured, and each is re-seated on its own slot.
  function restore(channelIds, panList) {
    channels.fill(null);
    (panList || []).slice(0, N_CHANNELS).forEach((p, slot) => {
      const paint = box[p.id];
      if (!paint) return;
      channels[slot] = paint;
      pans[slot] = { paint, chan: slot };
    });
    channels.version++;
  }

  // default working palette of twelve (artist will finalize later)
  ['Lemon', 'Irgazin', 'Raw Sien', 'B. Siena',
   'Carmine', 'Q. Pink', 'Diox.', 'Ultram.',
   'Cobalt', 'Prussian', 'C. Turq', 'Emerald']
    .forEach((short, slot) => assign(slot, box.findIndex((p) => p.short === short)));

  return { PAINTBOX: box, CHANNELS: channels, PANS: pans, assignPan: assign,
           restoreBindings: restore, setPalette: setAll, addPan: add, removePan: remove };
})();
