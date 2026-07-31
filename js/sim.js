// WebGL2 engine for the watercolor simulation: texture ping-pong, MRT passes,
// and the per-frame pipeline described in shaders.js.

'use strict';

class WatercolorSim {
  constructor(canvas) {
    this.canvas = canvas;
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

    // RGBA16F is filterable in core WebGL2; renderability needs one of these.
    const extF = gl.getExtension('EXT_color_buffer_float');
    const extHF = gl.getExtension('EXT_color_buffer_half_float');
    if (!extF && !extHF) throw new Error('Floating-point render targets are not supported.');

    // Tunable physical parameters (see Curtis et al. 1997, Chu & Tai 2005).
    this.params = {
      substeps: 3,
      dt: 1.0,
      grav: 6.0,        // water-surface slope pull (lubrication mobility)
      paperSlope: 0.5,  // paper relief influence on flow
      inertia: 0.8,     // velocity memory: lets drop impulses ripple outward
      maran: 1.0,       // Marangoni strength: blooms in wet washes
      tilt: [0, 0],     // gravity vector from device tilt (uv units/step)
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
    for (const name of ['paper', 'splat', 'velocity', 'height', 'moisture', 'capillary', 'advect', 'transfer', 'render', 'clear']) {
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

  // ------------------------------------------------------------- sizing ---
  resize() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);

    // Sim grid: cap the long side; enough for convincing detail, cheap enough
    // for phones. Display shader upsamples with paper detail on top.
    const MAXSIM = 1024;
    const scale = Math.min(1, MAXSIM / Math.max(cssW, cssH));
    const w = Math.max(64, Math.round(cssW * scale));
    const h = Math.max(64, Math.round(cssH * scale));
    if (this.simW === w && this.simH === h) return;
    this.simW = w;
    this.simH = h;
    this.texel = [1 / w, 1 / h];

    for (const p of ['flow', 'sat', 'suspA', 'suspB', 'depA', 'depB']) {
      if (this[p]) { gl.deleteTexture(this[p].read); gl.deleteTexture(this[p].write); }
      this[p] = this._makePair(w, h);
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
    // detach leftovers from previous MRT passes
    for (let i = textures.length; i < 4; i++) {
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

  // --------------------------------------------------------------- state --
  clearAll() {
    const gl = this.gl;
    for (const p of ['flow', 'sat', 'suspA', 'suspB', 'depA', 'depB']) {
      for (const t of [this[p].read, this[p].write]) {
        this._bindOutputs([t]);
        const pr = this._use('clear', []);
        gl.uniform4f(pr.uniforms.uValue, 0, 0, 0, 0);
        this._draw();
      }
    }
  }

  regenPaper(seed) {
    const gl = this.gl;
    this._bindOutputs([this.paperTex]);
    const p = this._use('paper', []);
    gl.uniform1f(p.uniforms.uSeed, seed);
    this._draw();
  }

  // --------------------------------------------------------------- brush --
  // pig: Float32Array(8) of pigment amounts; water in [0..~0.1]; radius px(css)
  splat(xCss, yCss, radiusCss, water, pig, wetness, scrub = 0) {
    const gl = this.gl;
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    const u = xCss / cssW;
    const v = 1 - yCss / cssH;
    const aspect = cssW / cssH;

    this._bindOutputs([this.flow.write, this.suspA.write, this.suspB.write]);
    const p = this._use('splat', [
      ['uFlow', this.flow.read],
      ['uSuspA', this.suspA.read],
      ['uSuspB', this.suspB.read],
      ['uPaper', this.paperTex],
    ]);
    gl.uniform2f(p.uniforms.uCenter, u, v);
    gl.uniform1f(p.uniforms.uRadius, radiusCss / cssW);
    gl.uniform2f(p.uniforms.uAspect, 1.0, 1.0 / aspect);
    gl.uniform1f(p.uniforms.uWaterAmt, water);
    gl.uniform4f(p.uniforms.uPigA, pig[0], pig[1], pig[2], pig[3]);
    gl.uniform4f(p.uniforms.uPigB, pig[4], pig[5], pig[6], pig[7]);
    gl.uniform1f(p.uniforms.uWetness, wetness);
    gl.uniform1f(p.uniforms.uPush, Math.min(0.6, water * 8.0));
    gl.uniform1f(p.uniforms.uScrub, scrub);
    this._draw();
    this.flow.swap();
    this.suspA.swap();
    this.suspB.swap();
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
        ['uSuspA', this.suspA.read], ['uSuspB', this.suspB.read],
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
      this._bindOutputs([this.suspA.write, this.suspB.write]);
      p = this._use('advect', [['uFlow', this.flow.read], ['uSuspA', this.suspA.read], ['uSuspB', this.suspB.read]]);
      gl.uniform1f(p.uniforms.uPigDiff, P.pigDiff);
      this._draw();
      this.suspA.swap();
      this.suspB.swap();

      // 6. deposition / lifting
      this._bindOutputs([this.suspA.write, this.suspB.write, this.depA.write, this.depB.write]);
      p = this._use('transfer', [
        ['uFlow', this.flow.read], ['uPaper', this.paperTex],
        ['uSuspA', this.suspA.read], ['uSuspB', this.suspB.read],
        ['uDepA', this.depA.read], ['uDepB', this.depB.read],
      ]);
      const g = (k) => PIGMENTS.map((pg) => pg[k]);
      const rho = g('rho'), om = g('omega'), ga = g('gamma');
      gl.uniform4f(p.uniforms.uRhoA, rho[0], rho[1], rho[2], rho[3]);
      gl.uniform4f(p.uniforms.uRhoB, rho[4], rho[5], rho[6], rho[7]);
      gl.uniform4f(p.uniforms.uOmegaA, om[0], om[1], om[2], om[3]);
      gl.uniform4f(p.uniforms.uOmegaB, om[4], om[5], om[6], om[7]);
      gl.uniform4f(p.uniforms.uGammaA, ga[0], ga[1], ga[2], ga[3]);
      gl.uniform4f(p.uniforms.uGammaB, ga[4], ga[5], ga[6], ga[7]);
      gl.uniform1f(p.uniforms.uSettle, P.settle);
      gl.uniform1f(p.uniforms.uLift, P.lift);
      this._draw();
      this.suspA.swap();
      this.suspB.swap();
      this.depA.swap();
      this.depB.swap();
    }
  }

  render() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    const p = this._use('render', [
      ['uFlow', this.flow.read], ['uSat', this.sat.read], ['uPaper', this.paperTex],
      ['uSuspA', this.suspA.read], ['uSuspB', this.suspB.read],
      ['uDepA', this.depA.read], ['uDepB', this.depB.read],
    ]);
    if (!this._kmUploaded || this._kmProg !== p) {
      const K = new Float32Array(24), S = new Float32Array(24);
      PIGMENTS.forEach((pg, i) => { K.set(pg.K, i * 3); S.set(pg.S, i * 3); });
      gl.uniform3fv(p.uniforms.uK, K);
      gl.uniform3fv(p.uniforms.uS, S);
      const ga = PIGMENTS.map((pg) => pg.gamma);
      gl.uniform4f(p.uniforms.uGammaA, ga[0], ga[1], ga[2], ga[3]);
      gl.uniform4f(p.uniforms.uGammaB, ga[4], ga[5], ga[6], ga[7]);
      this._kmUploaded = true;
      this._kmProg = p;
    }
    this._draw();
  }
}
