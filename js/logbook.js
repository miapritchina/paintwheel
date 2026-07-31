// Session recorder: logs every interaction as structured events so a session
// can be exported as JSON (for bug reports / analysis) and replayed exactly.
//
// Events carry `f`, the sim frame index, so replay is deterministic at any
// rendering speed. Splats are recorded at the sim.splat level — the lowest
// level that fully reproduces a painting — plus UI-level events (dips,
// rinses, paper changes) for human readability.

'use strict';

const LOGBOOK = (() => {
  let events = [];
  let frame = 0;
  let muted = false;
  const t0 = Date.now();

  const round = (v, p = 100) => Math.round(v * p) / p;

  function pigObj(pig) {
    const o = {};
    for (let i = 0; i < pig.length; i++) {
      if (pig[i] > 0.0005) o[i] = round(pig[i], 1000);
    }
    return o;
  }

  const api = {
    tick() { frame++; },
    get frame() { return frame; },
    set muted(v) { muted = v; },

    log(type, data = {}) {
      if (muted) return;
      events.push({ f: frame, t: type, ...data });
    },

    splat(target, x, y, r, water, pig, wet, scrub) {
      if (muted) return;
      events.push({
        f: frame, t: 'splat', on: target,
        x: round(x), y: round(y), r: round(r),
        w: round(water, 10000), pig: pigObj(pig),
        wet: round(wet, 1000), scrub: round(scrub || 0, 1000),
      });
    },

    // Wrap a sim so every splat is recorded (demo strokes included).
    attach(sim, target) {
      const orig = sim.splat.bind(sim);
      sim.__rawSplat = orig;
      sim.splat = (x, y, r, water, pig, wet, scrub) => {
        api.splat(target, x, y, r, water, pig, wet, scrub);
        orig(x, y, r, water, pig, wet, scrub);
      };
    },

    export(extra = {}) {
      return {
        app: 'paintwheel',
        version: 2,
        recordedAt: new Date(t0).toISOString(),
        durationFrames: frame,
        viewport: { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio || 1 },
        pigments: PIGMENTS.map((p) => `${p.name} (${p.ci})`),
        ...extra,
        events,
      };
    },

    download(extra) {
      const blob = new Blob([JSON.stringify(api.export(extra))], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `paintwheel-session-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    },

    reset() { events = []; frame = 0; },
  };
  return api;
})();

// Deterministic replay of an exported session. Usage (console or tests):
//   REPLAY.load(sessionObjOrJson); ...main loop calls REPLAY.tick() each frame
const REPLAY = (() => {
  let queue = null;
  let idx = 0;
  let f = 0;

  return {
    load(session) {
      const s = typeof session === 'string' ? JSON.parse(session) : session;
      queue = s.events;
      idx = 0;
      f = 0;
      LOGBOOK.muted = true;
      if (s.paper && window.sim) sim.setPaper(s.paper);
      if (window.sim) sim.clearAll();
      if (window.tray) tray.clearAll();
      return s;
    },
    get active() { return queue !== null && idx < queue.length; },
    // Advance one frame, applying all events stamped for it.
    tick() {
      if (!this.active) {
        if (queue !== null && idx >= queue.length) { queue = null; LOGBOOK.muted = false; }
        return;
      }
      while (idx < queue.length && queue[idx].f <= f) {
        const e = queue[idx++];
        const target = e.on === 'tray' ? window.tray : window.sim;
        if (e.t === 'splat' && target) {
          const pig = new Float32Array(PIGMENTS.length);
          for (const [k, v] of Object.entries(e.pig || {})) pig[+k] = v;
          (target.__rawSplat || target.splat)(e.x, e.y, e.r, e.w, pig, e.wet, e.scrub || 0);
        } else if (e.t === 'clear' && window.sim) sim.clearAll();
        else if (e.t === 'palette') {
          setActivePalette(e.ids);
          if (window.__refreshPalette) window.__refreshPalette();
        }
        else if (e.t === 'trayRinse' && window.tray) {
          if (e.seg != null) tray.clearRegion(e.seg * 190, (e.seg + 1) * 190);
          else tray.clearAll();
        }
        else if (e.t === 'paper' && window.sim) sim.setPaper(e.name);
        else if (e.t === 'drySpeed' && window.sim) sim.params.drySpeed = e.v;
        else if (e.t === 'tilt' && window.sim) sim.params.tilt = e.v;
      }
      f++;
    },
  };
})();
