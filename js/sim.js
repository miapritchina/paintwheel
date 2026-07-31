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
  ceramic:   { label: 'Ceramic',    grain: 0.03, tooth: 0.0,  fiber: 0.02, capBase: 0.0,  capVar: 0.0,  color: [0.97, 0.97, 0.96], paperSlope: 0.05 },
};

class WatercolorSim {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.paper = PAPERS[opts.paper || 'coldpress'];
    this.maxSim = opts.maxSim || 1024;
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
      evap: 0.00002,    // bulk evaporation per step: pools live ~10-20 s
      edgeEvap: 20.0,   // extra rim evaporation multiplier (edge darkening)
      absorb: 0.0002,   // rate of exponential approach of sat -> capacity
      satEvap: 0.00004, // paper drying
      wetThresh: 0.0008,
      wick: 0.15,       // capillary diffusion rate
      wickThresh: 0.18,
      backrun: 0.35,    // fraction of fiber capacity that re-wets a wash
      pigDiff: 0.12,    // Brownian pigment diffusion in free water
      settle: 0.08,     // global time scale on Curtis deposition rates
      lift: 0.012,      // resolubility: rewet-lift rate per step
      drySpeed: 1.0,    // user "dry fast" multiplier
    };
    this.params.paperSlope = this.paper.paperSlope;
    Object.assign(this.params, opts.params || {});

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
    for (const name of ['paper', 'splat', 'velocity', 'height', 'moisture', 'capillary', 'advect', 'transferSusp', 'transferDep', 'render', 'clear']) {
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
    this._bindOutputs([this.paperTex]);
    const p = this._use('paper', []);
    gl.uniform1f(p.uniforms.uSeed, seed);
    gl.uniform1f(p.uniforms.uGrainAmp, this.paper.grain);
    gl.uniform1f(p.uniforms.uToothAmp, this.paper.tooth);
    gl.uniform1f(p.uniforms.uFiberAmp, this.paper.fiber);
    gl.uniform1f(p.uniforms.uCapBase, this.paper.capBase);
    gl.uniform1f(p.uniforms.uCapVar, this.paper.capVar);
    this._draw();
  }

  // Switch paper preset: regenerates the sheet (clears the painting).
  setPaper(name) {
    if (!PAPERS[name]) return;
    this.paper = PAPERS[name];
    this.params.paperSlope = this.paper.paperSlope;
    this.clearAll();
    this.regenPaper(Math.random() * 100);
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
      gl.uniform1f(p.uniforms.uEvap, P.evap * P.drySpeed);
      gl.uniform1f(p.uniforms.uEdgeEvap, P.edgeEvap);
      gl.uniform1f(p.uniforms.uAbsorb, P.absorb);
      gl.uniform1f(p.uniforms.uSatEvap, P.satEvap * P.drySpeed);
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

      // 5. pigment advection + diffusion
      this._bindOutputs(this.susp.map((pr) => pr.write));
      p = this._use('advect', [['uFlow', this.flow.read], ...this._suspInputs()]);
      gl.uniform1f(p.uniforms.uPigDiff, P.pigDiff);
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
        gl.uniform1f(p.uniforms.uSettle, P.settle);
        gl.uniform1f(p.uniforms.uLift, P.lift);
        this._draw();
      }
      this.susp.forEach((pr) => pr.swap());
      this.dep.forEach((pr) => pr.swap());
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
    PIGMENTS.forEach((pg, i) => { K.set(pg.K, i * 3); S.set(pg.S, i * 3); });
    gl.uniform3fv(p.uniforms.uK, K);
    gl.uniform3fv(p.uniforms.uS, S);
    gl.uniform3fv(p.uniforms.uPaperColor, this.paper.color);
    this._ensurePigParams();
    gl.uniform4fv(p.uniforms.uGamma, this._pigParams.gamma);
    this._draw();
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
    if (this._pigParams && this._pigVersion === PIGMENTS.version) return;
    this._pigVersion = PIGMENTS.version;
    const n = PIG_TEXTURES * 4;
    this._pigParams = this._pigParams || {
      rho: new Float32Array(n), omega: new Float32Array(n), gamma: new Float32Array(n),
    };
    this._pigParams.rho.fill(0);
    this._pigParams.gamma.fill(0);
    // omega is a divisor: default 1 for unused channels to avoid div-by-zero
    this._pigParams.omega.fill(1);
    PIGMENTS.forEach((pg, i) => {
      this._pigParams.rho[i] = pg.rho;
      this._pigParams.omega[i] = pg.omega;
      this._pigParams.gamma[i] = pg.gamma;
    });
  }
}
