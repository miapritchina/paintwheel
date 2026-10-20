// Render test/scenes.html and write its stages as PNGs, to be looked at.
//
//   node tools/scenes.js [--port 8779] [--out dir] [--page scenes|variants] [--query v=a,b]
//
// Needs a static server on the repo root, as tools/tells.js does.
'use strict';
const { launch } = require('./browser');
const fs = require('fs');
const path = require('path');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const PORT = arg('--port', '8779');
const OUT = arg('--out', '.');
const PAGE = arg('--page', 'scenes');
const QUERY = arg('--query', '');

(async () => {
  const browser = await launch();
  const page = await browser.newPage({ viewport: { width: 1040, height: 720 }, deviceScaleFactor: 1 });
  page.setDefaultTimeout(1800000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.location().url || '')) errors.push(m.text() + ' ' + (m.location().url || '')); });
  await page.goto(`http://127.0.0.1:${PORT}/test/${PAGE}.html${QUERY ? '?' + QUERY : ''}`);
  await page.waitForFunction(() => window.__ready);
  const t0 = Date.now();
  const stages = await page.evaluate(() => window.__scenes());
  const trace = await page.evaluate(() => window.__trace || []);
  for (const t of trace) console.log('  ' + t);
  stages.forEach((s, i) => {
    const f = path.join(OUT, `${PAGE}-${i}-${s.label.replace(/[^a-z0-9]+/gi, '-')}.png`);
    fs.writeFileSync(f, Buffer.from(s.png.split(',')[1], 'base64'));
    console.log('wrote', f);
  });
  console.log(`${Math.round((Date.now() - t0) / 1000)}s`);
  if (errors.length) { console.log('PAGE ERRORS:'); errors.slice(0, 8).forEach((e) => console.log('  ' + e)); }
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
