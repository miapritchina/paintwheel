// Watercolor pigment definitions with Kubelka-Munk absorption (K) and
// scattering (S) coefficients.
//
// K and S values are the MEASURED pigment data from Curtis, Anderson, Seims,
// Fleischer & Salesin, "Computer-Generated Watercolor" (SIGGRAPH 1997),
// Figure 5, along with their physical behavior parameters:
//   rho   (density)     - deposition rate, how fast pigment settles out
//   omega (staining)    - divisor on re-lifting; high omega = stains the paper
//   gamma (granulation) - how strongly paper height modulates settling;
//                         high gamma pigments collect in texture valleys
//
// Exactly 8 pigments: the sim stores per-pigment concentration in two RGBA
// textures (suspended) plus two (deposited); palette index maps to channel.
// The chosen 8 form a classic split-primary palette: warm/cool blue, green,
// yellow, warm/cool red, and two earths.

'use strict';

const PIGMENTS = (() => {
  // name, K (rgb absorption), S (rgb scattering), rho, omega, gamma
  const defs = [
    { name: 'French Ultramarine', K: [0.86, 0.86, 0.06], S: [0.005, 0.005, 0.09], rho: 0.01, omega: 3.1, gamma: 0.91 },
    { name: 'Cerulean Blue',      K: [1.52, 0.32, 0.25], S: [0.06, 0.26, 0.40],   rho: 0.01, omega: 1.0, gamma: 0.31 },
    { name: 'Phthalo Green',      K: [1.55, 0.47, 0.63], S: [0.01, 0.05, 0.035],  rho: 0.02, omega: 1.0, gamma: 0.12 },
    { name: 'Hansa Yellow',       K: [0.06, 0.21, 1.78], S: [0.50, 0.88, 0.009],  rho: 0.06, omega: 1.0, gamma: 0.08 },
    { name: 'Cadmium Red',        K: [0.14, 1.08, 1.68], S: [0.77, 0.015, 0.018], rho: 0.02, omega: 1.0, gamma: 0.63 },
    { name: 'Quinacridone Rose',  K: [0.22, 1.47, 0.57], S: [0.05, 0.003, 0.03],  rho: 0.02, omega: 5.5, gamma: 0.81 },
    { name: 'Burnt Umber',        K: [0.74, 1.54, 2.10], S: [0.09, 0.09, 0.004],  rho: 0.09, omega: 9.3, gamma: 0.90 },
    { name: 'Indian Red',         K: [0.46, 1.07, 1.50], S: [1.28, 0.38, 0.21],   rho: 0.05, omega: 7.0, gamma: 0.40 },
  ];

  // Compute a UI swatch color: KM reflectance of a moderately thick layer
  // over white paper, gamma-encoded for CSS. Exposed as PIGMENTS.kmColor for
  // the palette-mixing UI.
  function swatchColor(K, S, x) {
    const out = [0, 0, 0];
    for (let i = 0; i < 3; i++) {
      const s = Math.max(S[i], 1e-4);
      const a = 1 + K[i] / s;
      const b = Math.sqrt(Math.max(a * a - 1, 1e-8));
      const c = Math.min(b * s * x, 20);
      const sh = Math.sinh(c), ch = Math.cosh(c);
      const R = sh / (a * sh + b * ch);
      const T = b / (a * sh + b * ch);
      const Rp = 0.92; // paper
      const Rtot = R + (T * T * Rp) / (1 - R * Rp);
      out[i] = Math.round(255 * Math.pow(Math.min(Math.max(Rtot, 0), 1), 1 / 2.2));
    }
    return `rgb(${out[0]},${out[1]},${out[2]})`;
  }

  const list = defs.map((d) => ({
    ...d,
    swatch: swatchColor(d.K, d.S, 8.0),
  }));
  // KM color of an arbitrary mixture: parts is an array of 8 weights.
  list.kmColor = (parts, x = 8.0) => {
    const K = [0, 0, 0], S = [0, 0, 0];
    let total = 0;
    parts.forEach((p, i) => { total += p; });
    if (total <= 0) return 'rgb(240,238,232)';
    parts.forEach((p, i) => {
      const c = p / total;
      for (let j = 0; j < 3; j++) { K[j] += c * list[i].K[j]; S[j] += c * list[i].S[j]; }
    });
    return swatchColor(K, S, x);
  };
  return list;
})();
