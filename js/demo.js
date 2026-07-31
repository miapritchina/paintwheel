// Scripted demo: showcases wet-on-wet blooms, wet-on-dry strokes, edge
// darkening, granulation, and a backrun. Time-based event script; each event
// is [tStartSec, tEndSec, fn(sim, u)] with u in [0,1] progress.

'use strict';

const DEMO = (() => {
  let active = false;
  let t0 = 0;
  let events = [];

  const W = () => window.innerWidth;
  const H = () => window.innerHeight;
  const pig = new Float32Array(PIGMENTS.length);
  // working-palette slot indices (matches the default palette in pigments.js)
  const CAD_LEMON = 0, BURNT_SIENA = 2, QUIN_PINK = 3, ULTRAMARINE = 4,
        COBALT_TURQ = 6, EMERALD = 7;
  function drop(sim, x, y, r, water, idx, amt, wetness = 1) {
    pig.fill(0);
    if (idx >= 0) pig[idx] = amt;
    sim.splat(x, y, r, water, pig, wetness);
  }

  function build() {
    const w = W(), h = H();
    const ev = [];

    // 1. Wet-on-wet: big clear-water pool, then pigments dropped in -> blooms
    ev.push([0.0, 1.2, (s, u) => {
      const cx = w * 0.28, cy = h * 0.30;
      const a = u * Math.PI * 6;
      drop(s, cx + Math.cos(a) * w * 0.1 * (0.3 + u), cy + Math.sin(a) * h * 0.07 * (0.3 + u), w * 0.05, 0.05, -1, 0);
    }]);
    ev.push([1.6, 1.75, (s, u) => drop(s, w * 0.24, h * 0.27, w * 0.02, 0.03, ULTRAMARINE, 0.5)]); // ultramarine
    ev.push([2.1, 2.25, (s, u) => drop(s, w * 0.33, h * 0.33, w * 0.02, 0.03, QUIN_PINK, 0.5)]); // rose
    ev.push([2.6, 2.7, (s, u) => drop(s, w * 0.28, h * 0.24, w * 0.015, 0.025, CAD_LEMON, 0.45)]); // yellow

    // 2. Wet-on-dry strokes: sharp edges, edge darkening, dry-brush tail
    ev.push([3.4, 4.6, (s, u) => {
      const x = w * (0.1 + u * 0.42);
      const y = h * 0.52 + Math.sin(u * Math.PI * 2.2) * h * 0.03;
      drop(s, x, y, w * 0.018, 0.02 * (1 - u * 0.75), BURNT_SIENA, 0.35, 0.55 - u * 0.4); // burnt umber, drying out
    }]);
    ev.push([5.0, 6.0, (s, u) => {
      const x = w * (0.1 + u * 0.4);
      drop(s, x, h * 0.63, w * 0.02, 0.03, EMERALD, 0.4, 0.85); // phthalo green juicy stroke
    }]);

    // 3. Granulation wash: ultramarine flat wash lower right
    ev.push([6.4, 7.6, (s, u) => {
      const x = w * (0.6 + 0.3 * ((u * 5) % 1));
      const y = h * (0.62 + 0.28 * Math.floor(u * 5) / 5);
      drop(s, x, y, w * 0.035, 0.045, ULTRAMARINE, 0.35, 0.9);
    }]);

    // 4. Backrun: drop clear water into the half-dried wash
    ev.push([11.5, 11.8, (s, u) => {
      drop(s, w * 0.75, h * 0.76, w * 0.045, 0.09, -1, 0, 1.0);
    }]);

    // 5. Rose + yellow wet-on-wet mixing patch, top right (KM green-free mix)
    ev.push([8.2, 8.9, (s, u) => {
      const x = w * (0.62 + u * 0.25);
      drop(s, x, h * 0.22, w * 0.03, 0.05, CAD_LEMON, 0.4, 1.0); // hansa yellow
    }]);
    ev.push([9.2, 9.9, (s, u) => {
      const x = w * (0.65 + u * 0.2);
      drop(s, x, h * 0.28, w * 0.025, 0.03, COBALT_TURQ, 0.4, 0.9); // cerulean -> mixes to green
    }]);

    return ev;
  }

  return {
    start(sim) {
      sim.clearAll();
      events = build();
      t0 = 0;
      active = true;
    },
    stop() { active = false; },
    // Frame-based clock (assumes 60 fps target) so the script is
    // deterministic even when the browser can't hold the frame rate.
    tick(sim) {
      if (!active) return;
      t0 += 1 / 60;
      const t = t0;
      for (const [a, b, fn] of events) {
        if (t >= a && t <= b) fn(sim, (t - a) / Math.max(b - a, 1e-3));
      }
      if (t > 20) active = false;
    },
  };
})();
