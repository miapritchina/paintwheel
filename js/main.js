// UI wiring: painter's workbench.
//
// The brush is a stateful object carrying water + a 12-pigment load. Two
// sliders set those two quantities and a tap on a pan sets the recipe;
// nothing refills by itself, so a stroke that runs long goes dry-brush,
// exactly like the real thing.
//
// Colours are mixed by PARTS on the pans rather than smeared together on a
// simulated plate: tap yellow seven times, black once, blue twice and the
// brush carries 7:1:2. The plate was a second full instance of the
// simulation running every frame; on an iPhone it was 18% of all the work
// done, and it is the reason twelve pigment channels now fit where sixteen
// used to. Each pigment still keeps its own physics on the paper, so a mix
// that contains ultramarine still granulates.

'use strict';

(() => {
  const canvas = document.getElementById('canvas');
  let sim;
  try {
    sim = new WatercolorSim(canvas);
  } catch (e) {
    const err = document.getElementById('err');
    err.style.display = 'flex';
    err.textContent = e.message;
    throw e;
  }
  window.sim = sim; // for console tinkering / automated tests
  LOGBOOK.attach(sim, 'paper');

  const NPIG = N_CHANNELS; // brush carries per-CHANNEL loads

  // -------------------------------------------------------------- brush ---
  // Two INDEPENDENT quantities, and nothing couples them:
  //   water  - how much fluid the hairs carry (0 bone dry .. 1 dripping).
  //            This alone decides how wet the paper gets.
  //   pig[]  - how much pigment sits on the hairs. This alone decides how
  //            strong the colour is.
  // Every water control leaves the paint exactly as it was, and every paint
  // control leaves the water alone. The simulated versions of these — a wet
  // brush dissolving more out of a pan, a water dip washing pigment off —
  // were true to life but made the two knobs fight each other, so they are
  // gone, and so are the buttons that only ever moved the water slider.
  const brush = {
    water: 0.6,
    pig: new Float32Array(NPIG),
  };
  window.brush = brush;

  const PIG_CAP = 1.2; // pigment load of a fully charged brush

  // Dilution = the pigment:water ratio on the hairs. This is the paint's
  // *value* axis, independent of how much water the brush carries.
  function dilutionRatio() {
    return brushTotal() / (brushTotal() + 2.2 * brush.water + 1e-6);
  }

  // Zbukvic's consistency scale, read off that ratio.
  function consistency(r = dilutionRatio()) {
    if (brushTotal() < 0.015) return brush.water > 0.05 ? 'clean water' : 'dry, empty';
    if (r > 0.78) return 'butter';
    if (r > 0.55) return 'cream';
    if (r > 0.33) return 'milk';
    if (r > 0.16) return 'coffee';
    return 'tea';
  }

  // Scale the whole pigment load to a new total, keeping the mixture's
  // proportions (so its hue and physical character are untouched).
  function setPaintLoad(target) {
    const t = brushTotal();
    if (t < 1e-5) return;
    const k = Math.max(target, 0) / t;
    for (let i = 0; i < NPIG; i++) brush.pig[i] *= k;
  }

  const brushcursor = document.getElementById('brushcursor');
  const pignameEl = document.getElementById('pigname');
  const consistencyEl = document.getElementById('consistency');

  function brushTotal() {
    let t = 0;
    for (let i = 0; i < NPIG; i++) t += brush.pig[i];
    return t;
  }

  // ------------------------------------------------- live brush sliders ---
  // Two sliders, one per axis. There was a third for dilution — the ratio of
  // the two — but a control whose value is decided by the other two controls
  // is a knob that moves on its own, and the pans now set the recipe.
  const paintSl = document.getElementById('paintload');
  const waterSl = document.getElementById('waterload');
  let sliderEcho = false; // suppress feedback while we write slider values

  paintSl.addEventListener('input', () => {
    if (sliderEcho) return;
    // Squared, not linear. Colour depth saturates fast: on a measured ladder
    // the whole readable range from a tint to a mass tone lived in the first
    // third of a linear slider, and everything above it looked the same.
    const target = Math.pow(Number(paintSl.value) / 100, 2) * PIG_CAP;
    if (partsTotal() <= 0) { updateBrushView('Tap a pan first — no colour to load'); return; }
    applyMix(target); // keeps the recipe, changes only how much of it
    updateBrushView(`Paint ${paintSl.value}%`);
  });
  waterSl.addEventListener('input', () => {
    if (sliderEcho) return;
    brush.water = Number(waterSl.value) / 100; // paint is not touched
    updateBrushView(`Water ${waterSl.value}%`);
  });
  // Log where these two land, once the finger lets go. Without this a session
  // log shows pigment collapsing mid-painting with nothing to explain it —
  // the two controls that decide every stroke were the only ones invisible.
  paintSl.addEventListener('change', () => LOGBOOK.log('load', { paint: Number(paintSl.value) }));
  waterSl.addEventListener('change', () => LOGBOOK.log('load', { water: Number(waterSl.value) }));

  // ------------------------------------------------- the mix, as a stroke --
  // A swatch of flat colour cannot show what a watercolour actually does:
  // heavy pigments drop into the tooth of the paper and separate out, thin
  // paint lets the sheet through. So the preview is a real dried stroke,
  // rendered with the same Kubelka-Munk optics and the same granulation rule
  // as the paper itself — per pigment, per pixel — on the CPU at 420x34,
  // which costs nothing and needs no second GL context.
  const strokeCanvas = document.getElementById('mixstroke');
  const sctx = strokeCanvas.getContext('2d');
  let strokeField = null; // paper height, generated once

  function paperField(w, h) {
    if (strokeField && strokeField.w === w && strokeField.h === h) return strokeField;
    const fine = new Float32Array(w * h);
    const coarse = new Float32Array(w * h);
    const hash = (x, y, s) => {
      let n = Math.sin(x * 127.1 + y * 311.7 + s) * 43758.5453;
      return n - Math.floor(n);
    };
    const vnoise = (x, y, s) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      const a = hash(xi, yi, s), b = hash(xi + 1, yi, s);
      const c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
      return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
    };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        fine[i] = 0.45 * vnoise(x * 0.7, y * 0.7, 3.1) + 0.32 * vnoise(x * 1.7, y * 1.7, 7.7)
                + 0.23 * vnoise(x * 0.22, y * 0.22, 1.3);
        // two octaves, or the coarse flocs read as a square lattice
        coarse[i] = 0.62 * vnoise(x * 0.15, y * 0.15, 5.9) + 0.38 * vnoise(x * 0.37, y * 0.37, 11.2);
      }
    }
    strokeField = { w, h, fine, coarse };
    return strokeField;
  }

  function renderMixStroke() {
    const total = brushTotal();
    strokeCanvas.classList.toggle('on', total > 0.01);
    if (total <= 0.01) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = strokeCanvas.clientWidth || 420;
    const W = Math.max(60, Math.round(cssW * dpr));
    const H = Math.round(34 * dpr);
    if (strokeCanvas.width !== W || strokeCanvas.height !== H) {
      strokeCanvas.width = W; strokeCanvas.height = H;
    }
    const fld = paperField(W, H);
    const img = sctx.createImageData(W, H);
    const px = img.data;
    const paperRGB = (PAPERS[sim.paperName] || PAPERS.rough).color;
    const conc = new Float64Array(NPIG);

    // per-pigment settling parameters, as the render pass uses them
    const gamma = [], grain = [], share = [];
    for (let i = 0; i < NPIG; i++) {
      const p = CHANNELS[i];
      gamma.push(p ? p.gamma : 0);
      grain.push(p ? p.grain : 0);
      share.push(brush.pig[i]);
    }
    // a stroke: full strength at the left, running out to a thin dry-brush
    // tail at the right, with the darker rim a drying edge leaves
    const depth = 2.6 * Math.min(total / PIG_CAP, 1);
    for (let x = 0; x < W; x++) {
      const xn = x / (W - 1);
      // a hand-drawn line, not a bar: the centre wanders and the stroke
      // narrows as the brush runs out, leaving paper above and below
      const centre = 0.5 + 0.055 * Math.sin(xn * 6.3 + 0.7) + 0.03 * Math.sin(xn * 15.1);
      const halfW = 0.34 * (1 - 0.22 * xn);
      const runOut = Math.pow(1 - xn, 1.3) * 0.9 + 0.08;
      for (let y = 0; y < H; y++) {
        const i = y * W + x;
        const fine = fld.fine[i];
        // the edge of a stroke is ragged at pigment scale
        const dy = Math.abs(y / (H - 1) - centre) / (halfW * (0.93 + 0.14 * fine));
        if (dy >= 1) { const o = i * 4; const pr = paperRGB;
          px[o] = 255 * Math.pow(pr[0], 1 / 2.2); px[o + 1] = 255 * Math.pow(pr[1], 1 / 2.2);
          px[o + 2] = 255 * Math.pow(pr[2], 1 / 2.2); px[o + 3] = 255; continue; }
        const body = Math.pow(1 - dy * dy, 0.55);
        const rim = 1 + 0.55 * Math.pow(dy, 5); // a drying edge leaves a dark line
        // dry brush at the thin end: the tooth starts skipping
        const skip = 1 - Math.max(0, (xn - 0.5) / 0.5) * Math.max(0, fine - 0.32) * 3.0;
        const t = depth * body * rim * runOut * Math.max(skip, 0);
        for (let k = 0; k < NPIG; k++) {
          if (share[k] <= 0) { conc[k] = 0; continue; }
          // granulation: the heavier the pigment and the coarser its grain,
          // the more it drops out of suspension into the paper's valleys
          const relief = gamma[k] > 0
            ? 1 - (fine * (1 - grain[k]) + fld.coarse[i] * grain[k])
            : 0.5;
          const settle = gamma[k] > 0 ? (0.45 + 1.2 * relief) : 1;
          conc[k] = share[k] * t * (1 - gamma[k] + gamma[k] * settle);
        }
        const rgb = CHANNELS.kmPixel(conc, paperRGB);
        const o = i * 4;
        px[o] = 255 * Math.pow(rgb[0], 1 / 2.2);
        px[o + 1] = 255 * Math.pow(rgb[1], 1 / 2.2);
        px[o + 2] = 255 * Math.pow(rgb[2], 1 / 2.2);
        px[o + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);
  }

  function updateBrushView(msg) {
    const total = brushTotal();
    // the colour still drives the brush cursor on the paper
    const color = total > 0.01 ? CHANNELS.kmColor(brush.pig, 1.5 + 12 * Math.min(total, 1.2)) : 'rgb(238,236,230)';
    // the sliders double as the level meters: writing them back keeps the
    // display honest whichever way the brush was changed (pan, slider, stroke)
    sliderEcho = true;
    paintSl.value = String(Math.round(Math.min(total / PIG_CAP, 1) * 100));
    waterSl.value = String(Math.round(brush.water * 100));
    sliderEcho = false;
    paintSl.style.setProperty('--fill', color);
    brushcursor.style.background = total > 0.01 ? color.replace('rgb', 'rgba').replace(')', ',0.35)') : 'rgba(200,220,255,0.2)';
    consistencyEl.textContent = consistency();
    renderMixStroke();
    if (msg !== undefined) pignameEl.textContent = msg;
  }


  // ------------------------------------------------------------ palette ---
  // Pans show the darkest possible mass tone (like real dried pans) with a
  // short name label to tell the dark ones apart.
  //
  // Mixing is by PARTS, which is how a recipe is actually held in the head:
  // "seven yellow, one black, two blue". Each tap on a pan adds a part; the
  // brush always carries the normalised mixture. Swirling on a pan loads
  // more PAINT without changing the recipe, so quantity and ratio stay
  // separate — the same split as water and pigment on the brush.
  const paletteEl = document.getElementById('palette');
  const PARTS = new Float32Array(NPIG);

  window.PARTS = PARTS;

  function partsTotal() {
    let t = 0;
    for (let i = 0; i < NPIG; i++) t += PARTS[i];
    return t;
  }

  // Restate the brush's pigment as the recipe, keeping however much paint is
  // already on it (or a starting dose if it was empty).
  // Restate the brush's pigment as the recipe. How MUCH paint is on the
  // brush is its own quantity — set by the Paint slider, carried over when
  // the recipe changes, and defaulting to the "paint per dip" setting when
  // the brush was empty. Water is never consulted.
  function applyMix(load) {
    const tot = partsTotal();
    if (tot <= 0) { brush.pig.fill(0); return; }
    const amount = load != null ? load
      : (brushTotal() > 0.01 ? brushTotal() : Math.min(PIG_CAP, SET.pickup));
    for (let i = 0; i < NPIG; i++) brush.pig[i] = (PARTS[i] / tot) * amount;
  }

  function mixText() {
    const tot = partsTotal();
    if (tot <= 0) return '';
    return PANS.map((pan, i) => (PARTS[i] > 0 ? `${Math.round(PARTS[i])} ${pan.paint.short}` : null))
      .filter(Boolean).join(' : ');
  }

  function refreshParts() {
    const tot = partsTotal();
    [...paletteEl.querySelectorAll('.panwrap')].forEach((wrap, i) => {
      const badge = wrap.querySelector('.panparts');
      if (!badge) return;
      badge.textContent = PARTS[i] > 0 ? String(Math.round(PARTS[i])) : '';
      badge.style.display = PARTS[i] > 0 ? 'block' : 'none';
      wrap.classList.toggle('inmix', PARTS[i] > 0);
    });
  }
  window.__refreshParts = refreshParts;

  // A pan is a dial for its own share of the recipe:
  //   tap             +1 part
  //   drag up/down    raise / lower that share, live
  //   long press      take it out of the mix
  // Dragging is the important one — a proportion is something you feel your
  // way to, and tapping seven times to correct one part is not that.
  const PART_PX = 14;   // pixels of drag per part (20 parts in one screen-height drag)
  const PART_MAX = 20;

  function panGesture(el, i) {
    let active = false, startY = 0, startX = 0, startParts = 0, changed = false, held = null;

    const commit = (why) => {
      refreshParts();
      applyMix();
      updateBrushView(partsTotal() > 0 ? `${mixText()}` : 'Mix empty');
      if (why) LOGBOOK.log('parts', { pan: i, name: PANS[i].paint.name, parts: PARTS[i], how: why, mix: mixText() });
    };

    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      active = true; changed = false;
      startY = e.clientY; startX = e.clientX;
      startParts = PARTS[i];
      try { el.setPointerCapture(e.pointerId); } catch { /* mouse w/o capture */ }
      held = setTimeout(() => {
        if (changed) return;
        changed = true; held = null; // a long press consumes the tap
        PARTS[i] = 0;
        commit('hold');
      }, 600);
    });

    el.addEventListener('pointermove', (e) => {
      if (!active) return;
      e.preventDefault();
      const dy = startY - e.clientY; // up is more
      // Kill the long press the moment the finger moves at all, not only once
      // it has travelled far enough to count as a drag. A slow drag — down,
      // pause, then move — used to trip the 500ms timer first and zero the
      // pan, and the drag that followed put the old value straight back.
      if (Math.hypot(e.clientX - startX, dy) > 3) clearTimeout(held);
      if (!changed && Math.abs(dy) < 6) return;
      clearTimeout(held);
      const next = Math.max(0, Math.min(PART_MAX, Math.round(startParts + dy / PART_PX)));
      if (next === PARTS[i]) { changed = true; return; }
      changed = true;
      PARTS[i] = next;
      commit(null);
    });

    const end = () => {
      if (!active) return;
      active = false;
      clearTimeout(held);
      if (!changed) { // a plain tap adds one part
        PARTS[i] = Math.min(PART_MAX, PARTS[i] + 1);
        commit('tap');
      } else if (held !== null) { // a long press already reported itself
        LOGBOOK.log('parts', { pan: i, name: PANS[i].paint.name, parts: PARTS[i], how: 'drag', mix: mixText() });
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
  }

  function rebuildPans() {
    paletteEl.innerHTML = '';
    PANS.forEach((pan, i) => {
      const p = pan.paint;
      const wrap = document.createElement('div');
      wrap.className = 'panwrap';
      const b = document.createElement('button');
      b.className = 'pan';
      b.style.background = p.swatch;
      b.title = `${p.name} (${p.ci}) — tap to add a part, drag up/down to set it, hold to remove`;
      const badge = document.createElement('div');
      badge.className = 'panparts';
      const label = document.createElement('div');
      label.className = 'panlabel';
      label.textContent = p.short;
      b.appendChild(badge);
      wrap.appendChild(b);
      wrap.appendChild(label);
      // the whole cell is the target, name label included
      panGesture(wrap, i);
      paletteEl.appendChild(wrap);
    });
    refreshParts();
  }
  rebuildPans();
  window.__refreshPalette = rebuildPans;

  // ------------------------------------------------------------- rinse ----
  // The water glass and the sponge used to live here. Both did one thing:
  // move the water slider — the glass up, the sponge down — by swirling on a
  // button instead of dragging the control that is already on screen. Once
  // water stopped being tangled up with paint they were two spellings of the
  // same knob, so they are gone. 🌀 is the one brush action left that the
  // sliders cannot express.
  document.getElementById('clean').addEventListener('pointerdown', () => {
    // Rinse takes the COLOUR off the hairs and nothing else — water is the
    // water slider's business, and rinsing used to empty it too.
    //
    // The recipe survives as well. A session log showed the cost of clearing
    // it: after a rinse the artist made 592 more dabs, every one of them
    // carrying no colour at all, painting clean water over the picture and
    // then trying to dry it off. Keeping the mix means the next tap on any
    // pan brings the whole recipe back, and the preview strip vanishing is
    // the signal that the brush is empty.
    brush.pig.fill(0);
    LOGBOOK.log('clean', { water: Math.round(brush.water * 100) / 100 });
    updateBrushView('Rinsed — colour off, water untouched');
  });

  // ----------------------------------------------------------- controls ---
  const sizeEl = document.getElementById('size');

  // ----------------------------------------------------------- settings ---
  // Workbench preferences, persisted with the rest of the session state.
  const SET = {
    pickup: 0.8,       // paint taken per dip
    saltGrain: 2.6,    // salt crystal size
    runoff: true,      // paint and water travel across the sheet
    pressureSize: true,// stylus pressure drives brush size
    deplete: true,     // the brush runs out as you paint
    tiltStrength: 1.0, // how steeply tilt runs the paint
    pressRange: 0.6,   // how far stylus force moves the brush size
  };
  window.SET = SET;

  // -------------------------------------------------- safe-area fitting ---
  // An installed PWA can be letterboxed: the web view stops short of the
  // screen and iOS fills the strip below it with the manifest background
  // colour. When that happens the OS has ALREADY moved the content clear of
  // the home indicator, so padding by env(safe-area-inset-bottom) as well
  // stacks a second gap on the first — which is what left ~77px of dead
  // space under the bar on an iPhone: 34px of our padding above a 43px
  // strip. Measure whether the view actually reaches the screen edge, and
  // only pay the inset when it does.
  function fitSafeArea() {
    const standalone = window.navigator.standalone === true ||
      (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    // iOS does not agree with itself about whether screen dimensions rotate,
    // so pick the one that matches the current orientation rather than
    // trusting screen.height
    const portrait = window.innerHeight >= window.innerWidth;
    const sw = (window.screen && screen.width) || window.innerWidth;
    const sh = (window.screen && screen.height) || window.innerHeight;
    const screenH = portrait ? Math.max(sw, sh) : Math.min(sw, sh);
    const gap = Math.max(0, screenH - window.innerHeight);
    const letterboxed = standalone && gap > 12;
    const root = document.documentElement.style;
    if (letterboxed) root.setProperty('--safe-bottom', '6px');
    else root.removeProperty('--safe-bottom');
    return { standalone, screenH, innerH: window.innerHeight, gap, letterboxed };
  }
  window.__fitSafeArea = fitSafeArea;
  fitSafeArea();
  window.addEventListener('resize', fitSafeArea);
  window.addEventListener('orientationchange', () => setTimeout(fitSafeArea, 250));

  // ------------------------------------------------------------ version ---
  // Which build is actually running, and is it the one that was deployed?
  // The stamp comes from CI rather than a hand-bumped number, so it cannot
  // drift from what is served. "Check for update" re-fetches the stamp with
  // caching bypassed and compares — that is the difference between "the
  // deploy finished" and "the deploy reached this device", which a service
  // worker and an installed PWA can otherwise hide.
  const buildLabel = `${BUILD.build}${BUILD.date ? ` · ${BUILD.date}` : ''}`;
  const buildEl = document.getElementById('buildinfo');
  const updNote = document.getElementById('updnote');
  buildEl.textContent = buildLabel;

  document.getElementById('checkupd').addEventListener('click', async () => {
    updNote.textContent = 'Checking…';
    try {
      const res = await fetch(`js/version.js?t=${Date.now()}`, { cache: 'no-store' });
      const txt = await res.text();
      const commit = (txt.match(/build:\s*'([^']*)'/) || [])[1];
      const date = (txt.match(/date:\s*'([^']*)'/) || [])[1] || '';
      if (!commit) { updNote.textContent = 'Could not read the version on the server.'; return; }
      if (commit === BUILD.build) {
        updNote.textContent = `Up to date — running the deployed build (${commit}).`;
        return;
      }
      updNote.textContent = `Server has ${commit}${date ? ` · ${date}` : ''} — updating…`;
      // drop the service worker's caches so the reload cannot be served the
      // old shell, then take the new one
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update().catch(() => r.unregister())));
      }
      await saveState();
      location.reload();
    } catch (e) {
      updNote.textContent = `Could not reach the server (${e.message}). You are offline — this is the last build that loaded.`;
    }
  });

  const settingsPanel = document.getElementById('setpanel');
  const dryingEl = document.getElementById('drying');
  const pickupEl = document.getElementById('pickup');
  const saltsizeEl = document.getElementById('saltsize');
  const runoffEl = document.getElementById('runoff');
  const pressEl = document.getElementById('presssize');
  const depleteEl = document.getElementById('deplete');
  const tiltStrEl = document.getElementById('tiltstrength');
  const pressRangeEl = document.getElementById('pressrange');
  const qualityEl = document.getElementById('quality');

  // The two knobs that actually cost power, measured on an iPad in
  // landscape: simulation cells and drawn pixels.
  const QUALITY = {
    high:     { maxSim: 1024, dpr: 3.0 },
    balanced: { maxSim: 768,  dpr: 1.5 },
    battery:  { maxSim: 576,  dpr: 1.0 },
  };

  // Drying speed: 0.0625x .. 4x around the base rate, hinged at the slider's
  // default so the middle of the dial keeps its old feel. The bottom half used
  // to bottom out at half the default, which is not slow: a session log shows
  // the slider driven down to 5 and left there, still asking for slower.
  function applyDrying(log = true) {
    const v = Number(dryingEl.value);
    sim.params.dryScale = 0.5 * Math.pow(8, (v - 30) / (v <= 30 ? 30 : 70));
    if (log) LOGBOOK.log('drying', { v: Number(dryingEl.value) });
  }
  function applySettings(log = true) {
    SET.pickup = Number(pickupEl.value) / 100 * 1.6;
    SET.saltGrain = Number(saltsizeEl.value) / 100 * 6.0;
    SET.runoff = runoffEl.checked;
    SET.pressureSize = pressEl.checked;
    SET.deplete = depleteEl.checked;
    // 0..4x. The old ceiling was 2x and the log shows it pinned there twice,
    // so the top of the dial was the answer rather than a limit.
    SET.tiltStrength = (Number(tiltStrEl.value) / 100) * 4;
    SET.pressRange = Number(pressRangeEl.value) / 100;
    const q = QUALITY[qualityEl.value] || QUALITY.balanced;
    sim.setQuality(q.maxSim, q.dpr);
    sim.params.saltGrain = SET.saltGrain;
    // sparser as the crystals get bigger, so grains never merge into a mat
    sim.params.saltSpacing = 4.0 + SET.saltGrain * 2.4;
    sim.setFlow(SET.runoff);
    if (log) LOGBOOK.log('settings', { ...SET });
  }
  for (const el of [pickupEl, saltsizeEl, runoffEl, pressEl, depleteEl, tiltStrEl, pressRangeEl, qualityEl]) {
    el.addEventListener('input', () => applySettings());
  }
  dryingEl.addEventListener('input', () => applyDrying());
  document.getElementById('setbtn').addEventListener('click', () => settingsPanel.classList.add('open'));
  document.getElementById('setclose').addEventListener('click', () => settingsPanel.classList.remove('open'));
  applyDrying(false);
  applySettings(false);

  document.getElementById('clear').addEventListener('click', () => {
    snapshot(); // clearing the sheet is undoable too
    LOGBOOK.log('clear');
    sim.clearAll();
  });
  const dryBtn = document.getElementById('dry');
  dryBtn.addEventListener('pointerdown', () => { sim.params.drySpeed = 30; LOGBOOK.log('drySpeed', { v: 30 }); });
  const dryOff = () => { sim.params.drySpeed = 1; LOGBOOK.log('drySpeed', { v: 1 }); };
  dryBtn.addEventListener('pointerup', dryOff);
  dryBtn.addEventListener('pointerleave', dryOff);
  document.getElementById('demo').addEventListener('click', () => DEMO.start(sim));

  const paperSel = document.getElementById('paper');
  for (const [key, p] of Object.entries(PAPERS)) {
    if (key === 'ceramic') continue;
    const o = document.createElement('option');
    o.value = key;
    o.textContent = p.label;
    paperSel.appendChild(o);
  }
  paperSel.value = sim.paperName;
  // -------------------------------------------------------- paint box -----
  // Choose which paints occupy the working pans, and how many there are.
  //
  // The palette's size is the main thing you can spend or save here: one
  // RGBA texture carries four channels, so 1-4 colours cost one texture
  // pair, 5-8 two, 9-12 three. Three colours is a third of the pigment work
  // of twelve, and a fourth colour is free on top of three.
  //
  // Adding a colour works at any time — the engine appends texture pairs
  // without touching what is already painted. Removing one shifts every
  // later pan down a slot, and a pan IS a channel, so that would recolour
  // strokes: it is offered only on an empty sheet, i.e. a new painting.
  const boxPanel = document.getElementById('boxpanel');
  const boxSlots = document.getElementById('boxslots');
  const boxGrid = document.getElementById('boxgrid');
  const boxCost = document.getElementById('boxcost');
  const boxRemove = document.getElementById('boxremove');
  let selectedSlot = 0;
  let sheetIsBlank = true; // set when the panel is opened

  function syncChannels() {
    const want = Math.max(1, Math.ceil(PANS.length / 4));
    sim.setChannelTextures(want);
  }

  function costLine() {
    const pairs = Math.max(1, Math.ceil(PANS.length / 4));
    const next = PANS.length % 4 === 0 ? ' — the next colour adds a layer' : '';
    return `${PANS.length} colour${PANS.length === 1 ? '' : 's'}, ${pairs} of 3 pigment layers${next}`;
  }

  function rebuildBox() {
    boxSlots.innerHTML = '';
    PANS.forEach((pan, i) => {
      const p = pan.paint;
      const wrap = document.createElement('div');
      wrap.className = 'panwrap';
      const b = document.createElement('button');
      b.className = 'pan' + (i === selectedSlot ? ' selected' : '');
      b.style.background = p.swatch;
      b.addEventListener('click', () => { selectedSlot = i; rebuildBox(); });
      const label = document.createElement('div');
      label.className = 'panlabel';
      label.textContent = p.short;
      wrap.appendChild(b); wrap.appendChild(label);
      boxSlots.appendChild(wrap);
    });
    // a trailing "+" tile, so adding a colour is where adding a colour goes
    if (PANS.length < MAX_CHANNELS) {
      const wrap = document.createElement('div');
      wrap.className = 'panwrap';
      const b = document.createElement('button');
      b.className = 'pan addpan';
      b.textContent = '+';
      b.title = 'Add a colour';
      b.addEventListener('click', () => {
        selectedSlot = -1; // the next box colour lands in a new pan
        rebuildBox();
        updateBrushView('Pick a colour from the box to add it');
      });
      const label = document.createElement('div');
      label.className = 'panlabel';
      label.textContent = 'add';
      wrap.appendChild(b); wrap.appendChild(label);
      if (selectedSlot === -1) b.classList.add('selected');
      boxSlots.appendChild(wrap);
    }

    boxCost.textContent = costLine();
    boxRemove.style.display = sheetIsBlank && PANS.length > 1 ? '' : 'none';
    boxRemove.textContent = selectedSlot >= 0 && PANS[selectedSlot]
      ? `Remove ${PANS[selectedSlot].paint.short}` : 'Remove colour';

    boxGrid.innerHTML = '';
    PAINTBOX.forEach((p) => {
      const wrap = document.createElement('div');
      wrap.className = 'panwrap';
      const b = document.createElement('button');
      const inUse = PANS.some((pan) => pan.paint.id === p.id);
      b.className = 'pan swatchramp' + (inUse ? ' inuse' : '');
      b.style.background = `linear-gradient(100deg, ${p.ramp.join(', ')})`;
      b.title = `${p.name} (${p.ci}) — tint ${p.tint}, granulation ${p.gamma}, grain ${p.grain}, staining ${p.omega}`;
      b.addEventListener('click', () => {
        if (selectedSlot === -1) {
          const slot = addPan(p.id);
          if (slot < 0) { updateBrushView('The palette is full at 12 colours'); return; }
          selectedSlot = slot;
          syncChannels();
          LOGBOOK.log('paletteAdd', { slot, id: p.id, colours: PANS.length });
          updateBrushView(`${p.name} added — ${costLine()}`);
        } else {
          // a pan IS a channel, so this recolours earlier strokes of the
          // paint that just left
          assignPan(selectedSlot, p.id);
          LOGBOOK.log('palette', { slot: selectedSlot, id: p.id });
          updateBrushView(`${p.name} now in pan ${selectedSlot + 1}`);
        }
        PARTS.fill(0);
        rebuildBox();
        rebuildPans();
      });
      const label = document.createElement('div');
      label.className = 'panlabel';
      label.textContent = p.short;
      wrap.appendChild(b); wrap.appendChild(label);
      boxGrid.appendChild(wrap);
    });
  }

  boxRemove.addEventListener('click', () => {
    if (!sheetIsBlank || selectedSlot < 0 || PANS.length <= 1) return;
    const gone = PANS[selectedSlot].paint.short;
    removePan(selectedSlot);
    selectedSlot = Math.min(selectedSlot, PANS.length - 1);
    PARTS.fill(0);
    syncChannels();
    LOGBOOK.log('paletteRemove', { colours: PANS.length });
    rebuildBox();
    rebuildPans();
    updateBrushView(`${gone} removed — ${costLine()}`);
  });

  function openBox(blank) {
    sheetIsBlank = blank;
    selectedSlot = Math.min(Math.max(selectedSlot, 0), PANS.length - 1);
    rebuildBox();
    boxPanel.classList.add('open');
  }
  document.getElementById('boxbtn').addEventListener('click', () => openBox(!sim.anythingWet() && sim.undoCount === 0));

  // A new painting: blank sheet, and the palette fully open — including the
  // number of colours, which can only shrink when there is nothing to lose.
  document.getElementById('newpainting').addEventListener('click', () => {
    if (!window.confirm('Start a new painting? The current sheet is cleared.')) return;
    sim.clearAll();
    sim.clearUndo();
    PARTS.fill(0);
    brush.pig.fill(0);
    LOGBOOK.log('newPainting');
    settingsPanel.classList.remove('open');
    refreshParts();
    rebuildPans();
    openBox(true);
    updateBrushView('New sheet — choose your colours');
  });

  document.getElementById('boxclose').addEventListener('click', () => {
    boxPanel.classList.remove('open');
  });

  paperSel.addEventListener('change', () => {
    sim.setPaper(paperSel.value);
    sim.markDirty();
    LOGBOOK.log('paper', { name: paperSel.value });
    updateBrushView(`${PAPERS[paperSel.value].label} paper (fresh sheet)`);
  });

  // Tilt: thick wet paint runs downhill; iOS needs a user-gesture permission.
  //
  // Two things the naive version got wrong. beta/gamma are angles of the
  // DEVICE, and on an iPad held in landscape the screen is rotated a quarter
  // turn inside it — so downhill came out sideways. The vector is rotated by
  // the screen angle into screen space. And nobody holds a tablet like a
  // sheet of paper on a table: enabling tilt now takes whatever angle you
  // are holding at that moment as level, and only movement away from it runs
  // the paint.
  const tiltBtn = document.getElementById('tilt');
  let tiltOn = false;
  let tiltRef = null;

  function screenAngle() {
    const a = (window.screen && screen.orientation && screen.orientation.angle);
    return ((a != null ? a : window.orientation || 0) * Math.PI) / 180;
  }

  let tiltGotEvent = false;

  function onOrient(e) {
    if (!tiltOn) return;
    if (e.beta == null && e.gamma == null) return; // a reading with no data
    tiltGotEvent = true;
    if (!tiltRef) tiltRef = { beta: e.beta, gamma: e.gamma || 0 };
    const dBeta = e.beta - tiltRef.beta;
    const dGamma = (e.gamma || 0) - tiltRef.gamma;
    // device frame
    const gx = Math.sin((dGamma * Math.PI) / 180);
    const gy = Math.sin((dBeta * Math.PI) / 180);
    // -> screen frame
    const a = screenAngle();
    const c = Math.cos(a), s = Math.sin(a);
    const sx = gx * c + gy * s;
    const sy = -gx * s + gy * c;
    const k = 0.25 * SET.tiltStrength;
    sim.params.tilt = [sx * k, -sy * k];
    if (Math.abs(sx) + Math.abs(sy) > 0.01) sim.markDirty();
    window.__tiltDebug = { beta: e.beta, gamma: e.gamma, dBeta, dGamma,
                           angleDeg: (a * 180) / Math.PI, tilt: sim.params.tilt };
  }

  // Motion access has to be asked for from a user gesture on iOS, and there
  // are three ways it can come back with no tilt: denied now, denied before
  // (in which case iOS never shows a prompt again), or granted but silent.
  // All three used to `return` without a word, so the button appeared to do
  // nothing at all — which is exactly what "it doesn't even ask" looks like.
  let tiltWatchdog = null;

  function stopTilt(msg) {
    tiltOn = false;
    tiltRef = null;
    clearTimeout(tiltWatchdog);
    window.removeEventListener('deviceorientation', onOrient);
    sim.params.tilt = [0, 0];
    tiltBtn.style.background = '';
    if (msg) updateBrushView(msg);
  }

  tiltBtn.addEventListener('click', async () => {
    if (tiltOn) { stopTilt('Tilt off'); LOGBOOK.log('tiltMode', { on: false }); return; }

    if (typeof DeviceOrientationEvent === 'undefined') {
      updateBrushView('This device reports no motion sensor');
      LOGBOOK.log('tiltMode', { on: false, why: 'unsupported' });
      return;
    }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      let verdict;
      try {
        verdict = await DeviceOrientationEvent.requestPermission();
      } catch (err) {
        // iOS throws when it will not even show the prompt — most often in an
        // installed web app, or when Motion & Orientation Access is switched
        // off for Safari altogether
        updateBrushView('iOS would not ask for motion access. Try Settings › Apps › Safari › Motion & Orientation Access, or open the site in Safari rather than the installed app.');
        LOGBOOK.log('tiltMode', { on: false, why: 'requestPermission threw: ' + err.message });
        return;
      }
      if (verdict !== 'granted') {
        updateBrushView(`Motion access ${verdict}. iOS only asks once — to change it, clear this site's data in Settings › Apps › Safari.`);
        LOGBOOK.log('tiltMode', { on: false, why: verdict });
        return;
      }
    }

    tiltOn = true;
    tiltRef = null; // however you are holding it right now IS level
    tiltGotEvent = false;
    tiltBtn.style.background = 'rgba(120,180,255,0.35)';
    window.addEventListener('deviceorientation', onOrient);
    LOGBOOK.log('tiltMode', { on: true, screenAngle: Math.round((screenAngle() * 180) / Math.PI) });
    updateBrushView('Tilt on — the angle you are holding now is level');
    // granted, listening, and still nothing arriving is its own failure
    clearTimeout(tiltWatchdog);
    tiltWatchdog = setTimeout(() => {
      if (!tiltGotEvent) {
        stopTilt('Motion access was granted but no readings are arriving. In an installed web app iOS often withholds them — open the site in Safari for tilt.');
        LOGBOOK.log('tiltMode', { on: false, why: 'granted but silent' });
      }
    }, 2000);
  });

  // What a touch on the paper does: paint, or sprinkle salt. There was a
  // water-drop mode too; a rinsed brush with the water slider up and no
  // colour on it drops exactly the same clean water, so it was a button for
  // something the brush already does.
  const MODE_BTN = { salt: 'salt' };
  const saltBtn = document.getElementById('salt');
  let mode = 'brush';
  const MODE_MSG = {
    brush: 'Back to the brush',
    salt: 'Salt: tap or drag over a damp wash to sprinkle',
  };
  function setMode(m, msg) {
    mode = m;
    for (const [key, id] of Object.entries(MODE_BTN)) {
      document.getElementById(id).style.background = m === key ? 'rgba(255,255,255,0.4)' : '';
    }
    brushcursor.style.borderStyle = m === 'brush' ? 'solid' : 'dashed';
    if (msg === null) updateBrushView(); // keep whatever text the tool set
    else updateBrushView(msg !== undefined ? msg : MODE_MSG[m]);
  }
  for (const [key, id] of Object.entries(MODE_BTN)) {
    document.getElementById(id).addEventListener('click', () => setMode(mode === key ? 'brush' : key));
  }
  // returning to any brush tool clearly means you're done — leaving a mode
  // on silently was swallowing paint strokes
  for (const id of ['clean']) {
    document.getElementById(id).addEventListener('pointerdown', () => { if (mode !== 'brush') setMode('brush', null); });
  }
  paletteEl.addEventListener('pointerdown', () => { if (mode !== 'brush') setMode('brush', null); });

  // ---------------------------------------------------------------- undo --
  // A snapshot is taken before anything that changes the sheet, and the log
  // records both the snapshot and the undo so a session still replays
  // exactly. Depth is however many snapshots fit the memory budget (see
  // sim.undoDepth) — one or two on a big canvas, more on a phone.
  function snapshot() {
    if (sim.pushUndo()) LOGBOOK.log('snap');
  }
  document.getElementById('undo').addEventListener('click', () => {
    sim.markDirty();
    if (sim.undo()) {
      LOGBOOK.log('undo');
      updateBrushView(`Undone — ${sim.undoCount} step${sim.undoCount === 1 ? '' : 's'} left`);
    } else {
      updateBrushView('Nothing left to undo');
    }
  });

  const wetviewBtn = document.getElementById('wetview');
  wetviewBtn.addEventListener('click', () => {
    sim.wetView = !sim.wetView;
    sim.markDirty(); // the picture changes even though the water does not
    wetviewBtn.style.background = sim.wetView ? 'rgba(120,180,255,0.35)' : '';
    updateBrushView(sim.wetView ? 'Wetness view: blue=wet, teal=satin, amber=damp' : undefined);
  });

  document.getElementById('log').addEventListener('click', () => {
    LOGBOOK.download({ paper: paperSel.value });
    updateBrushView('Session log exported');
  });

  document.getElementById('save').addEventListener('click', () => {
    sim.render();
    canvas.toBlob((blob) => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'watercolor.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    });
  });

  // ----------------------------------------------------- painting: paper ---
  const pigDep = new Float32Array(NPIG);
  let painting = false;
  let last = null;
  let salting = false;
  let saltLast = null;

  // Apple Pencil reports 0..1 force; mouse/finger report 0 or 0.5. Give the
  // pen a wider, slightly convex range so light strokes go genuinely fine
  // and a hard press spreads the whole belly of the brush.
  // A Pencil spends nearly all its time between about 0.05 and 0.5 of full
  // scale; you have to lean on it to reach 1.0. The old curve was p^1.4,
  // which is convex — it squashed exactly that working range flat and only
  // opened up under a hard press. A concave curve spends the size range
  // where the hand actually is.
  function pressureOf(e) {
    if (e.pointerType === 'pen') {
      const p = Math.min(Math.max(e.pressure > 0 ? e.pressure : 0.4, 0), 1);
      return Math.pow(p, 0.55);
    }
    return e.pressure > 0 && e.pressure !== 0.5 ? e.pressure : 0.55;
  }

  function brushSize(pressure) {
    const base = Number(sizeEl.value);
    if (!SET.pressureSize) return base;
    // pressRange 0 = size fixed, 1 = a light touch is a third of the width
    // and a firm one about half again as wide
    const r = SET.pressRange;
    return base * (1 - r * 0.85 + pressure * r * 1.5);
  }

  function dab(x, y, pressure) {
    DEMO.stop();
    const size = brushSize(pressure);
    const total = brushTotal();
    // Water delivered depends ONLY on how wet the brush is — a bone-dry
    // brush wets the paper not at all, however much paint it carries.
    const water = 0.055 * brush.water * (0.5 + 0.5 * pressure);
    // Pigment delivered depends ONLY on the paint on the hairs.
    const amount = 0.4 * (0.4 + 0.6 * pressure);
    for (let i = 0; i < NPIG; i++) pigDep[i] = brush.pig[i] * amount;
    // clean damp brush lifts pigment instead of depositing
    const scrub = total < 0.02 ? 0.08 * pressure * brush.water : 0;
    sim.splat(x, y, size, water, pigDep, brush.water, scrub);
    // ...and a clean brush carrying real water re-dissolves paint that has
    // only just set, which is how a bloom starts. The water-drop tool used
    // to be the only way to ask for this.
    if (total < 0.02 && brush.water > 0.35) sim.rewet();
  }

  function deplete(dist) {
    // With depletion switched off the hairs hold their load: every line
    // comes out the same however many you draw. Handy for flat colour and
    // for long even lines, and the opposite of how a real brush behaves —
    // which is exactly why it is a choice.
    if (!SET.deplete) return;
    // Water leaves faster than pigment (the paper drinks it), so a long
    // stroke gets progressively drier and more concentrated before it
    // finally runs out — the natural drybrush tail.
    brush.water *= Math.exp(-dist / 900);
    const k = Math.exp(-dist / 1600);
    for (let i = 0; i < NPIG; i++) brush.pig[i] *= k;
  }

  function strokeTo(x, y, pressure) {
    if (!last) { dab(x, y, pressure); last = { x, y }; return; }
    const dx = x - last.x, dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    const stepLen = Math.max(Number(sizeEl.value) * 0.3, 2);
    // A pen held still still reports samples, and each one used to become a
    // dab on the same spot: in one recorded session 31% of all dabs landed
    // less than a third of a step from the one before. That is not paint the
    // artist asked for, it is just fill rate — and heat. Hold the position
    // until the brush has actually moved.
    if (dist < stepLen * 0.34) return;
    deplete(dist);
    const n = Math.floor(dist / stepLen);
    for (let i = 1; i <= n; i++) {
      dab(last.x + (dx * i) / (n + 1), last.y + (dy * i) / (n + 1), pressure);
    }
    dab(x, y, pressure);
    last = { x, y };
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (mode === 'salt') {
      salting = true;
      snapshot();
      saltLast = { x: e.offsetX, y: e.offsetY };
      const r = Number(sizeEl.value) * 1.6;
      sim.sprinkleSalt(e.offsetX, e.offsetY, r);
      LOGBOOK.log('salt', { x: Math.round(e.offsetX), y: Math.round(e.offsetY), r: Math.round(r) });
      return;
    }
    painting = true;
    snapshot();
    last = null;
    strokeTo(e.offsetX, e.offsetY, pressureOf(e));
  });
  canvas.addEventListener('pointermove', (e) => {
    const size = brushSize(painting ? pressureOf(e) : 0.6);
    brushcursor.style.display = 'block';
    brushcursor.style.left = e.clientX + 'px';
    brushcursor.style.top = e.clientY + 'px';
    brushcursor.style.width = size * 2 + 'px';
    brushcursor.style.height = size * 2 + 'px';
    if (salting) {
      e.preventDefault();
      const dist = saltLast ? Math.hypot(e.offsetX - saltLast.x, e.offsetY - saltLast.y) : 99;
      if (dist > Number(sizeEl.value) * 1.2) {
        const r = Number(sizeEl.value) * 1.6;
        sim.sprinkleSalt(e.offsetX, e.offsetY, r);
        LOGBOOK.log('salt', { x: Math.round(e.offsetX), y: Math.round(e.offsetY), r: Math.round(r) });
        saltLast = { x: e.offsetX, y: e.offsetY };
      }
      return;
    }
    if (!painting) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) strokeTo(ev.offsetX, ev.offsetY, pressureOf(ev));
    updateBrushView();
  });
  canvas.addEventListener('pointerleave', () => { brushcursor.style.display = 'none'; });
  const end = () => {
    painting = false; last = null; salting = false; saltLast = null;
    updateBrushView();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  // -------------------------------------------------- persistence / PWA ---
  // Snapshots the dried painting + workbench state; wet paint "dries"
  // across reloads like a real sheet left overnight.
  let lastSavedFrame = -1;
  let saving = false;

  async function saveState() {
    if (saving || LOGBOOK.frame === lastSavedFrame) return;
    saving = true;
    try {
      const snap = sim.readDeposits();
      await STORE.put('state', {
        v: 1,
        savedAt: Date.now(),
        paper: { name: sim.paperName, seed: sim.paperSeed },
        channels: CHANNELS.map((c) => (c ? c.id : null)),
        pans: PANS.map((p) => ({ id: p.paint.id, chan: p.chan })),
        colours: PANS.length,
        brush: { water: brush.water, pig: Array.from(brush.pig) },
        parts: Array.from(PARTS),
        drying: Number(dryingEl.value),
        settings: {
          pickup: Number(pickupEl.value),
          saltsize: Number(saltsizeEl.value), runoff: runoffEl.checked,
          presssize: pressEl.checked, deplete: depleteEl.checked,
          tiltstrength: Number(tiltStrEl.value), pressrange: Number(pressRangeEl.value),
          quality: qualityEl.value,
        },
        painting: snap,
        log: LOGBOOK.export({ paper: sim.paperName }),
      });
      lastSavedFrame = LOGBOOK.frame;
    } catch (e) { /* storage full or unavailable: skip silently */ }
    saving = false;
  }

  async function restoreState() {
    try {
      const st = await STORE.get('state');
      if (!st || st.v !== 1) return;
      restoreBindings(st.channels, st.pans);
      // a restored palette may be a different size than the default
      sim.setChannelTextures(Math.max(1, Math.ceil(PANS.length / 4)));
      rebuildPans();
      if (st.paper && st.paper.name) {
        paperSel.value = st.paper.name;
        sim.setPaper(st.paper.name, st.paper.seed);
      }
      if (st.painting) sim.writeDeposits(st.painting);
      if (st.brush) {
        brush.water = st.brush.water;
        brush.pig.set(st.brush.pig.slice(0, NPIG));
      }
      if (st.parts) { PARTS.set(st.parts.slice(0, NPIG)); refreshParts(); }
      if (st.drying != null) { dryingEl.value = st.drying; applyDrying(false); }
      if (st.settings) {
        const s = st.settings;
        if (s.pickup != null) pickupEl.value = s.pickup;
        if (s.saltsize != null) saltsizeEl.value = s.saltsize;
        if (s.runoff != null) runoffEl.checked = s.runoff;
        if (s.presssize != null) pressEl.checked = s.presssize;
        if (s.deplete != null) depleteEl.checked = s.deplete;
        if (s.tiltstrength != null) tiltStrEl.value = s.tiltstrength;
        if (s.pressrange != null) pressRangeEl.value = s.pressrange;
        if (s.quality) qualityEl.value = s.quality;
        applySettings(false);
      }
      if (st.log) LOGBOOK.restore(st.log);
      updateBrushView('Restored previous session');
    } catch (e) { /* corrupt/missing state: start fresh */ }
  }
  restoreState();

  setInterval(saveState, 20000);
  window.addEventListener('pagehide', saveState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveState();
  });

  document.getElementById('reset').addEventListener('click', async () => {
    if (!window.confirm('Reset everything? This clears the painting, palette and saved state.')) return;
    await STORE.clear();
    LOGBOOK.reset();
    location.reload();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // --------------------------------------------------------------- loop ---
  window.addEventListener('resize', () => sim.resize());
  window.addEventListener('orientationchange', () => setTimeout(() => sim.resize(), 250));

  function frame() {
    if (!window.__PAUSED) {
      LOGBOOK.tick();
      REPLAY.tick();
      DEMO.tick(sim);
      // A dry, untouched sheet has nothing to compute and nothing new to
      // draw — and the canvas keeps its last frame — so on an idle sheet
      // this costs nothing at all.
      if (sim.needsStep()) {
        sim.step();
        sim.render();
      }
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__uv = updateBrushView; // for the console and automated tests
  updateBrushView('Dip a pan for paint, 💧 for water — they are separate. 🌀 rinses, 🧽 blots water off.');
})();
