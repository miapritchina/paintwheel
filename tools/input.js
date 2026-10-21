// The input contract, checked headlessly against the real app.
//
//   node tools/input.js [--port 8779]
//
// Drives index.html through synthetic pointer events — a pen, fingers, a
// pinch, a two-finger tap — and checks what the hand expects: a dab stays
// local, undo is deep and exact, the brush refills on lift, pressure drives
// flow, tilt stretches the footprint, fingers navigate once a Pencil has
// been seen, a dab lands under the pen at any zoom, the painting survives a
// rotation and a change of detail, a hold on a pan solos its colour, tilt
// runs the water to the lowest edge. Needs
// a static server on the repo root, as tools/tells.js does.
'use strict';
const { launch } = require('./browser');
const pi = process.argv.indexOf('--port');
const PORT = pi > 0 && process.argv[pi + 1] ? process.argv[pi + 1] : '8779';

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(600000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.location().url || '')) errors.push(m.text() + ' ' + (m.location().url || '')); });
  await page.goto(`http://127.0.0.1:${PORT}/index.html?t=${Date.now()}`);
  await page.waitForFunction(() => window.sim && window.brush && window.__input);
  await page.evaluate(async () => {
    window.__PAUSED = true; // we step the sim by hand
    // least detail: this is a software renderer
    document.getElementById('quality').value = 'battery';
    document.getElementById('quality').dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 300));
  });

  const results = [];
  const check = (name, ok, detail) => { results.push([name, ok, detail]); console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}  ${detail || ''}`); };

  // helpers run in the page
  await page.evaluate(() => {
    const cv = document.getElementById('canvas');
    window.T = {
      ev(type, o) {
        const e = new PointerEvent(type, Object.assign({
          bubbles: true, cancelable: true, pointerId: 1, pointerType: 'pen', isPrimary: true,
          clientX: 0, clientY: 0, pressure: 0.5, button: 0, buttons: 1,
        }, o));
        if (o.altitudeAngle != null) {
          Object.defineProperty(e, 'altitudeAngle', { value: o.altitudeAngle });
          Object.defineProperty(e, 'azimuthAngle', { value: o.azimuthAngle || 0 });
        }
        cv.dispatchEvent(e);
      },
      stroke(x0, y0, x1, y1, o = {}) {
        const n = o.n || 12;
        this.ev('pointerdown', Object.assign({ clientX: x0, clientY: y0 }, o));
        for (let i = 1; i <= n; i++) {
          this.ev('pointermove', Object.assign({ clientX: x0 + (x1 - x0) * i / n, clientY: y0 + (y1 - y0) * i / n }, o));
        }
        this.ev('pointerup', Object.assign({ clientX: x1, clientY: y1, pressure: 0, buttons: 0 }, o));
      },
      depSum() {
        const snap = sim.readDeposits();
        let s = 0; for (const q of snap.layers) for (let i = 0; i < q.length; i++) s += q[i];
        return s;
      },
      depBox() {
        const snap = sim.readDeposits();
        let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
        for (const q of snap.layers) for (let i = 0; i < q.length; i += 4) {
          if (q[i] + q[i + 1] + q[i + 2] + q[i + 3] > 0) {
            const px = (i / 4) % snap.w, py = Math.floor(i / 4 / snap.w);
            if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
          }
        }
        return { x0, y0, x1, y1, w: snap.w, h: snap.h };
      },
      load() { // one colour on the brush
        PARTS.fill(0); PARTS[0] = 1; brush.setRecipe(PARTS, brush.PIG_CAP * 0.8); brush.water = 0.5; window.__uv();
      },
      steps(n) { for (let i = 0; i < n; i++) sim.step(); },
      // the paint takes its time to settle now; a check that reads the
      // deposits has to let the sheet dry first
      settle() { const was = sim.params.drySpeed; sim.params.drySpeed = 120; for (let i = 0; i < 160; i++) sim.step(); sim.params.drySpeed = was; },
    };
  });

  // --- 1. a dab stays local (scissor + copy-back keep both textures right)
  let r = await page.evaluate(() => {
    T.load();
    T.ev('pointerdown', { clientX: 300, clientY: 300, pressure: 0.6 });
    T.ev('pointerup', { clientX: 300, clientY: 300, pressure: 0, buttons: 0 });
    T.settle();
    const b = T.depBox();
    const sx = b.w / sim.sheetW;
    return { ...b, cx: 300 * sx, cy: (sim.sheetH - 300) * sx, size: Number(document.getElementById('size').value) * sx };
  });
  check('single dab is local', r.x1 > 0 && (r.x1 - r.x0) < r.size * 5 && Math.abs((r.x0 + r.x1) / 2 - r.cx) < r.size * 2,
    `deposit box ${r.x0}-${r.x1} x ${r.y0}-${r.y1}, expected near ${Math.round(r.cx)},${Math.round(r.cy)} r~${r.size.toFixed(1)}`);

  // --- 2. undo takes the dab back, count behaves
  r = await page.evaluate(() => {
    const before = T.depSum(), n = sim.undoCount;
    document.getElementById('undo').click();
    return { before, after: T.depSum(), n, n2: sim.undoCount };
  });
  check('undo removes the dab', r.before > 0 && r.after === 0 && r.n === 1 && r.n2 === 0, JSON.stringify(r));

  // --- 3. deep undo: 10 strokes, 10 undos, sheet clean again
  r = await page.evaluate(() => {
    T.load();
    const sums = [];
    for (let i = 0; i < 10; i++) {
      T.load();
      T.stroke(100 + i * 60, 150, 140 + i * 60, 450, { pressure: 0.6 });
      T.settle();
      sums.push(T.depSum());
    }
    const count = sim.undoCount, bytes = sim.undoBytes;
    const back = [];
    for (let i = 0; i < 10; i++) { document.getElementById('undo').click(); back.push(T.depSum()); }
    return { sums, count, bytes, back, left: sim.undoCount };
  });
  check('ten strokes undo one by one', r.count === 10 && r.back[9] === 0 && r.back[0] < r.sums[9] && r.back[4] < r.back[3] && r.left === 0,
    `count ${r.count}, ${(r.bytes / 1e6).toFixed(1)} MB, sums ${r.sums.map((v) => Math.round(v / 1000)).join(' ')} -> back ${r.back.map((v) => Math.round(v / 1000)).join(' ')}`);

  // --- 4. the brush refills on lift
  r = await page.evaluate(() => {
    T.load();
    const before = brush.total(), water = brush.water;
    T.stroke(100, 600, 900, 600, { pressure: 0.7, n: 40 });
    return { before, after: brush.total(), water, waterAfter: brush.water, logged: LOGBOOK.export().events.some((e) => e.t === 'refill') };
  });
  check('brush refills on lift', Math.abs(r.after - r.before) < 1e-3 && Math.abs(r.waterAfter - r.water) < 1e-6 && r.logged, `${r.before.toFixed(0)} -> ${r.after.toFixed(0)}`);

  // --- 5. within a stroke it does deplete (a long line fades)
  r = await page.evaluate(() => {
    T.load();
    const saved = brush.remember();
    const out = new Float32Array(N_CHANNELS);
    let spent = 0;
    for (let i = 0; i < 60; i++) { brush.dab(20, 16, 0.6, out); }
    spent = saved.pig[0] - brush.pig[0];
    brush.restore(saved);
    return { spent, start: saved.pig[0] };
  });
  check('a long stroke spends the load', r.spent > r.start * 0.5, `spent ${(100 * r.spent / r.start).toFixed(0)}% over 1200px`);

  // --- 6. pressure drives flow
  r = await page.evaluate(() => {
    T.load();
    const out = new Float32Array(N_CHANNELS);
    const s = brush.remember();
    const soft = brush.dab(10, 16, 0.2, out, { flow: 1 }).amp[0];
    brush.restore(s);
    const hard = brush.dab(10, 16, 0.9, out, { flow: 1 }).amp[0];
    brush.restore(s);
    const off1 = brush.dab(10, 16, 0.2, out, { flow: 0 }).amp[0];
    brush.restore(s);
    const off2 = brush.dab(10, 16, 0.9, out, { flow: 0 }).amp[0];
    brush.restore(s);
    return { soft, hard, off1, off2 };
  });
  check('pressure drives flow (and can be switched off)', r.hard > r.soft * 1.8 && Math.abs(r.off1 - r.off2) < 1e-9, `soft ${r.soft.toExponential(2)} hard ${r.hard.toExponential(2)}`);

  // --- 7. tilt stretches the footprint
  r = await page.evaluate(() => {
    sim.clearAll(); sim.clearUndo();
    T.load();
    T.ev('pointerdown', { clientX: 500, clientY: 300, pressure: 0.6, altitudeAngle: Math.PI / 2, azimuthAngle: 0 });
    T.ev('pointerup', { clientX: 500, clientY: 300, pressure: 0, buttons: 0 });
    T.settle();
    const round = T.depBox();
    sim.clearAll();
    T.load();
    T.ev('pointerdown', { clientX: 500, clientY: 300, pressure: 0.6, altitudeAngle: 0.25, azimuthAngle: 0 });
    T.ev('pointerup', { clientX: 500, clientY: 300, pressure: 0, buttons: 0 });
    T.settle();
    const flat = T.depBox();
    const ev = LOGBOOK.export().events.filter((e) => e.t === 'splat' && e.sh);
    return { rw: round.x1 - round.x0, rh: round.y1 - round.y0, fw: flat.x1 - flat.x0, fh: flat.y1 - flat.y0, logged: ev.length };
  });
  check('tilted pen stretches the dab along its azimuth', r.fw > r.rw * 1.5 && Math.abs(r.fh - r.rh) <= 3 && r.logged > 0,
    `upright ${r.rw}x${r.rh}, leaning ${r.fw}x${r.fh}, ${r.logged} shaped splats logged`);

  // --- 8. two fingers pinch to zoom, and the stroke that began is taken back
  r = await page.evaluate(() => {
    sim.clearAll(); sim.clearUndo(); sim.fitView();
    T.load();
    const z0 = sim.view.zoom;
    // Pencil has been seen, so a lone finger should navigate, not paint
    const dep0 = T.depSum();
    T.ev('pointerdown', { pointerId: 11, pointerType: 'touch', clientX: 400, clientY: 400 });
    T.ev('pointermove', { pointerId: 11, pointerType: 'touch', clientX: 450, clientY: 420 });
    const panned = { cx: sim.view.cx, cy: sim.view.cy };
    T.ev('pointerdown', { pointerId: 12, pointerType: 'touch', clientX: 600, clientY: 400 });
    T.ev('pointermove', { pointerId: 11, pointerType: 'touch', clientX: 350, clientY: 420 });
    T.ev('pointermove', { pointerId: 12, pointerType: 'touch', clientX: 700, clientY: 400 });
    const z1 = sim.view.zoom;
    T.ev('pointerup', { pointerId: 11, pointerType: 'touch', clientX: 350, clientY: 420, buttons: 0 });
    T.ev('pointerup', { pointerId: 12, pointerType: 'touch', clientX: 700, clientY: 400, buttons: 0 });
    return { z0, z1, panned, dep: T.depSum() - dep0, penSeen: window.__input.penSeen, gesture: !!window.__input.gesture };
  });
  check('after a Pencil, one finger pans and two pinch-zoom without painting',
    r.penSeen && r.dep === 0 && r.z1 > r.z0 * 1.3 && Math.abs(r.panned.cx - 512) > 20 && !r.gesture,
    `zoom ${r.z0.toFixed(2)} -> ${r.z1.toFixed(2)}, centre moved to ${r.panned.cx.toFixed(0)}, deposits added ${r.dep}`);

  // --- 9. a pen stroke lands where the pen is, at zoom
  r = await page.evaluate(() => {
    sim.clearAll(); sim.clearUndo();
    sim.setView(2.0, 300, 250); // zoomed 2x on the top-left region
    T.load();
    T.ev('pointerdown', { clientX: 512, clientY: 384, pressure: 0.6 }); // screen centre -> sheet (300, 250)
    T.ev('pointerup', { clientX: 512, clientY: 384, pressure: 0, buttons: 0 });
    T.settle();
    const b = T.depBox();
    const sx = b.w / sim.sheetW;
    const cx = (b.x0 + b.x1) / 2 / sx, cy = sim.sheetH - (b.y0 + b.y1) / 2 / sx;
    sim.fitView();
    return { cx, cy, radius: (b.x1 - b.x0) / 2 / sx };
  });
  check('a dab at 2x zoom lands at the sheet point under the pen', Math.abs(r.cx - 300) < 12 && Math.abs(r.cy - 250) < 12, `landed at ${r.cx.toFixed(0)},${r.cy.toFixed(0)} (want 300,250), on-sheet radius ${r.radius.toFixed(1)}`);

  // --- 10. two-finger tap undoes
  r = await page.evaluate(() => {
    const n0 = sim.undoCount, d0 = T.depSum();
    T.ev('pointerdown', { pointerId: 21, pointerType: 'touch', clientX: 400, clientY: 400 });
    T.ev('pointerdown', { pointerId: 22, pointerType: 'touch', clientX: 500, clientY: 400 });
    T.ev('pointerup', { pointerId: 21, pointerType: 'touch', clientX: 400, clientY: 400, buttons: 0 });
    T.ev('pointerup', { pointerId: 22, pointerType: 'touch', clientX: 500, clientY: 400, buttons: 0 });
    return { n0, n1: sim.undoCount, d0, d1: T.depSum() };
  });
  check('two-finger tap undoes', r.n0 === 1 && r.n1 === 0 && r.d0 > 0 && r.d1 === 0, JSON.stringify(r));

  // --- 11. the painting survives a resize / rotation
  r = await page.evaluate(() => {
    sim.clearAll(); sim.clearUndo(); sim.fitView();
    T.load();
    T.stroke(200, 200, 800, 500, { pressure: 0.7 });
    T.settle();
    return { before: T.depSum(), sheet: [sim.sheetW, sim.sheetH], sim: [sim.simW, sim.simH] };
  });
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.waitForTimeout(400);
  const r2 = await page.evaluate(() => ({ after: T.depSum(), sheet: [sim.sheetW, sim.sheetH], sim: [sim.simW, sim.simH], css: [sim.cssW, sim.cssH], zoom: sim.view.zoom }));
  check('rotating the device keeps the painting', r2.after === r.before && r2.sheet[0] === r.sheet[0] && r2.css[0] === 768,
    `deposits ${r.before} -> ${r2.after}; sheet ${r.sheet} stays, canvas now ${r2.css}, zoom ${r2.zoom.toFixed(2)}`);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(300);

  // --- 12. quality change resamples rather than wipes
  r = await page.evaluate(async () => {
    const before = T.depSum();
    const q = document.getElementById('quality');
    q.value = 'balanced'; q.dispatchEvent(new Event('input'));
    await new Promise((res) => setTimeout(res, 200));
    const after = T.depSum();
    q.value = 'battery'; q.dispatchEvent(new Event('input'));
    await new Promise((res) => setTimeout(res, 200));
    return { before, after, sim: [sim.simW, sim.simH] };
  });
  check('changing detail keeps the painting', r.after > r.before * 1.2, `deposits ${r.before} -> ${r.after} at ${r.sim} (more cells, same picture)`);

  // --- 13. double tap on a pan solos the colour
  r = await page.evaluate(async () => {
    PARTS.fill(0);
    const pans = document.querySelectorAll('#palette .panwrap');
    const tap = (el) => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 5, clientX: 10, clientY: 10 }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 5, clientX: 10, clientY: 10 }));
    };
    tap(pans[0]); tap(pans[0]); tap(pans[0]); // three yellow, quickly
    tap(pans[1]);
    const mixed = Array.from(PARTS.slice(0, 2));
    // hold on blue: blue alone
    pans[1].dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 5, clientX: 10, clientY: 10 }));
    await new Promise((res) => setTimeout(res, 750));
    pans[1].dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerId: 5, clientX: 10, clientY: 10 }));
    const solo = Array.from(PARTS.slice(0, 2));
    return { mixed, solo, pig0: brush.pig[0], pig1: brush.pig[1] };
  });
  check('quick taps mix, a hold solos', r.mixed[0] === 3 && r.mixed[1] === 1 && r.solo[0] === 0 && r.solo[1] === 1 && r.pig0 === 0 && r.pig1 > 0, JSON.stringify(r));

  // --- 14. a finger paints when no Pencil has been seen (fresh page)
  await page.goto(`http://127.0.0.1:${PORT}/index.html?t=${Date.now()}`);
  await page.waitForFunction(() => window.sim && window.brush && window.__input);
  r = await page.evaluate(async () => {
    window.__PAUSED = true;
    await new Promise((res) => setTimeout(res, 200));
    document.getElementById('reset'); // not clicked: just make sure the page is alive
    PARTS.fill(0); PARTS[0] = 1; brush.setRecipe(PARTS, brush.PIG_CAP * 0.8); brush.water = 0.5;
    const cv = document.getElementById('canvas');
    const ev = (type, o) => cv.dispatchEvent(new PointerEvent(type, Object.assign({ bubbles: true, cancelable: true, pointerId: 31, pointerType: 'touch', isPrimary: true, pressure: 0.5, buttons: 1 }, o)));
    ev('pointerdown', { clientX: 300, clientY: 300 });
    ev('pointermove', { clientX: 400, clientY: 320 });
    ev('pointerup', { clientX: 400, clientY: 320, buttons: 0 });
    const was = sim.params.drySpeed; sim.params.drySpeed = 120; for (let i = 0; i < 160; i++) sim.step(); sim.params.drySpeed = was;
    const snap = sim.readDeposits();
    let s = 0; for (const q of snap.layers) for (let i = 0; i < q.length; i++) s += q[i];
    return { dep: s, penSeen: window.__input.penSeen };
  });
  check('a finger paints until a Pencil shows up', r.dep > 0 && !r.penSeen, `deposits ${r.dep}`);

  // Tilt runs to the physically lowest edge. A phone held still in the hand
  // at 60 degrees must run the water down the screen; a few degrees of
  // wobble must not swing it sideways; an iPad turned either way in
  // landscape must do the same; flat on a table, nothing runs.
  await page.goto(`http://127.0.0.1:${PORT}/index.html?t=${Date.now()}`);
  await page.waitForFunction(() => window.sim && window.brush);
  r = await page.evaluate(async () => {
    const dir = (beta, gamma, angle) => {
      Object.defineProperty(screen.orientation, 'angle', { value: angle, configurable: true });
      for (let i = 0; i < 80; i++) window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: 0, beta, gamma }));
      const t = sim.params.tilt;
      return { deg: Math.round(Math.atan2(t[0], -t[1]) * 180 / Math.PI), mag: Math.hypot(t[0], t[1]) };
    };
    document.getElementById('tilt').click();
    await new Promise((res) => setTimeout(res, 50));
    const out = { held: dir(60, 0, 0), wobble: dir(57, 10, 0), leanBack: dir(45, 0, 0),
                  land90: dir(0, -60, 90), land270: dir(0, 60, 270), flat: dir(2, 2, 0) };
    document.getElementById('tilt').click();
    return out;
  });
  check('tilt runs the water to the lowest edge of the screen',
    Math.abs(r.held.deg) <= 2 && r.held.mag > 0.1 && Math.abs(r.wobble.deg) <= 12 && Math.abs(r.leanBack.deg) <= 2
      && Math.abs(r.land90.deg) <= 2 && Math.abs(r.land270.deg) <= 2 && r.flat.mag === 0,
    `deg from down: held ${r.held.deg}, wobble ${r.wobble.deg}, leaning back ${r.leanBack.deg}, landscape ${r.land90.deg}/${r.land270.deg}; flat ${r.flat.mag}`);

  if (errors.length) { console.log('\nPAGE ERRORS:'); for (const e of errors.slice(0, 10)) console.log('  ' + e); }
  const pass = results.filter((x) => x[1]).length;
  console.log(`\n${pass}/${results.length} checks pass${errors.length ? `, ${errors.length} page errors` : ''}`);
  await browser.close();
  process.exit(pass === results.length && !errors.length ? 0 : 1);
})();
