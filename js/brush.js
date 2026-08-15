// The paint model: what the brush holds, and what leaves it when it touches
// the paper. Kept apart from the UI so it can be measured on its own — see
// test/tells.html.
//
// ONE RULE DECIDES VALUE: pigment mass per unit area of paper.
//
// The brush holds a MASS of pigment. Every dab moves some of that mass onto
// the sheet and the brush loses exactly what it laid down. Nothing else makes
// a stroke darker: not the water, not the brush size, not how many samples
// the pen happened to report.
//
// That last point is why this file exists. The old model deposited a FRACTION
// of the whole load per dab (~29%) while the brush lost only an exponential of
// the distance travelled, so a single stroke laid down roughly twice the
// brush's entire load and a second pass laid it again, without limit. Measured
// against the paint box's own ramp — 14 / 5 / 2 / 0.8 / 0.3 from mass tone to
// a thin wash — one ordinary stroke landed at 2.6 and four strokes at 10.5.
// Everything was painted above the knee of the Kubelka-Munk curve, where
// doubling the pigment barely changes the colour, which is exactly why every
// combination of settings looked the same and all of it looked potent.
//
// WATER NEVER CHANGES VALUE. It decides how deep the film is, and from that:
// how far paint travels, how soft the edges are, whether it blooms, how long
// the wash stays open, and how much paper one load ends up covering. A wetter
// brush does give a paler wash — because the paint spreads further, which is
// what dilution actually is — but that happens in the fluid simulation, where
// it is real, and not by quietly scaling the colour down at the brush.

'use strict';

const BRUSH = (() => {
  // Pigment mass, in units of (optical depth x css px^2).
  //
  // A full dip is enough to cover 30,000 px^2 — a 16px-radius brush laid down
  // for about 940px of travel — at a strong but still transparent wash, the
  // second-darkest step of the paint box ramp. So one full dip is roughly one
  // screen-width of strong colour, or two of a mid wash, and then it is spent.
  //
  // The number was set by measurement, not by taste: at 60000 the value
  // ladder in test/tells.html topped out with its last two steps only 8%
  // apart, i.e. the top third of the paint slider did nothing, which is the
  // "everything looks potent and all the settings look the same" complaint
  // in its purest form. Kubelka-Munk saturates, so the working range has to
  // sit under the knee.
  const PIG_CAP = 24000;

  // A dab lays its pigment with a soft profile, not a flat disc: the splat
  // shader's mask is 1 inside 0.3r and smoothsteps out to nothing at r. The
  // integral of that profile over the footprint is 0.447 * pi * R^2, so a dab
  // of peak amplitude `a` and radius `R` puts 1.404 * a * R^2 of mass on the
  // sheet. Inverting that is what makes a dab conserve mass.
  const FOOTPRINT = 1.404;

  // The radius the release rate is calibrated at. Pressing harder widens the
  // brush and releases proportionally more paint, so a fat stroke and a fine
  // one lay down the same DEPTH — size changes the width of a mark, not how
  // dark it is, which is what a painter expects of it.
  const REF_RADIUS = 16;

  // How much travel it takes to spend a load, as an e-folding length for the
  // reference brush. A real brush lets go of its paint fastest when it is
  // full, so the release is exponential and the stroke fades to a dry-brush
  // tail on its own rather than stopping at a line.
  const RELEASE = {
    real:     900,      // a dip crosses a phone screen and is fading by the far side
    generous: 2500,     // longer washes without re-dipping
    never:    Infinity, // the hairs hold their load: flat colour, even lines
  };

  const api = {
    water: 0.6,
    pig: new Float32Array(N_CHANNELS),
    PIG_CAP,
    FOOTPRINT,
    REF_RADIUS,
    RELEASE,
    releaseMode: 'real',

    total() {
      let t = 0;
      for (let i = 0; i < N_CHANNELS; i++) t += api.pig[i];
      return t;
    },

    // How full the brush is, 0..1. The UI works in this rather than in mass
    // units, so the units above can be re-tuned without touching the sliders
    // or invalidating a saved session.
    frac() { return Math.min(api.total() / PIG_CAP, 1); },

    // Scale the load to a new total, keeping the mixture's proportions — so
    // its hue and its physical character are untouched.
    setLoad(mass) {
      const t = api.total();
      if (t < 1e-9) return;
      const k = Math.max(mass, 0) / t;
      for (let i = 0; i < N_CHANNELS; i++) api.pig[i] *= k;
    },
    setFrac(f) { api.setLoad(Math.max(0, Math.min(f, 1)) * PIG_CAP); },

    // Lay the recipe on the hairs at a given mass (parts are normalised).
    setRecipe(parts, mass) {
      let tot = 0;
      for (let i = 0; i < N_CHANNELS; i++) tot += parts[i];
      if (tot <= 0) { api.pig.fill(0); return; }
      for (let i = 0; i < N_CHANNELS; i++) api.pig[i] = (parts[i] / tot) * mass;
    },

    // Dilution — the pigment:water ratio on the hairs. This is the paint's
    // consistency, and unlike before it now has a consequence: it is what the
    // splat's wetness term reads, so butter-thick paint sits where it is put
    // and tea runs.
    ratio() {
      const t = api.frac();
      return t / (t + 2.2 * api.water + 1e-6);
    },

    consistency() {
      const t = api.frac();
      if (t < 0.012) return api.water > 0.05 ? 'clean water' : 'dry, empty';
      const r = api.ratio();
      if (r > 0.78) return 'butter';
      if (r > 0.55) return 'cream';
      if (r > 0.33) return 'milk';
      if (r > 0.16) return 'coffee';
      return 'tea';
    },

    // What one dab puts on the paper, and what it costs the brush.
    //
    //   advance  css px travelled since the previous dab
    //   radius   css px, after pressure
    //   pressure 0..1
    //
    // Returns the peak amplitudes to hand the splat shader, plus the water.
    // The caller does not get to scale these: a dab IS this much paint.
    dab(advance, radius, pressure, out) {
      const amp = out || new Float32Array(N_CHANNELS);
      const len = RELEASE[api.releaseMode] || RELEASE.real;

      // Release scales with contact width as well as distance, so a wide
      // brush spends its load faster over the same path and the DEPTH it
      // leaves comes out the same as a fine one.
      const reach = Math.max(advance, 0) * (radius / REF_RADIUS);
      // With no depletion the brush still has to decide how much to lay per
      // dab; it just does not pay for it. Use the generous rate so an
      // unlimited brush paints at a believable strength rather than a flat
      // maximum.
      const frac = len === Infinity
        ? 1 - Math.exp(-reach / RELEASE.generous)
        : 1 - Math.exp(-reach / len);

      const k = 1 / (FOOTPRINT * radius * radius);
      for (let i = 0; i < N_CHANNELS; i++) {
        const mass = api.pig[i] * frac;
        amp[i] = mass * k;
        if (len !== Infinity) api.pig[i] -= mass; // the brush pays for it
      }

      // Water delivered depends ONLY on how wet the hairs are. A bone-dry
      // brush wets the paper not at all, however much paint it carries.
      const water = 0.055 * api.water * (0.5 + 0.5 * pressure);

      // A clean damp brush lifts pigment instead of leaving it.
      const scrub = api.frac() < 0.015 ? 0.08 * pressure * api.water : 0;

      return { amp, water, scrub, wetness: api.water };
    },

    // Water leaves faster than pigment does — the paper drinks it — so a long
    // stroke gets progressively drier and more concentrated before it finally
    // runs out. Pigment depletion is not here: a dab already pays for its own
    // paint, which is the whole point.
    dry(dist) {
      if (api.releaseMode === 'never') return;
      api.water *= Math.exp(-dist / 900);
    },

    rinse() { api.pig.fill(0); },
  };

  return api;
})();
