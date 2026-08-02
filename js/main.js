// UI wiring: physical painter's workbench.
//
// The brush is a stateful object carrying water + a 16-pigment load. You dip
// it in pans (palette), mix on the ceramic tray (a second instance of the
// full watercolor sim with zero absorbency), dip the water glass to dilute,
// wipe it on the sponge, and paint. Nothing refills by itself: a stroke that
// runs long goes dry-brush, exactly like the real thing.

'use strict';

(() => {
  const canvas = document.getElementById('canvas');
  const trayCanvas = document.getElementById('tray');
  let sim, tray;
  try {
    sim = new WatercolorSim(canvas);
    tray = new WatercolorSim(trayCanvas, {
      paper: 'ceramic',
      maxSim: 1024, // the plate is 8 segments wide; keep per-segment detail
      wells: 8,     // one dished well per segment, with a rim that holds water
      params: {
        evap: 0.000004,  // puddles in the tray last for ages
        edgeEvap: 4.0,
        maran: 0.5,
        // Paint on a plate must stay dilutable: it barely settles, and what
        // does settle re-dissolves the moment water reaches it. With the old
        // low lift / high settle the pigment locked onto the ceramic and no
        // amount of added water could thin the mix down.
        lift: 0.4,
        settle: 0.05,
        pigDiff: 0.35,   // added water carries pigment through the puddle
        // a puddle in a well levels out instead of standing in a heap, so
        // added water actually spreads the colour thinner
        grav: 14.0,
        smooth: 0.15,
      },
    });
  } catch (e) {
    const err = document.getElementById('err');
    err.style.display = 'flex';
    err.textContent = e.message;
    throw e;
  }
  window.sim = sim; // for console tinkering / automated tests
  window.tray = tray;
  LOGBOOK.attach(sim, 'paper');
  LOGBOOK.attach(tray, 'tray');

  const NPIG = N_CHANNELS; // brush carries per-CHANNEL loads

  // -------------------------------------------------------------- brush ---
  // Two INDEPENDENT quantities, exactly as on a real brush:
  //   water  - how much fluid the hairs carry (0 bone dry .. 1 dripping).
  //            This alone decides how wet the paper gets.
  //   pig[]  - how much pigment sits on the hairs. This alone decides how
  //            strong the color is.
  // Their ratio is the paint's consistency (tea .. butter). So all four
  // combinations are reachable: potent-and-dry (drybrush), potent-and-wet
  // (juicy dark wash), pale-and-dry (scumble), pale-and-wet (pale wash).
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

  const brushview = document.getElementById('brushview');
  const brushcursor = document.getElementById('brushcursor');
  const pignameEl = document.getElementById('pigname');
  const consistencyEl = document.getElementById('consistency');

  function brushTotal() {
    let t = 0;
    for (let i = 0; i < NPIG; i++) t += brush.pig[i];
    return t;
  }

  // ------------------------------------------------- live brush sliders ---
  // Three sliders over the same two-axis brush. Paint and Water are the
  // actual state; Dilution is their ratio, and dragging it re-scales the
  // pigment at constant water — i.e. it thins or thickens the paint without
  // changing how wet the paper will get.
  const paintSl = document.getElementById('paintload');
  const waterSl = document.getElementById('waterload');
  const dilSl = document.getElementById('dilution');
  let sliderEcho = false; // suppress feedback while we write slider values

  const dilFromSlider = (v) => 0.02 + 0.88 * Math.pow(1 - v / 100, 2);
  const sliderFromDil = (r) => 100 * (1 - Math.sqrt(Math.max(r - 0.02, 0) / 0.88));

  paintSl.addEventListener('input', () => {
    if (sliderEcho) return;
    const target = (Number(paintSl.value) / 100) * PIG_CAP;
    if (brushTotal() < 1e-5) { updateBrushView('Dip a pan first — no paint on the brush to scale'); return; }
    setPaintLoad(target);
    updateBrushView(`Paint ${paintSl.value}% — ${consistency()}`);
  });
  waterSl.addEventListener('input', () => {
    if (sliderEcho) return;
    brush.water = Number(waterSl.value) / 100;
    updateBrushView(`Water ${waterSl.value}% — ${consistency()}`);
  });
  dilSl.addEventListener('input', () => {
    if (sliderEcho) return;
    if (brushTotal() < 1e-5) { updateBrushView('Dip a pan first — nothing to dilute'); return; }
    const r = dilFromSlider(Number(dilSl.value));
    // r = p / (p + 2.2w)  ->  p = r*2.2w / (1-r), at constant water
    const w = Math.max(brush.water, 0.02);
    setPaintLoad(Math.min(PIG_CAP, (r * 2.2 * w) / Math.max(1 - r, 0.02)));
    updateBrushView(`Dilution — ${consistency(r)}`);
  });

  function updateBrushView(msg) {
    const total = brushTotal();
    // thickness scales with load so a heavy brush looks like creamy masstone
    // and a nearly-spent one shows a pale tint
    const color = total > 0.01 ? CHANNELS.kmColor(brush.pig, 1.5 + 12 * Math.min(total, 1.2)) : 'rgb(238,236,230)';
    brushview.style.background = color;
    brushview.style.borderColor = `rgba(160,200,255,${0.25 + 0.6 * brush.water})`;
    // wet brush looks glossy, dry brush matte
    brushview.style.boxShadow = `inset 0 -5px 8px rgba(0,0,0,0.25), inset 0 ${2 + 4 * brush.water}px ${3 + 6 * brush.water}px rgba(255,255,255,${0.15 + 0.35 * brush.water})`;
    // the sliders double as the level meters: writing them back keeps the
    // display honest whichever way the brush was changed (dip, swirl, stroke)
    sliderEcho = true;
    paintSl.value = String(Math.round(Math.min(total / PIG_CAP, 1) * 100));
    waterSl.value = String(Math.round(brush.water * 100));
    dilSl.value = String(Math.round(sliderFromDil(dilutionRatio())));
    sliderEcho = false;
    paintSl.style.setProperty('--fill', color);
    brushcursor.style.background = total > 0.01 ? color.replace('rgb', 'rgba').replace(')', ',0.35)') : 'rgba(200,220,255,0.2)';
    consistencyEl.textContent = consistency();
    if (msg !== undefined) pignameEl.textContent = msg;
  }

  // -------------------------------------------------------------- swirl ---
  // Loading a brush is a swirl, not a tap. Press and work the brush around
  // in the pan (or the water, or the sponge) and it keeps taking up more;
  // the longer the travel, the fuller the load. A plain tap still gives one
  // dose, so nothing that worked before stops working.
  function swirl(el, step, done) {
    let active = false, lastPt = null, total = 0;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      active = true;
      lastPt = { x: e.clientX, y: e.clientY };
      total = 1;
      try { el.setPointerCapture(e.pointerId); } catch { /* mouse w/o capture */ }
      step(1);
    });
    el.addEventListener('pointermove', (e) => {
      if (!active) return;
      e.preventDefault();
      const d = Math.hypot(e.clientX - lastPt.x, e.clientY - lastPt.y);
      if (d < 3) return;
      lastPt = { x: e.clientX, y: e.clientY };
      // ~55px of swirling is worth another full dip
      const dose = Math.min(d, 30) / 55;
      total += dose;
      step(dose);
    });
    const stop = () => {
      if (!active) return;
      active = false; lastPt = null;
      if (done) done(total);
    };
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  }

  // ------------------------------------------------------------ palette ---
  // Pans show the darkest possible mass tone (like real dried pans) with a
  // short name label to tell the dark ones apart.
  const paletteEl = document.getElementById('palette');

  function rebuildPans() {
    paletteEl.innerHTML = '';
    PANS.forEach((pan, i) => {
      const p = pan.paint;
      const wrap = document.createElement('div');
      wrap.className = 'panwrap';
      const b = document.createElement('button');
      b.className = 'pan';
      b.style.background = p.swatch;
      b.title = `${p.name} (${p.ci}) — press and swirl to keep loading`;
      const label = document.createElement('div');
      label.className = 'panlabel';
      label.textContent = p.short;
      wrap.appendChild(b);
      wrap.appendChild(label);
      // The tap target is the whole wrapper, name label included. The pans
      // are short so the bar stays out of the way, and this buys the touch
      // area back without costing any height.
      swirl(wrap, (dose) => {
        // a wet brush dissolves the hard pan and picks up a lot; a dry one
        // only scuffs a little colour off it
        const chan = PANS[i].chan;
        const pickup = (0.25 + 0.75 * brush.water) * SET.pickup * dose;
        brush.pig[chan] = Math.min(PIG_CAP, brush.pig[chan] + pickup);
        brush.water = Math.max(brush.water - 0.05 * dose, 0);
        updateBrushView(`${PANS[i].paint.name} (${PANS[i].paint.ci}) — ${consistency()}`);
      }, (total) => {
        LOGBOOK.log('dipPan', {
          pig: PANS[i].chan, name: PANS[i].paint.name,
          doses: Math.round(total * 100) / 100,
          load: Math.round(brush.pig[PANS[i].chan] * 100) / 100,
          water: Math.round(brush.water * 100) / 100,
        });
      });
      paletteEl.appendChild(wrap);
    });
  }
  rebuildPans();
  window.__refreshPalette = rebuildPans;

  // ------------------------------------------- water / clean / sponge -----
  // Tip dip: only the point of the brush touches the water, so it gains
  // water and keeps nearly all its paint. Hold and swirl to take up more
  // (and wash out more). 🌀 is the real rinse.
  swirl(document.getElementById('glass'), (dose) => {
    brush.water = Math.min(1, brush.water + 0.28 * SET.waterDip * dose);
    const k = Math.pow(0.97, dose);
    for (let i = 0; i < NPIG; i++) brush.pig[i] *= k;
    updateBrushView(`Water — ${consistency()}`);
  }, (total) => LOGBOOK.log('glass', {
    doses: Math.round(total * 100) / 100,
    water: Math.round(brush.water * 100) / 100,
  }));

  document.getElementById('clean').addEventListener('pointerdown', () => {
    // rinsed and shaken out: no colour and no water at all. Whatever you do
    // next starts from a genuinely empty brush.
    brush.pig.fill(0);
    brush.water = 0;
    LOGBOOK.log('clean');
    updateBrushView('Brush clean — no colour, no water');
  });

  // Sponge: sheds water, keeps most of the pigment (the "thirsty brush" for
  // controlled dry-brush and for lifting). Hold and wipe to keep drying it.
  swirl(document.getElementById('sponge'), (dose) => {
    brush.water *= Math.pow(0.25, dose);
    const k = Math.pow(0.9, dose);
    for (let i = 0; i < NPIG; i++) brush.pig[i] *= k;
    updateBrushView(`Blotted — ${consistency()}`);
  }, (total) => LOGBOOK.log('sponge', {
    doses: Math.round(total * 100) / 100,
    water: Math.round(brush.water * 100) / 100,
  }));

  // ----------------------------------------------------------- controls ---
  const sizeEl = document.getElementById('size');

  // ----------------------------------------------------------- settings ---
  // Workbench preferences, persisted with the rest of the session state.
  const SET = {
    pickup: 0.8,       // paint taken per dip / per swirl-dose
    waterDip: 1.0,     // water taken per dip / per swirl-dose
    saltGrain: 2.6,    // salt crystal size
    runoff: true,      // paint and water travel across the sheet
    pressureSize: true,// stylus pressure drives brush size
    deplete: true,     // the brush runs out as you paint
  };
  window.SET = SET;

  // ------------------------------------------------------------ version ---
  // Which build is actually running, and is it the one that was deployed?
  // The stamp comes from CI rather than a hand-bumped number, so it cannot
  // drift from what is served. "Check for update" re-fetches the stamp with
  // caching bypassed and compares — that is the difference between "the
  // deploy finished" and "the deploy reached this device", which a service
  // worker and an installed PWA can otherwise hide.
  const buildLabel = `${BUILD.commit}${BUILD.date ? ` · ${BUILD.date}` : ''}`;
  const buildEl = document.getElementById('buildinfo');
  const updNote = document.getElementById('updnote');
  buildEl.textContent = buildLabel;

  document.getElementById('checkupd').addEventListener('click', async () => {
    updNote.textContent = 'Checking…';
    try {
      const res = await fetch(`js/version.js?t=${Date.now()}`, { cache: 'no-store' });
      const txt = await res.text();
      const commit = (txt.match(/commit:\s*'([^']*)'/) || [])[1];
      const date = (txt.match(/date:\s*'([^']*)'/) || [])[1] || '';
      if (!commit) { updNote.textContent = 'Could not read the version on the server.'; return; }
      if (commit === BUILD.commit) {
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
  const waterdipEl = document.getElementById('waterdip');
  const saltsizeEl = document.getElementById('saltsize');
  const runoffEl = document.getElementById('runoff');
  const pressEl = document.getElementById('presssize');
  const depleteEl = document.getElementById('deplete');

  // Drying speed: slider 0..100 -> 0.25x .. 4x around the base rate, so the
  // sheet can be kept open for minutes or pushed to dry in seconds.
  function applyDrying(log = true) {
    const t = Number(dryingEl.value) / 100;
    sim.params.dryScale = 0.25 * Math.pow(16, t);
    if (log) LOGBOOK.log('drying', { v: Number(dryingEl.value) });
  }
  function applySettings(log = true) {
    SET.pickup = Number(pickupEl.value) / 100 * 1.6;
    SET.waterDip = Number(waterdipEl.value) / 100 * 2.0;
    SET.saltGrain = Number(saltsizeEl.value) / 100 * 6.0;
    SET.runoff = runoffEl.checked;
    SET.pressureSize = pressEl.checked;
    SET.deplete = depleteEl.checked;
    sim.params.saltGrain = SET.saltGrain;
    // sparser as the crystals get bigger, so grains never merge into a mat
    sim.params.saltSpacing = 4.0 + SET.saltGrain * 2.4;
    sim.setFlow(SET.runoff);
    tray.setFlow(true); // the plate always flows: that's how mixing works
    if (log) LOGBOOK.log('settings', { ...SET });
  }
  for (const el of [pickupEl, waterdipEl, saltsizeEl, runoffEl, pressEl, depleteEl]) {
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
  // Choose which 8 paints from the full box occupy the working pans.
  const boxPanel = document.getElementById('boxpanel');
  const boxSlots = document.getElementById('boxslots');
  const boxGrid = document.getElementById('boxgrid');
  let selectedSlot = 0;

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
    boxGrid.innerHTML = '';
    PAINTBOX.forEach((p) => {
      const wrap = document.createElement('div');
      wrap.className = 'panwrap';
      const b = document.createElement('button');
      const inUse = PANS.some((pan) => pan.paint.id === p.id);
      b.className = 'pan' + (inUse ? ' inuse' : '');
      b.style.background = p.swatch;
      b.title = `${p.name} (${p.ci}) — tint ${p.tint}, granulation ${p.gamma}, grain ${p.grain}, staining ${p.omega}`;
      b.addEventListener('click', () => {
        // swapping a pan binds a NEW channel: strokes already painted with
        // the old paint keep their color and identity
        assignPan(selectedSlot, p.id);
        LOGBOOK.log('palette', { slot: selectedSlot, id: p.id });
        rebuildBox();
        rebuildPans();
        updateBrushView(`${p.name} now in pan ${selectedSlot + 1}`);
      });
      const label = document.createElement('div');
      label.className = 'panlabel';
      label.textContent = p.short;
      wrap.appendChild(b); wrap.appendChild(label);
      boxGrid.appendChild(wrap);
    });
  }
  document.getElementById('boxbtn').addEventListener('click', () => {
    rebuildBox();
    boxPanel.classList.add('open');
  });
  document.getElementById('boxclose').addEventListener('click', () => {
    boxPanel.classList.remove('open');
  });

  paperSel.addEventListener('change', () => {
    sim.setPaper(paperSel.value);
    LOGBOOK.log('paper', { name: paperSel.value });
    updateBrushView(`${PAPERS[paperSel.value].label} paper (fresh sheet)`);
  });

  // Tilt: thick wet paint runs downhill; iOS needs a user-gesture permission.
  const tiltBtn = document.getElementById('tilt');
  let tiltOn = false;
  function onOrient(e) {
    if (!tiltOn || e.beta == null) return;
    const gx = Math.sin((e.gamma || 0) * Math.PI / 180);
    const gy = Math.sin((e.beta || 0) * Math.PI / 180);
    const k = 0.25;
    sim.params.tilt = [gx * k, -gy * k];
  }
  tiltBtn.addEventListener('click', async () => {
    if (!tiltOn && typeof DeviceOrientationEvent !== 'undefined' &&
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      try {
        if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') return;
      } catch { return; }
    }
    tiltOn = !tiltOn;
    tiltBtn.style.background = tiltOn ? 'rgba(120,180,255,0.35)' : '';
    if (tiltOn) window.addEventListener('deviceorientation', onOrient);
    else { window.removeEventListener('deviceorientation', onOrient); sim.params.tilt = [0, 0]; }
  });

  // What a touch on the paper does: paint, sprinkle salt, or drop clean
  // water. Salt and water-drop are sticky modes, so they get a dashed
  // cursor and are dismissed by touching any brush tool.
  const MODE_BTN = { salt: 'salt', drop: 'drop', dryer: 'dryer' };
  const saltBtn = document.getElementById('salt');
  let mode = 'brush';
  const MODE_MSG = {
    brush: 'Back to the brush',
    salt: 'Salt: tap or drag over a damp wash to sprinkle',
    drop: 'Water drop: tap a wash that has lost its shine to bloom it',
    dryer: 'Dryer: hold to dry just that spot, drag to blow the paint along',
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
  for (const id of ['glass', 'clean', 'sponge']) {
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
  // dryer: held position + the direction the nozzle is travelling, applied
  // every frame for as long as the pointer is down
  let drying_ = null;

  // Apple Pencil reports 0..1 force; mouse/finger report 0 or 0.5. Give the
  // pen a wider, slightly convex range so light strokes go genuinely fine
  // and a hard press spreads the whole belly of the brush.
  function pressureOf(e) {
    if (e.pointerType === 'pen') {
      const p = e.pressure > 0 ? e.pressure : 0.5;
      return 0.12 + 1.05 * Math.pow(p, 1.4);
    }
    return e.pressure > 0 && e.pressure !== 0.5 ? e.pressure : 0.6;
  }

  function brushSize(pressure) {
    const base = Number(sizeEl.value);
    return SET.pressureSize ? base * (0.25 + 0.75 * pressure) : base;
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
    deplete(dist);
    const stepLen = Math.max(Number(sizeEl.value) * 0.3, 2);
    const n = Math.floor(dist / stepLen);
    for (let i = 1; i <= n; i++) {
      dab(last.x + (dx * i) / (n + 1), last.y + (dy * i) / (n + 1), pressure);
    }
    dab(x, y, pressure);
    last = { x, y };
  }

  function dropAt(x, y) {
    // a drop off the brush is much bigger than the brush's own footprint
    const r = Number(sizeEl.value) * 1.5 + 8;
    sim.dropWater(x, y, r, 1.0);
    LOGBOOK.log('drop', { x: Math.round(x), y: Math.round(y), r: Math.round(r) });
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
    if (mode === 'drop') {
      snapshot();
      dropAt(e.offsetX, e.offsetY);
      return;
    }
    if (mode === 'dryer') {
      snapshot();
      drying_ = { x: e.offsetX, y: e.offsetY, dx: 0, dy: 0 };
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
    if (drying_) {
      e.preventDefault();
      const dx = e.offsetX - drying_.x, dy = e.offsetY - drying_.y;
      const d = Math.hypot(dx, dy);
      // the air travels the way the nozzle is moving; a held nozzle just dries
      if (d > 0.5) drying_ = { x: e.offsetX, y: e.offsetY, dx: dx / d, dy: dy / d };
      else drying_ = { ...drying_, x: e.offsetX, y: e.offsetY };
      return;
    }
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
    if (drying_) { LOGBOOK.log('dryerOff'); drying_ = null; }
    updateBrushView();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  // ------------------------------------------------------ mixing: tray ----
  const trayPig = new Float32Array(NPIG);
  let mixing = false;
  let trayLast = null;
  let lastPickup = 0;

  // Water pickup is only allowed when the puddle existed BEFORE this stroke:
  // otherwise the brush would re-absorb the water it just deposited and get
  // wetter by merely touching a dry tray.
  let strokeHadPuddle = false;

  // Mixing is an EXCHANGE, and it has to balance both ways.
  //
  // The first version shed 30% of the brush's load onto the plate per dab
  // while taking only 1.5% off the brush, and picked colour back up without
  // removing any — so every pass round the loop multiplied the pigment on
  // the plate. Smearing to dilute a mix made it darker and darker.
  //
  // Now: whatever the brush sheds it loses, and whatever it lifts is
  // scrubbed off the plate. Brush and puddle settle toward the same
  // concentration, exactly as they do on a real palette.
  const GIVE = 0.22; // fraction of the load shed per dab
  const TAKE = 0.30; // fraction of the load exchanged for local fluid
  // set by a pickup, consumed by the next dab: the fluid the brush lifted
  // has to come off the plate, or pigment is created out of nothing
  let pendingScrub = 0;

  function trayDab(x, y) {
    // Same two-axis rule as the paper: a dry brush loaded with paint leaves
    // thick paint on the plate and adds NO water to it.
    const water = 0.05 * brush.water;
    for (let i = 0; i < NPIG; i++) trayPig[i] = brush.pig[i] * GIVE * 1.4;
    tray.splat(x, y, SEGW * 0.058, water, trayPig, brush.water, pendingScrub);
    pendingScrub = 0;
    for (let i = 0; i < NPIG; i++) brush.pig[i] *= 1 - GIVE;
    brush.water *= 0.95;
  }

  // What the brush lifts off the plate is FLUID, and what matters about that
  // fluid is its CONCENTRATION — pigment per unit of water — not the raw
  // amount of pigment sitting there.
  //
  // The first version blended raw pigment amounts, which made dilution
  // impossible: a rinsed brush touched a strong puddle, instantly reloaded
  // to full strength, and put that pigment straight back down. However much
  // water you added, the brush just shuttled the same paint around. (The
  // session log shows it exactly: a brush at 0.00 pigment reading 0.10 one
  // frame later and 0.21 a few frames after that.)
  //
  // Sampling the ratio instead means adding water genuinely thins the mix:
  // more water under the brush -> lower concentration -> paler pickup, and
  // the pale pickup is what gets laid down next.
  function trayPickup(x, y) {
    const now = performance.now();
    if (now - lastPickup < 60) return;
    lastPickup = now;
    const m = tray.readMix(x, y);
    let pigSum = 0;
    for (let i = 0; i < NPIG; i++) pigSum += m.pig[i];
    // Concentration of the fluid under the brush. The 22 weights water
    // against pigment in the sim's own units (measured: thick paint on the
    // plate sits near pig 2.9 / water 0.19, the same paint well watered
    // down near pig 2.5 / water 0.78 — a 5x change in ratio that the naive
    // pigment-only reading threw away entirely).
    const conc = pigSum / (pigSum + 22 * m.water + 0.02);
    const strength = Math.min(1, conc / 0.45); // 0.45 == a fully loaded brush
    if (pigSum > 0.01) {
      for (let i = 0; i < NPIG; i++) {
        const target = (m.pig[i] / pigSum) * strength * PIG_CAP;
        brush.pig[i] = brush.pig[i] * (1 - TAKE) + target * TAKE;
      }
      pendingScrub = TAKE * 0.5; // that fluid leaves the plate with the brush
    } else if (m.water > 0.02) {
      // clean water under the brush thins whatever it is carrying
      for (let i = 0; i < NPIG; i++) brush.pig[i] *= 1 - TAKE * 0.6;
    }
    // water is taken up separately, and only from a puddle that was already
    // there — otherwise the brush re-absorbs the water it just laid down
    if (strokeHadPuddle && m.water > 0.02) {
      brush.water = Math.min(1, Math.max(brush.water, Math.min(m.water * 4, 0.9)));
    }
    updateBrushView(`Mixing — ${consistency()}`);
  }

  // ------------------------------------------------ rotating plate --------
  // The tray canvas is 8 segments wide; the wrap clips to one. ◀ ▶ "turn"
  // the plate; each segment keeps its own mixes (and dries independently).
  const NSEG = 8;
  let SEGW = 190;
  let seg = 0;
  const segLabel = document.getElementById('seglabel');

  // The visible window is one segment wide, whatever the layout gives it
  // (narrower on a phone, wider on a landscape iPad), so measure it rather
  // than assuming.
  function layoutTray() {
    const w = document.getElementById('traywrap').clientWidth || 190;
    if (Math.abs(w - SEGW) < 1) return;
    SEGW = w;
    trayCanvas.style.width = `${SEGW * NSEG}px`;
    tray.resize();
    setSeg(seg, false);
  }

  function setSeg(n, log = true) {
    seg = ((n % NSEG) + NSEG) % NSEG;
    trayCanvas.style.transform = `translateX(${-seg * SEGW}px)`;
    segLabel.textContent = `${seg + 1}/${NSEG}`;
    if (log) LOGBOOK.log('traySeg', { seg });
  }
  layoutTray();
  document.getElementById('segprev').addEventListener('click', () => setSeg(seg - 1));
  document.getElementById('segnext').addEventListener('click', () => setSeg(seg + 1));

  // Rinsing the plate is the ✕ button only. Double-tap-to-rinse was too easy
  // to trigger by accident while dabbing, and wiped a mix mid-mix.
  function rinseTray(msg = 'Segment rinsed') {
    tray.clearRegion(seg * SEGW, (seg + 1) * SEGW);
    LOGBOOK.log('trayRinse', { seg, w: SEGW });
    updateBrushView(msg);
  }
  document.getElementById('rinse').addEventListener('click', () => rinseTray());

  trayCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    trayCanvas.setPointerCapture(e.pointerId);
    mixing = true;
    trayLast = null;
    // sample the tray before touching it: was there already a puddle here?
    const pre = tray.readMix(e.offsetX, e.offsetY);
    strokeHadPuddle = pre.water > 0.015;
    trayDab(e.offsetX, e.offsetY);
    trayPickup(e.offsetX, e.offsetY);
  });
  trayCanvas.addEventListener('pointermove', (e) => {
    if (!mixing) return;
    e.preventDefault();
    if (trayLast) {
      const dist = Math.hypot(e.offsetX - trayLast.x, e.offsetY - trayLast.y);
      const n = Math.max(1, Math.floor(dist / 5));
      for (let i = 1; i <= n; i++) {
        trayDab(trayLast.x + ((e.offsetX - trayLast.x) * i) / n,
                trayLast.y + ((e.offsetY - trayLast.y) * i) / n);
      }
    }
    trayLast = { x: e.offsetX, y: e.offsetY };
    trayPickup(e.offsetX, e.offsetY);
  });
  const trayEnd = () => { mixing = false; trayLast = null; updateBrushView(); };
  trayCanvas.addEventListener('pointerup', trayEnd);
  trayCanvas.addEventListener('pointercancel', trayEnd);

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
      const traySnap = tray.readDeposits();
      await STORE.put('state', {
        v: 1,
        savedAt: Date.now(),
        paper: { name: sim.paperName, seed: sim.paperSeed },
        channels: CHANNELS.map((c) => (c ? c.id : null)),
        pans: PANS.map((p) => ({ id: p.paint.id, chan: p.chan })),
        brush: { water: brush.water, pig: Array.from(brush.pig) },
        seg,
        drying: Number(dryingEl.value),
        settings: {
          pickup: Number(pickupEl.value), waterdip: Number(waterdipEl.value),
          saltsize: Number(saltsizeEl.value), runoff: runoffEl.checked,
          presssize: pressEl.checked, deplete: depleteEl.checked,
        },
        painting: snap,
        tray: traySnap,
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
      rebuildPans();
      if (st.paper && st.paper.name) {
        paperSel.value = st.paper.name;
        sim.setPaper(st.paper.name, st.paper.seed);
      }
      if (st.painting) sim.writeDeposits(st.painting);
      if (st.tray) tray.writeDeposits(st.tray);
      if (st.brush) {
        brush.water = st.brush.water;
        brush.pig.set(st.brush.pig.slice(0, NPIG));
      }
      if (st.seg != null) setSeg(st.seg);
      if (st.drying != null) { dryingEl.value = st.drying; applyDrying(false); }
      if (st.settings) {
        const s = st.settings;
        if (s.pickup != null) pickupEl.value = s.pickup;
        if (s.waterdip != null) waterdipEl.value = s.waterdip;
        if (s.saltsize != null) saltsizeEl.value = s.saltsize;
        if (s.runoff != null) runoffEl.checked = s.runoff;
        if (s.presssize != null) pressEl.checked = s.presssize;
        if (s.deplete != null) depleteEl.checked = s.deplete;
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
    if (!window.confirm('Reset everything? This clears the painting, tray, palette and saved state.')) return;
    await STORE.clear();
    LOGBOOK.reset();
    location.reload();
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }

  // --------------------------------------------------------------- loop ---
  window.addEventListener('resize', () => { sim.resize(); layoutTray(); tray.resize(); });
  window.addEventListener('orientationchange', () => setTimeout(() => {
    sim.resize(); layoutTray(); tray.resize();
  }, 250));

  function frame() {
    if (!window.__PAUSED) {
      LOGBOOK.tick();
      REPLAY.tick();
      DEMO.tick(sim);
      if (drying_) {
        const r = Number(sizeEl.value) * 2.2 + 14;
        sim.blowDry(drying_.x, drying_.y, r, drying_.dx, drying_.dy, 1.0);
        LOGBOOK.log('dryer', {
          x: Math.round(drying_.x), y: Math.round(drying_.y), r: Math.round(r),
          dx: Math.round(drying_.dx * 100) / 100, dy: Math.round(drying_.dy * 100) / 100,
        });
      }
      sim.step();
      sim.render();
      tray.step();
      tray.render();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  window.__uv = updateBrushView; // for the console and automated tests
  updateBrushView('Dip a pan for paint, 💧 for water — they are separate. 🌀 rinses, 🧽 blots water off.');
})();
