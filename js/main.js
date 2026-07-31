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
      params: {
        evap: 0.000004,  // puddles in the tray last for ages
        edgeEvap: 4.0,
        maran: 0.5,
        lift: 0.05,      // ceramic re-wets easily
        settle: 0.15,
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
  // water: 0 (bone dry) .. 1 (dripping). pig: per-pigment load on the hairs.
  const brush = {
    water: 0.6,
    pig: new Float32Array(NPIG),
  };
  window.brush = brush;

  const brushview = document.getElementById('brushview');
  const brushcursor = document.getElementById('brushcursor');
  const pignameEl = document.getElementById('pigname');

  function brushTotal() {
    let t = 0;
    for (let i = 0; i < NPIG; i++) t += brush.pig[i];
    return t;
  }

  const waterbar = document.querySelector('#waterbar > div');
  const paintbar = document.querySelector('#paintbar > div');

  function updateBrushView(msg) {
    const total = brushTotal();
    // thickness scales with load so a heavy brush looks like creamy masstone
    // and a nearly-spent one shows a pale tint
    const color = total > 0.01 ? CHANNELS.kmColor(brush.pig, 1.5 + 12 * Math.min(total, 1.2)) : 'rgb(238,236,230)';
    brushview.style.background = color;
    brushview.style.borderColor = `rgba(160,200,255,${0.25 + 0.6 * brush.water})`;
    // wet brush looks glossy, dry brush matte
    brushview.style.boxShadow = `inset 0 -5px 8px rgba(0,0,0,0.25), inset 0 ${2 + 4 * brush.water}px ${3 + 6 * brush.water}px rgba(255,255,255,${0.15 + 0.35 * brush.water})`;
    waterbar.style.width = `${Math.round(brush.water * 100)}%`;
    paintbar.style.width = `${Math.round(Math.min(total / 1.2, 1) * 100)}%`;
    paintbar.style.background = color;
    brushcursor.style.background = total > 0.01 ? color.replace('rgb', 'rgba').replace(')', ',0.35)') : 'rgba(200,220,255,0.2)';
    if (msg !== undefined) pignameEl.textContent = msg;
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
      b.title = `${p.name} (${p.ci})`;
      b.addEventListener('pointerdown', () => {
        // a wetter brush picks up more paint; tap repeatedly for a creamy load
        const chan = PANS[i].chan;
        const pickup = 0.2 + 0.8 * brush.water;
        brush.pig[chan] = Math.min(1.2, brush.pig[chan] + 0.8 * pickup);
        brush.water = Math.max(brush.water - 0.04, 0);
        LOGBOOK.log('dipPan', { pig: chan, name: PANS[i].paint.name, water: Math.round(brush.water * 100) / 100 });
        updateBrushView(`${PANS[i].paint.name} (${PANS[i].paint.ci})`);
      });
      const label = document.createElement('div');
      label.className = 'panlabel';
      label.textContent = p.short;
      wrap.appendChild(b);
      wrap.appendChild(label);
      paletteEl.appendChild(wrap);
    });
  }
  rebuildPans();
  window.__refreshPalette = rebuildPans;

  // ------------------------------------------- water / clean / sponge -----
  document.getElementById('glass').addEventListener('pointerdown', () => {
    // tip dip: just the point of the brush touches the water — adds water,
    // keeps nearly all the paint. Use 🌀 to actually rinse.
    brush.water = Math.min(1, brush.water + 0.28);
    for (let i = 0; i < NPIG; i++) brush.pig[i] *= 0.97;
    LOGBOOK.log('glass');
    updateBrushView('Tip dipped in water');
  });
  document.getElementById('clean').addEventListener('pointerdown', () => {
    // swirl the brush in the jar: paint washes out, brush stays wet
    brush.pig.fill(0);
    brush.water = 0.8;
    LOGBOOK.log('clean');
    updateBrushView('Brush rinsed clean');
  });
  document.getElementById('sponge').addEventListener('pointerdown', () => {
    // blot on the sponge: sheds water, keeps most of the pigment ("thirsty
    // brush" for controlled dry-brush and lifting)
    brush.water *= 0.25;
    for (let i = 0; i < NPIG; i++) brush.pig[i] *= 0.9;
    LOGBOOK.log('sponge');
    updateBrushView('Blotted on the sponge');
  });

  // ----------------------------------------------------------- controls ---
  const sizeEl = document.getElementById('size');
  document.getElementById('clear').addEventListener('click', () => { LOGBOOK.log('clear'); sim.clearAll(); });
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

  // Salt mode: taps sprinkle salt instead of painting. Timing matters like
  // real salt — it only textures a wash that is damp, not soaked or dry.
  const saltBtn = document.getElementById('salt');
  let saltMode = false;
  saltBtn.addEventListener('click', () => {
    saltMode = !saltMode;
    saltBtn.style.background = saltMode ? 'rgba(255,255,255,0.4)' : '';
    updateBrushView(saltMode ? 'Salt: tap the painting to sprinkle' : undefined);
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

  function dab(x, y, pressure) {
    DEMO.stop();
    const size = Number(sizeEl.value) * (0.35 + 0.65 * pressure);
    const total = brushTotal();
    const water = (0.002 + 0.042 * brush.water) * (0.5 + 0.5 * pressure);
    const amount = 0.4 * (0.4 + 0.6 * pressure);
    for (let i = 0; i < NPIG; i++) pigDep[i] = brush.pig[i] * amount;
    // clean damp brush lifts pigment instead of depositing
    const scrub = total < 0.02 ? 0.08 * pressure * brush.water : 0;
    sim.splat(x, y, size, water, pigDep, brush.water, scrub);
  }

  function deplete(dist) {
    // pigment sheds faster than water; both persist across strokes until
    // you dip again
    const waterRange = 2600;
    const pigRange = 1100;
    brush.water *= Math.exp(-dist / waterRange);
    for (let i = 0; i < NPIG; i++) brush.pig[i] *= Math.exp(-dist / pigRange);
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

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    if (saltMode) {
      const r = Number(sizeEl.value) * 1.6;
      sim.sprinkleSalt(e.offsetX, e.offsetY, r);
      LOGBOOK.log('salt', { x: Math.round(e.offsetX), y: Math.round(e.offsetY), r: Math.round(r) });
      return;
    }
    painting = true;
    last = null;
    strokeTo(e.offsetX, e.offsetY, e.pressure || 0.5);
  });
  canvas.addEventListener('pointermove', (e) => {
    const size = Number(sizeEl.value);
    brushcursor.style.display = 'block';
    brushcursor.style.left = e.clientX + 'px';
    brushcursor.style.top = e.clientY + 'px';
    brushcursor.style.width = size * 2 + 'px';
    brushcursor.style.height = size * 2 + 'px';
    if (!painting) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) strokeTo(ev.offsetX, ev.offsetY, ev.pressure || 0.5);
    updateBrushView();
  });
  canvas.addEventListener('pointerleave', () => { brushcursor.style.display = 'none'; });
  const end = () => { painting = false; last = null; updateBrushView(); };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  // ------------------------------------------------------ mixing: tray ----
  const trayPig = new Float32Array(NPIG);
  let mixing = false;
  let trayLast = null;
  let lastPickup = 0;

  function trayDab(x, y) {
    const total = brushTotal();
    const water = 0.004 + 0.05 * brush.water;
    for (let i = 0; i < NPIG; i++) trayPig[i] = brush.pig[i] * 0.3;
    tray.splat(x, y, 11, water, trayPig, Math.max(brush.water, 0.3));
    // slight shedding into the tray
    for (let i = 0; i < NPIG; i++) brush.pig[i] *= 0.985;
  }

  // Water pickup is only allowed when the puddle existed BEFORE this stroke:
  // otherwise the brush would re-absorb the water it just deposited and get
  // wetter by merely touching a dry tray.
  let strokeHadPuddle = false;

  function trayPickup(x, y) {
    const now = performance.now();
    if (now - lastPickup < 60) return;
    lastPickup = now;
    const m = tray.readMix(x, y);
    let t = 0;
    for (let i = 0; i < NPIG; i++) t += m.pig[i];
    if (t > 0.005) {
      // the brush becomes the local puddle mixture
      for (let i = 0; i < NPIG; i++) {
        brush.pig[i] = brush.pig[i] * 0.75 + Math.min(m.pig[i] * 1.2, 1) * 0.35;
      }
    }
    if (strokeHadPuddle && m.water > 0.02) {
      brush.water = Math.min(1, Math.max(brush.water, Math.min(m.water * 4, 0.9)));
    }
    updateBrushView('Mixing…');
  }

  // ------------------------------------------------ rotating plate --------
  // The tray canvas is 8 segments wide; the wrap clips to one. ◀ ▶ "turn"
  // the plate; each segment keeps its own mixes (and dries independently).
  const SEGW = 190, NSEG = 8;
  let seg = 0;
  const segLabel = document.getElementById('seglabel');
  function setSeg(n) {
    seg = ((n % NSEG) + NSEG) % NSEG;
    trayCanvas.style.transform = `translateX(${-seg * SEGW}px)`;
    segLabel.textContent = `${seg + 1}/${NSEG}`;
    LOGBOOK.log('traySeg', { seg });
  }
  document.getElementById('segprev').addEventListener('click', () => setSeg(seg - 1));
  document.getElementById('segnext').addEventListener('click', () => setSeg(seg + 1));

  // double-tap detection by hand: dblclick doesn't fire reliably for
  // touch + pointer-capture, so track tap timing/position ourselves
  let lastTap = { t: 0, x: 0, y: 0 };
  function rinseTray(msg = 'Segment rinsed') {
    tray.clearRegion(seg * SEGW, (seg + 1) * SEGW);
    LOGBOOK.log('trayRinse', { seg });
    updateBrushView(msg);
  }
  document.getElementById('rinse').addEventListener('click', () => rinseTray());

  trayCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const now = performance.now();
    if (now - lastTap.t < 350 && Math.hypot(e.offsetX - lastTap.x, e.offsetY - lastTap.y) < 25) {
      lastTap.t = 0;
      mixing = false;
      rinseTray();
      return;
    }
    lastTap = { t: now, x: e.offsetX, y: e.offsetY };
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

  // --------------------------------------------------------------- loop ---
  window.addEventListener('resize', () => { sim.resize(); tray.resize(); });

  function frame() {
    if (!window.__PAUSED) {
      LOGBOOK.tick();
      REPLAY.tick();
      DEMO.tick(sim);
      sim.step();
      sim.render();
      tray.step();
      tray.render();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
  updateBrushView('Dip a pan to load the brush; mix in the tray; 💧 dilutes, 🧽 cleans. Double-tap the tray to rinse it.');
})();
