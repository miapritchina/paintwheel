// Render test/tells.html and report the numbers.
//
//   node tools/tells.js [--png out.png] [--json out.json] [--base before.json]
//
// With --base it prints a before/after column so a change to the paint model
// shows up as movement in the tells rather than as an opinion about a
// screenshot. Needs a static server on the repo root:
//   python3 -m http.server 8779
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const PORT = arg('--port', '8779');
const PNG = arg('--png', null);
const JSON_OUT = arg('--json', null);
const BASE = arg('--base', null);

(async () => {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 700 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(600000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(`http://127.0.0.1:${PORT}/test/tells.html`);
  await page.waitForFunction(() => window.__ready);

  const t0 = Date.now();
  const res = await page.evaluate(() => window.__tells());
  res.seconds = Math.round((Date.now() - t0) / 1000);

  if (PNG) {
    const data = await page.evaluate(() => {
      sim.render();
      return sim.canvas.toDataURL('image/png');
    });
    fs.writeFileSync(PNG, Buffer.from(data.split(',')[1], 'base64'));
  }
  if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(res, null, 2));

  if (errors.length) {
    console.log('PAGE ERRORS:');
    for (const e of errors.slice(0, 8)) console.log('  ' + e);
    console.log('');
  }

  const base = BASE && fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : null;

  // The pass/fail line for each tell, and why it is the line it is.
  const CHECKS = [
    ['valueLadder', 'Value ladder', (p) => p.monotonic && p.topDepth < 6 && p.spread > 8,
      (p) => `depths ${p.depth.join(' ')}  (monotonic ${p.monotonic}, top ${p.topDepth}, spread ${p.spread}x)`,
      'six steps must be six values; the top of the range must stay under the knee of the KM curve (<6)'],
    ['waterLadder', 'Water ladder', (p) => p.valueDrift < 1.6 && p.spreadGain > 1.15,
      (p) => `depths ${p.depth.join(' ')}  drift ${p.valueDrift}x  covers ${p.spreadGain}x more paper`,
      'water must change how far paint goes (>1.15x), not how dark it is (<1.6x)'],
    ['glaze', 'Glazing', (p) => p.buildsGradually,
      (p) => `depth ${p.depth.join(' ')}  adding ${p.steps.join(' ')}`,
      'a first pass must stay light (<1.2) and four passes must still be building'],
    ['edges', 'Hard vs soft edge', (p) => p.distinct,
      (p) => `hard ${p.hard}  soft ${p.soft}  ratio ${p.ratio}x`,
      'a stroke on dry paper must have a visibly crisper edge than one into wet'],
    ['backrun', 'Backrun', (p) => p.happened,
      (p) => `roughness ${p.sdBefore} -> ${p.sdAfter}  (${p.roughening}x)`,
      'water into a setting wash must break it up'],
    ['granulation', 'Granulation', (p) => p.distinct,
      (p) => `granulating ${p.granulatingSd}  staining ${p.stainingSd}  ratio ${p.ratio}x`,
      'a heavy pigment must settle visibly more than a staining one'],
    ['dryBrush', 'Dry brush', (p) => p.broken,
      (p) => `touched ${p.covered}  actually painted ${p.painted}  skipped ${p.skips}`,
      'a dry brush on rough paper must skip, leaving paper showing'],
    ['oneLoad', 'One load', (p) => p.runsOut,
      (p) => `start ${p.startDepth}  end ${p.endDepth}  fade ${p.fade}x  left on brush ${p.leftOnBrush}`,
      'one dip must fade as it is spent rather than painting for ever'],
  ];

  console.log(`\nTHE TELLS — build ${res.build}, ${res.seconds}s, paper luminance ${res.paperL}\n`);
  let pass = 0;
  for (const [key, title, ok, fmt, why] of CHECKS) {
    const p = res.panels[key];
    if (!p) { console.log(`  ??  ${title}: did not run`); continue; }
    const good = ok(p);
    if (good) pass++;
    console.log(`  ${good ? 'ok  ' : 'FAIL'}  ${title}`);
    console.log(`        ${fmt(p)}`);
    if (!good) console.log(`        wanted: ${why}`);
    if (base && base.panels[key]) console.log(`        before: ${fmt(base.panels[key])}`);
  }
  console.log(`\n  ${pass}/${CHECKS.length} tells pass\n`);

  await browser.close();
  process.exit(pass === CHECKS.length ? 0 : 1);
})();
