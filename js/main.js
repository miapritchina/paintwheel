// UI wiring, pointer/stylus input, main loop.

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

  // ----------------------------------------------------------- palette ---
  const paletteEl = document.getElementById('palette');
  const pignameEl = document.getElementById('pigname');
  let currentPig = 0; // index into PIGMENTS, or -1 for plain water

  PIGMENTS.forEach((p, i) => {
    const b = document.createElement('button');
    b.className = 'swatch' + (i === currentPig ? ' active' : '');
    b.style.background = p.swatch;
    b.title = p.name;
    b.addEventListener('click', () => {
      currentPig = i;
      updatePalette();
    });
    b.dataset.idx = i;
    paletteEl.appendChild(b);
  });
  const waterBtn = document.createElement('button');
  waterBtn.className = 'swatch water';
  waterBtn.title = 'Plain water (wet the paper / lift paint)';
  waterBtn.addEventListener('click', () => {
    currentPig = -1;
    updatePalette();
  });
  waterBtn.dataset.idx = -1;
  paletteEl.appendChild(waterBtn);

  function updatePalette() {
    for (const el of paletteEl.children) {
      el.classList.toggle('active', Number(el.dataset.idx) === currentPig);
    }
    pignameEl.textContent = currentPig < 0 ? 'Plain water' : PIGMENTS[currentPig].name;
  }
  updatePalette();

  // ---------------------------------------------------------- controls ---
  const sizeEl = document.getElementById('size');
  const waterEl = document.getElementById('water');
  const loadEl = document.getElementById('load');
  document.getElementById('clear').addEventListener('click', () => sim.clearAll());
  const dryBtn = document.getElementById('dry');
  dryBtn.addEventListener('pointerdown', () => { sim.params.drySpeed = 30; });
  const dryOff = () => { sim.params.drySpeed = 1; };
  dryBtn.addEventListener('pointerup', dryOff);
  dryBtn.addEventListener('pointerleave', dryOff);
  document.getElementById('demo').addEventListener('click', () => DEMO.start(sim));
  // Tilt: thick wet paint runs downhill like on a tilted board.
  // iOS requires a user-gesture permission request for orientation events.
  const tiltBtn = document.getElementById('tilt');
  let tiltOn = false;
  function onOrient(e) {
    if (!tiltOn || e.beta == null) return;
    // gamma: left/right tilt; beta: front/back. Map to canvas UV so paint
    // runs toward the physically lower edge of the screen (portrait).
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

  document.getElementById('save').addEventListener('click', () => {
    // render right before reading: the drawing buffer isn't preserved
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

  // ------------------------------------------------------------- brush ---
  // The brush carries finite water and pigment reservoirs that deplete over
  // the stroke: strokes fade and end in dry-brush texture, like a real round.
  const pig = new Float32Array(8);
  let painting = false;
  let last = null;
  let reservoir = 1;

  function dab(x, y, pressure) {
    DEMO.stop();
    const size = Number(sizeEl.value) * (0.35 + 0.65 * pressure);
    const wet = Number(waterEl.value) / 100;
    const loadv = Number(loadEl.value) / 100;
    pig.fill(0);
    let water;
    let scrub = 0;
    // wetter brushes hold more; a soaked brush outlasts several screen-widths
    const res = 0.15 + 0.85 * reservoir;
    if (currentPig < 0) {
      water = (0.01 + 0.09 * wet) * res; // plain water: wet the sheet, lift paint
      scrub = 0.08 * pressure; // clean brush picks up pigment as it passes
    } else {
      water = (0.002 + 0.05 * wet) * res;
      pig[currentPig] = 0.10 * loadv * (0.4 + 0.6 * pressure) * res;
    }
    sim.splat(x, y, size, water * (0.5 + 0.5 * pressure), pig, wet * res, scrub);
  }

  function strokeTo(x, y, pressure) {
    if (!last) { dab(x, y, pressure); last = { x, y }; return; }
    const dx = x - last.x, dy = y - last.y;
    const dist = Math.hypot(dx, dy);
    // deplete the reservoirs with distance; wet brushes carry further
    const wetv = Number(waterEl.value) / 100;
    const range = 900 + 2600 * wetv; // px of stroke until mostly spent
    reservoir *= Math.exp(-dist / range);
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
    painting = true;
    last = null;
    reservoir = 1; // dip the brush
    strokeTo(e.offsetX, e.offsetY, e.pressure || 0.5);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!painting) return;
    e.preventDefault();
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) strokeTo(ev.offsetX, ev.offsetY, ev.pressure || 0.5);
  });
  const end = () => { painting = false; last = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  // --------------------------------------------------------------- loop ---
  window.addEventListener('resize', () => sim.resize());

  function frame() {
    if (!window.__PAUSED) {
      DEMO.tick(sim);
      sim.step();
      sim.render();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
})();
