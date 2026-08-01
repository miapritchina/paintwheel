// WebGL2 engine for the watercolor simulation: texture ping-pong, MRT passes,
// and the per-frame pipeline described in shaders.js. Pigment concentrations
// live in PIG_TEXTURES RGBA pairs (16 pigments), suspended + deposited.

'use strict';

// Paper presets: procedural texture + absorbency + base color + flow feel.
const PAPERS = {
  coldpress: { label: 'Cold press', grain: 0.55, tooth: 0.35, fiber: 0.10, capBase: 0.55, capVar: 0.45, color: [0.94, 0.92, 0.87], paperSlope: 0.5 },
  hotpress:  { label: 'Hot press',  grain: 0.22, tooth: 0.08, fiber: 0.05, capBase: 0.50, capVar: 0.22, color: [0.95, 0.94, 0.90], paperSlope: 0.2 },
  rough:     { label: 'Rough',      grain: 0.72, tooth: 0.55, fiber: 0.12, capBase: 0.60, capVar: 0.50, color: [0.93, 0.91, 0.85], paperSlope: 0.7 },
  toned:     { label: 'Toned cream',grain: 0.50, tooth: 0.30, fiber: 0.10, capBase: 0.55, capVar: 0.40, color: [0.90, 0.85, 0.72], paperSlope: 0.5 },
  // the mixing plate: no tooth, no absorbency, but a steep relief so the
  // well rims actually contain the liquid
  ceramic:   { label: 'Ceramic',    grain: 0.03, tooth: 0.0,  fiber: 0.02, capBase: 0.0,  capVar: 0.0,  color: [0.97, 0.97, 0.96], paperSlope: 25.0 },
};

class WatercolorSim {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.paperName = opts.paper || 'coldpress';
    this.paper = PAPERS[this.paperName];
    this.maxSim = opts.maxSim || 1024;
    this.wells = opts.wells || 0; // dished wells across the width (palette)
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('WebGL2 is not supported on this device/browser.');
    this.gl = gl;

    const extF = gl.getExtension('EXT_color_buffer_float');
    const extHF = gl.getExtension('EXT_color_buffer_half_float');
    if (!extF && !extHF) throw new Error('Floating-point render targets are not supported.');
    const maxAttach = gl.getParameter(gl.MAX_COLOR_ATTACHMENTS);
    if (maxAttach < PIG_TEXTURES + 1) {
      throw new Error(`This device supports only ${maxAttach} MRT attachments; ${PIG_TEXTURES + 1} needed.`);
    }

    // Tunable physical parameters (see Curtis et al. 1997, Chu & Tai 2005).
    this.params = {
      substeps: 3,
      dt: 1.0,
      grav: 6.0,        // water-surface slope pull (lubrication mobility)
      paperSlope: 0.5,  // paper relief influence on flow
      inertia: 0.8,     // velocity memory: lets drop impulses ripple outward
      maran: 1.0,       // Marangoni strength: blooms in wet washes
      tilt: [0, 0],     // gravity vector from device tilt
      edgeFlow: 0.03,   // outward drift at wash rim (contact line ~pinned)
      maxSpeed: 0.6,    // CFL guard, cells/step
      smooth: 0.04,     // height diffusion / surface tension stand-in
      // Drying budget, applied in PULSES (see dryPulse). The state textures
      // are RGBA16F, so a per-substep decrement smaller than ~0.05% of the
      // stored value rounds away to nothing — which silently froze drying
      // entirely once the rates were slowed to a realistic pace. Applying
      // the same total loss once every `dryPulse` substeps keeps every
      // decrement comfortably above the precision floor.
      dryPulse: 16,     // substeps between drying updates
      evap: 0.0000037,  // bulk evaporation (per substep, scaled by dryPulse)
      edgeEvap: 20.0,   // extra rim evaporation multiplier (edge darkening)
      absorb: 0.000012, // absorption into the sheet
      satEvap: 0.0000015, // the damp sheet drying out: must be well under
                          // `absorb`, or the paper can never become damp
                          // and there is no damp stage and no backruns
      dryScale: 1.0,    // user drying-speed control
      wetThresh: 0.0008,
      wick: 0.15,       // capillary diffusion rate
      wickThresh: 0.18,
      backrun: 0.35,    // fraction of fiber capacity that re-wets a wash
      pigDiff: 0.12,    // Brownian pigment diffusion in free water
      settle: 0.08,     // global time scale on Curtis deposition rates
      lift: 0.012,      // resolubility: rewet-lift rate per step
      saltPush: 6.0,    // salt starburst pigment repulsion (texels)
      saltSpacing: 9.0, // mean spacing between grains (sim texels)
      saltGrain: 2.6,   // mean grain radius (sim texels)
      saltDensity: 0.45,// fraction of grid cells that get a grain
      drySpeed: 1.0,    // user "dry fast" multiplier
      flow: 1.0,        // 0 = paint and water stay put (no run-off)
    };
    // Baselines for the run-off toggle, captured before any opts override.
    this._flowBase = null;
    this.params.paperSlope = this.paper.paperSlope;
    Object.assign(this.params, opts.params || {});
    this._flowBase = {};
    for (const k of ['grav', 'maran', 'edgeFlow', 'smooth', 'pigDiff', 'wick', 'inertia']) {
      this._flowBase[k] = this.params[k];
    }

    this._initGeometry();
    this._initPrograms();
    this.resize();
  }

  // ------------------------------------------------------------ GL setup --
  _initGeometry() {
    const gl = this.gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  _compile(type, src) {
    const gl = this.gl;
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('Shader compile error:\n' + gl.getShaderInfoLog(sh) + '\n--- source ---\n' + src);
    }
    return sh;
  }

  _program(name, fragSrc) {
    const gl = this.gl;
    const prog = gl.createProgram();
    gl.attachShader(prog, this._compile(gl.VERTEX_SHADER, SHADERS.vert));
    gl.attachShader(prog, this._compile(gl.FRAGMENT_SHADER, fragSrc));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`Program link error (${name}): ` + gl.getProgramInfoLog(prog));
    }
    const uniforms = {};
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i);
      const uname = info.name.replace(/\[0\]$/, '');
      uniforms[uname] = gl.getUniformLocation(prog, info.name);
    }
    return { prog, uniforms };
  }

  _initPrograms() {
    this.progs = {};
    for (const name of ['paper', 'splat', 'velocity', 'height', 'moisture', 'capillary', 'advect', 'transferSusp', 'transferDep', 'render', 'salt', 'dryer', 'clear', 'copy']) {
      this.progs[name] = this._program(name, SHADERS[name]);
    }
  }

  _makeTexture(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  _makePair(w, h) {
    return { read: this._makeTexture(w, h), write: this._makeTexture(w, h), swap() { const t = this.read; this.read = this.write; this.write = t; } };
  }

  _deletePair(p) {
    this.gl.deleteTexture(p.read);
    this.gl.deleteTexture(p.write);
  }

  // ------------------------------------------------------------- sizing ---
  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);

    const scale = Math.min(1, this.maxSim / Math.max(cssW, cssH));
    const w = Math.max(64, Math.round(cssW * scale));
    const h = Math.max(64, Math.round(cssH * scale));
    if (this.simW === w && this.simH === h) return;
    this.simW = w;
    this.simH = h;
    this.texel = [1 / w, 1 / h];

    for (const p of ['flow', 'sat']) {
      if (this[p]) this._deletePair(this[p]);
      this[p] = this._makePair(w, h);
    }
    if (this.susp) { this.susp.forEach((p) => this._deletePair(p)); this.dep.forEach((p) => this._deletePair(p)); }
    this.susp = [];
    this.dep = [];
    for (let i = 0; i < PIG_TEXTURES; i++) {
      this.susp.push(this._makePair(w, h));
      this.dep.push(this._makePair(w, h));
    }
    if (this.paperTex) gl.deleteTexture(this.paperTex);
    this.paperTex = this._makeTexture(w, h);
    if (!this.fbo) this.fbo = gl.createFramebuffer();

    this.clearAll();
    this.regenPaper(Math.random() * 100);
  }

  // -------------------------------------------------------- persistence ---
  // Deposited pigment quantized to 8 bits (scale 128 -> max 2.0); suspended
  // pigment and free water are intentionally dropped: the painting "dries"
  // across a reload, like leaving a real sheet overnight.
  readDeposits() {
    const gl = this.gl;
    if (!this._readFbo) this._readFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._readFbo);
    const layers = [];
    const tmp = new Float32Array(this.simW * this.simH * 4);
    try {
      for (let i = 0; i < PIG_TEXTURES; i++) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.dep[i].read, 0);
        gl.readPixels(0, 0, this.simW, this.simH, gl.RGBA, gl.FLOAT, tmp);
        const q = new Uint8Array(tmp.length);
        for (let j = 0; j < tmp.length; j++) q[j] = Math.min(255, Math.max(0, Math.round(tmp[j] * 128)));
        layers.push(q);
      }
    } catch (e) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { w: this.simW, h: this.simH, layers };
  }

  writeDeposits(snap) {
    if (!snap || !snap.layers || snap.layers.length !== PIG_TEXTURES) return;
    const gl = this.gl;
    const tmpTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tmpTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA16F, snap.w, snap.h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const f = new Float32Array(snap.w * snap.h * 4);
    for (let i = 0; i < PIG_TEXTURES; i++) {
      const q = snap.layers[i];
      for (let j = 0; j < q.length; j++) f[j] = q[j] / 128;
      gl.bindTexture(gl.TEXTURE_2D, tmpTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, snap.w, snap.h, gl.RGBA, gl.FLOAT, f);
      this._bindOutputs([this.dep[i].write]);
      this._use('copy', [['uTex', tmpTex]]);
      this._draw();
      this.dep[i].swap();
    }
    gl.deleteTexture(tmpTex);
  }

  // ---------------------------------------------------------- pass utils --
  _bindOutputs(textures) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const bufs = [];
    for (let i = 0; i < textures.length; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, textures[i], 0);
      bufs.push(gl.COLOR_ATTACHMENT0 + i);
    }
    for (let i = textures.length; i < PIG_TEXTURES + 1; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
    }
    gl.drawBuffers(bufs);
    gl.viewport(0, 0, this.simW, this.simH);
  }

  _use(name, inputs) {
    const gl = this.gl;
    const p = this.progs[name];
    gl.useProgram(p.prog);
    if (p.uniforms.uTexel) gl.uniform2f(p.uniforms.uTexel, this.texel[0], this.texel[1]);
    if (p.uniforms.uDt) gl.uniform1f(p.uniforms.uDt, this.params.dt);
    let unit = 0;
    for (const [uname, tex] of inputs) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(p.uniforms[uname], unit);
      unit++;
    }
    return p;
  }

  _draw() {
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  _suspInputs() {
    return this.susp.map((p, i) => [`uSusp${i}`, p.read]);
  }

  _depInputs() {
    return this.dep.map((p, i) => [`uDep${i}`, p.read]);
  }

  // --------------------------------------------------------------- state --
  clearAll() {
    const gl = this.gl;
    const pairs = [this.flow, this.sat, ...this.susp, ...this.dep];
    for (const pair of pairs) {
      for (const t of [pair.read, pair.write]) {
        this._bindOutputs([t]);
        const pr = this._use('clear', []);
        gl.uniform4f(pr.uniforms.uValue, 0, 0, 0, 0);
        this._draw();
      }
    }
  }

  // Clear only a horizontal band (css-x range) of all state textures —
  // used to rinse a single segment of the mixing plate.
  clearRegion(x0Css, x1Css) {
    const gl = this.gl;
    const cssW = this.canvas.clientWidth || this.canvas.width;
    const px0 = Math.max(0, Math.floor((x0Css / cssW) * this.simW));
    const px1 = Math.min(this.simW, Math.ceil((x1Css / cssW) * this.simW));
    if (px1 <= px0) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(px0, 0, px1 - px0, this.simH);
    const pairs = [this.flow, this.sat, ...this.susp, ...this.dep];
    for (const pair of pairs) {
      for (const t of [pair.read, pair.write]) {
        this._bindOutputs([t]);
        const pr = this._use('clear', []);
        gl.uniform4f(pr.uniforms.uValue, 0, 0, 0, 0);
        this._draw();
      }
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  regenPaper(seed) {
    const gl = this.gl;
    this.paperSeed = seed;
    this._bindOutputs([this.paperTex]);
    const p = this._use('paper', []);
    gl.uniform1f(p.uniforms.uSeed, seed);
    gl.uniform1f(p.uniforms.uGrainAmp, this.paper.grain);
    gl.uniform1f(p.uniforms.uToothAmp, this.paper.tooth);
    gl.uniform1f(p.uniforms.uFiberAmp, this.paper.fiber);
    gl.uniform1f(p.uniforms.uCapBase, this.paper.capBase);
    gl.uniform1f(p.uniforms.uCapVar, this.paper.capVar);
    gl.uniform1f(p.uniforms.uWells, this.wells || 0);
    this._draw();
  }

  // Switch paper preset: regenerates the sheet (clears the painting).
  setPaper(name, seed) {
    if (!PAPERS[name]) return;
    this.paperName = name;
    this.paper = PAPERS[name];
    this.params.paperSlope = this.paper.paperSlope;
    this.clearAll();
    this.regenPaper(seed != null ? seed : Math.random() * 100);
  }

  // Run-off on/off. With flow off the sheet still wets, dries, absorbs,
  // granulates and takes backruns — but nothing travels: no downhill
  // running, no Marangoni blooming, no wandering edges. Paint stays exactly
  // where the brush put it, which is what you want for controlled detail.
  setFlow(on) {
    const b = this._flowBase;
    this.params.flow = on ? 1 : 0;
    this.params.grav = on ? b.grav : 0;
    this.params.maran = on ? b.maran : 0;
    this.params.edgeFlow = on ? b.edgeFlow : 0;
    this.params.inertia = on ? b.inertia : 0;
    // a little of each is kept so a wash still softens instead of looking
    // like a hard-edged decal
    this.params.smooth = on ? b.smooth : b.smooth * 0.15;
    this.params.pigDiff = on ? b.pigDiff : b.pigDiff * 0.15;
    this.params.wick = on ? b.wick : b.wick * 0.3;
    if (!on) this.params.tilt = [0, 0];
  }

  // A drop of clean water off the end of the brush (or a dropper): lands as
  // a deep, sharply-bounded puddle. On a wash that has lost its shine this
  // is what makes a bloom — the drop's water pushes outward through the
  // damp paint and strands it in a cauliflower ring.
  dropWater(xCss, yCss, radiusCss, amount = 1.0) {
    const empty = this._emptyPig || (this._emptyPig = new Float32Array(PIG_TEXTURES * 4));
    this.splat(xCss, yCss, radiusCss, 0.28 * amount, empty, 1.0, 0);
    // A backrun is not just water pushing pigment about: the drop lands on
    // paint that has only just set and RE-DISSOLVES it, then carries it out
    // to the drop's rim, where it strands as the cauliflower edge. Lifting
    // is gated on free surface water, so raising it globally for a while
    // only acts where the drop actually is.
    this._rewet = Math.max(this._rewet || 0, 300);
  }

  // --------------------------------------------------------------- brush --
  // pig: Float32Array(16) of pigment amounts; water in [0..~0.1]
  splat(xCss, yCss, radiusCss, water, pig, wetness, scrub = 0) {
    const gl = this.gl;
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    const u = xCss / cssW;
    const v = 1 - yCss / cssH;
    const aspect = cssW / cssH;

    this._bindOutputs([this.flow.write, ...this.susp.map((p) => p.write)]);
    const p = this._use('splat', [
      ['uFlow', this.flow.read],
      ...this._suspInputs(),
      ['uPaper', this.paperTex],
    ]);
    gl.uniform2f(p.uniforms.uCenter, u, v);
    gl.uniform1f(p.uniforms.uRadius, radiusCss / cssW);
    gl.uniform2f(p.uniforms.uAspect, 1.0, 1.0 / aspect);
    gl.uniform1f(p.uniforms.uWaterAmt, water);
    for (let i = 0; i < PIG_TEXTURES; i++) {
      gl.uniform4f(p.uniforms[`uPig${i}`], pig[i * 4], pig[i * 4 + 1], pig[i * 4 + 2], pig[i * 4 + 3]);
    }
    gl.uniform1f(p.uniforms.uWetness, wetness);
    gl.uniform1f(p.uniforms.uPush, Math.min(0.6, water * 8.0));
    gl.uniform1f(p.uniforms.uScrub, scrub);
    this._draw();
    this.flow.swap();
    this.susp.forEach((pr) => pr.swap());
  }

  // ---------------------------------------------------------------- step --
  step() {
    const gl = this.gl;
    const P = this.params;
    for (let s = 0; s < P.substeps; s++) {
      // 1. velocity
      this._bindOutputs([this.flow.write]);
      let p = this._use('velocity', [
        ['uFlow', this.flow.read], ['uPaper', this.paperTex],
        ...this._suspInputs(),
      ]);
      gl.uniform1f(p.uniforms.uGrav, P.grav);
      gl.uniform1f(p.uniforms.uPaperSlope, P.paperSlope);
      gl.uniform1f(p.uniforms.uInertia, P.inertia);
      gl.uniform1f(p.uniforms.uEdgeFlow, P.edgeFlow);
      gl.uniform1f(p.uniforms.uMaran, P.maran);
      gl.uniform2f(p.uniforms.uTilt, P.tilt[0], P.tilt[1]);
      gl.uniform1f(p.uniforms.uMaxSpeed, P.maxSpeed);
      this._draw();
      this.flow.swap();

      // 2. height / continuity
      this._bindOutputs([this.flow.write]);
      p = this._use('height', [['uFlow', this.flow.read]]);
      gl.uniform1f(p.uniforms.uSmooth, P.smooth);
      this._draw();
      this.flow.swap();

      // 3. moisture: evaporation + absorption
      this._bindOutputs([this.flow.write, this.sat.write]);
      p = this._use('moisture', [['uFlow', this.flow.read], ['uSat', this.sat.read], ['uPaper', this.paperTex]]);
      // Pulsed drying: nothing on most substeps, then the accumulated loss
      // in one go (see the note on dryPulse).
      this._dryPhase = (this._dryPhase || 0) + 1;
      const pulse = this._dryPhase % P.dryPulse === 0 ? P.dryPulse : 0;
      const dry = P.drySpeed * P.dryScale * pulse;
      gl.uniform1f(p.uniforms.uEvap, P.evap * dry);
      gl.uniform1f(p.uniforms.uEdgeEvap, P.edgeEvap);
      gl.uniform1f(p.uniforms.uAbsorb, P.absorb * dry);
      gl.uniform1f(p.uniforms.uSatEvap, P.satEvap * dry);
      gl.uniform1f(p.uniforms.uWetThresh, P.wetThresh);
      this._draw();
      this.flow.swap();
      this.sat.swap();

      // 4. capillary wicking / backruns
      this._bindOutputs([this.flow.write, this.sat.write]);
      p = this._use('capillary', [['uFlow', this.flow.read], ['uSat', this.sat.read], ['uPaper', this.paperTex]]);
      gl.uniform1f(p.uniforms.uWick, P.wick);
      gl.uniform1f(p.uniforms.uWickThresh, P.wickThresh);
      gl.uniform1f(p.uniforms.uBackrun, P.backrun);
      this._draw();
      this.flow.swap();
      this.sat.swap();

      // 5. pigment advection + diffusion (+ salt starburst repulsion)
      this._bindOutputs(this.susp.map((pr) => pr.write));
      p = this._use('advect', [['uFlow', this.flow.read], ['uSat', this.sat.read], ...this._suspInputs()]);
      gl.uniform1f(p.uniforms.uPigDiff, P.pigDiff);
      gl.uniform1f(p.uniforms.uSaltPush, P.saltPush);
      this._draw();
      this.susp.forEach((pr) => pr.swap());

      // 6. deposition / lifting: two draws over the same pre-pass state
      // (suspension update, then deposit update), swap everything after.
      this._ensurePigParams();
      for (const [prog, targets] of [['transferSusp', this.susp], ['transferDep', this.dep]]) {
        this._bindOutputs(targets.map((pr) => pr.write));
        p = this._use(prog, [
          ['uFlow', this.flow.read], ['uPaper', this.paperTex],
          ...this._suspInputs(), ...this._depInputs(),
        ]);
        gl.uniform4fv(p.uniforms.uRho, this._pigParams.rho);
        gl.uniform4fv(p.uniforms.uOmega, this._pigParams.omega);
        gl.uniform4fv(p.uniforms.uGamma, this._pigParams.gamma);
        gl.uniform4fv(p.uniforms.uGrain, this._pigParams.grain);
        gl.uniform1f(p.uniforms.uSettle, P.settle);
        gl.uniform1f(p.uniforms.uLift, P.lift * (this._rewet > 0 ? 12 : 1));
        this._draw();
      }
      this.susp.forEach((pr) => pr.swap());
      this.dep.forEach((pr) => pr.swap());
      if (this._rewet > 0) this._rewet--;
    }
  }

  render() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const p = this._use('render', [
      ['uFlow', this.flow.read], ['uSat', this.sat.read], ['uPaper', this.paperTex],
      ...this._suspInputs(), ...this._depInputs(),
    ]);
    const n = PIG_TEXTURES * 4;
    const K = new Float32Array(n * 3), S = new Float32Array(n * 3);
    const metal = new Float32Array(n), mcol = new Float32Array(n * 3);
    CHANNELS.forEach((pg, i) => {
      if (!pg) return;
      K.set(pg.K, i * 3);
      S.set(pg.S, i * 3);
      metal[i] = pg.metal || 0;
      if (pg.mcol) mcol.set(pg.mcol, i * 3);
    });
    gl.uniform3fv(p.uniforms.uK, K);
    gl.uniform3fv(p.uniforms.uS, S);
    gl.uniform4fv(p.uniforms.uMetal, metal);
    gl.uniform3fv(p.uniforms.uMetalCol, mcol);
    gl.uniform3fv(p.uniforms.uPaperColor, this.paper.color);
    this._ensurePigParams();
    gl.uniform4fv(p.uniforms.uGamma, this._pigParams.gamma);
    gl.uniform4fv(p.uniforms.uGrain, this._pigParams.grain);
    gl.uniform1f(p.uniforms.uWetView, this.wetView ? 1 : 0);
    this._draw();
  }

  // Sprinkle salt into the wash: grains soak water and shove pigment into
  // starbursts while the paper is in the damp band.
  sprinkleSalt(xCss, yCss, radiusCss) {
    const gl = this.gl;
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    this._bindOutputs([this.sat.write]);
    const p = this._use('salt', [['uSat', this.sat.read]]);
    gl.uniform2f(p.uniforms.uCenter, xCss / cssW, 1 - yCss / cssH);
    gl.uniform1f(p.uniforms.uRadius, radiusCss / cssW);
    gl.uniform2f(p.uniforms.uAspect, 1.0, cssH / cssW);
    gl.uniform1f(p.uniforms.uSeed, Math.random() * 100);
    gl.uniform1f(p.uniforms.uDensity, this.params.saltDensity);
    gl.uniform1f(p.uniforms.uSpacing, this.params.saltSpacing);
    gl.uniform1f(p.uniforms.uGrainSize, this.params.saltGrain);
    this._draw();
    this.sat.swap();
  }

  // Hair dryer: point it at the sheet and hold. dirX/dirY is the direction
  // the air is travelling across the paper (from the stroke), so dragging
  // the nozzle blows the wet film along with it.
  blowDry(xCss, yCss, radiusCss, dirX = 0, dirY = 0, power = 1.0) {
    const gl = this.gl;
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    this._bindOutputs([this.flow.write, this.sat.write]);
    const p = this._use('dryer', [['uFlow', this.flow.read], ['uSat', this.sat.read]]);
    gl.uniform2f(p.uniforms.uCenter, xCss / cssW, 1 - yCss / cssH);
    gl.uniform1f(p.uniforms.uRadius, radiusCss / cssW);
    gl.uniform2f(p.uniforms.uAspect, 1.0, cssH / cssW);
    gl.uniform2f(p.uniforms.uDir, dirX, -dirY); // css y is down, sim y is up
    gl.uniform1f(p.uniforms.uPower, power);
    this._draw();
    this.flow.swap();
    this.sat.swap();
  }

  // Average pigment mixture + water under a brush footprint (css px), used
  // by the mixing tray so the brush picks up what it touches. Reads one
  // pixel per pigment texture at the sim cell under the center.
  readMix(xCss, yCss) {
    const gl = this.gl;
    const cssW = this.canvas.clientWidth || this.canvas.width;
    const cssH = this.canvas.clientHeight || this.canvas.height;
    const px = Math.max(0, Math.min(this.simW - 1, Math.round((xCss / cssW) * this.simW)));
    const py = Math.max(0, Math.min(this.simH - 1, Math.round((1 - yCss / cssH) * this.simH)));
    const out = { pig: new Float32Array(PIG_TEXTURES * 4), water: 0 };
    if (!this._readFbo) this._readFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._readFbo);
    const buf = new Float32Array(4);
    const readTex = (tex) => {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.FLOAT, buf);
      return buf;
    };
    try {
      for (let i = 0; i < PIG_TEXTURES; i++) {
        const b = readTex(this.susp[i].read);
        out.pig.set(b, i * 4);
      }
      const f = readTex(this.flow.read);
      out.water = f[0];
    } catch (e) {
      // float readback unsupported: pickup silently degrades to no-op
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  _ensurePigParams() {
    if (this._pigParams && this._pigVersion === CHANNELS.version) return;
    this._pigVersion = CHANNELS.version;
    const n = PIG_TEXTURES * 4;
    this._pigParams = this._pigParams || {
      rho: new Float32Array(n), omega: new Float32Array(n), gamma: new Float32Array(n), grain: new Float32Array(n),
    };
    this._pigParams.rho.fill(0);
    this._pigParams.gamma.fill(0);
    this._pigParams.grain.fill(0);
    // omega is a divisor: default 1 for unused channels to avoid div-by-zero
    this._pigParams.omega.fill(1);
    CHANNELS.forEach((pg, i) => {
      if (!pg) return;
      this._pigParams.rho[i] = pg.rho;
      this._pigParams.omega[i] = pg.omega;
      this._pigParams.gamma[i] = pg.gamma;
      this._pigParams.grain[i] = pg.grain;
    });
  }
}
