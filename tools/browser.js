// generated-by: Claude | source: tools/scenes.js, tells.js, input.js launch code | purpose: one browser launcher that uses the real GPU when there is one
//
// Launch headless Chromium for the measurement tools.
//
// In the cloud container there is no GPU, so the browser renders WebGL on the
// CPU through SwiftShader; a scene run there takes tens of minutes. On a Mac
// the installed Chrome renders through ANGLE on Metal, which is the GPU the
// app actually runs on, and the same run takes seconds.
//
//   PW_SWIFTSHADER=1   force the software path anywhere (to compare)
//   PW_CHROME=path     use this browser binary
'use strict';
const fs = require('fs');
const { chromium } = require('playwright');

const CLOUD_CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const SOFTWARE = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];

async function launch() {
  const soft = process.env.PW_SWIFTSHADER === '1' || fs.existsSync(CLOUD_CHROME);
  const opts = soft
    ? { args: SOFTWARE }
    : { args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'], headless: true };
  if (process.env.PW_CHROME) opts.executablePath = process.env.PW_CHROME;
  else if (fs.existsSync(CLOUD_CHROME)) opts.executablePath = CLOUD_CHROME;
  else opts.channel = 'chrome';
  const browser = await chromium.launch(opts);
  console.log(`browser: ${soft ? 'SwiftShader (CPU)' : 'GPU'} ${browser.version()}`);
  return browser;
}

module.exports = { launch };
