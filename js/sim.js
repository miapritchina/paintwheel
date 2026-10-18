// WebGL2 engine for the watercolor simulation: texture ping-pong, MRT passes,
// and the per-frame pipeline described in shaders.js. Pigment concentrations
// live in PIG_TEXTURES RGBA pairs (16 pigments), suspended + deposited.

'use strict';

// Paper presets: procedural texture + absorbency + base color + flow feel.
const PAPERS = {
  coldpress: { label: 'Cold press', grain: 0.55, tooth: 0.35, fiber: 0.10, capBase: 0.55, capVar: 0.22, color: [0.94, 0.92, 0.87], paperSlope: 0.5 },
  hotpress:  { label: 'Hot press',  grain: 0.22, tooth: 0.08, fiber: 0.05, capBase: 0.50, capVar: 0.10, color: [0.95, 0.94, 0.90], paperSlope: 0.2 },
  rough:     { label: 'Rough',      grain: 0.72, tooth: 0.55, fiber: 0.12, capBase: 0.60, capVar: 0.25, color: [0.93, 0.91, 0.85], paperSlope: 0.7 },
  toned:     { label: 'Toned cream',grain: 0.50, tooth: 0.30, fiber: 0.10, capBase: 0.55, capVar: 0.20, color: [0.90, 0.85, 0.72], paperSlope: 0.5 },
  // the mixing plate: no tooth, no absorbency, but a steep relief so the
  // well rims actually contain the liquid
  ceramic:   { label: 'Ceramic',    grain: 0.03, tooth: 0.0,  fiber: 0.02, capBase: 0.0,  capVar: 0.0,  color: [0.97, 0.97, 0.96], paperSlope: 25.0 },
};

class WatercolorSim {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.paperName = opts.paper || 'rough';
    this.paper = PAPERS[this.paperName];
    this.maxSim = opts.maxSim || 1024;
    this.dprCap = opts.dprCap || 3;
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
    const extLin = gl.getExtension('OES_texture_float_linear');
    if (!extF && !extHF) throw new Error('Floating-point render targets are not supported.');
    // The state lives in FULL floats where the GPU allows it. Half floats
    // resolve about one part in a thousand, and most of what happens to a
    // wash per substep is smaller than that: a slow settling takes 0.06% of
    // the suspended pigment, a slow evaporation a few hundredths of a
    // percent of the film. In half floats "suspended minus that" rounds back
    // to the same number while "deposit plus that" is representable — so
    // every substep invented pigment (measured: +40% over one stroke) and
    // settling itself stalled. The drying code had hit the same floor and
    // been pulsed around it; the clean answer is the extra 16 bits.
    this.texFormat = extF && extLin ? gl.RGBA32F : gl.RGBA16F;
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
      // Velocity memory: lets drop impulses ripple outward. 0.8 made the
      // film ring like a struck bell — standing ripples across every wash
      // once the water lasted long enough to show them.
      inertia: 0.4,
      // Marangoni strength. Measured on a lightly-wetted sheet, a drop of
      // colour reaches 2247 cells at 1.0, 3937 at 2.0 and 5864 at 3.5; at
      // 1.0 wet-on-wet barely reacted, which is not what a wet sheet does.
      maran: 2.2,       // Marangoni strength: blooms in wet washes
      tilt: [0, 0],     // gravity vector from device tilt
      edgeFlow: 0.03,   // outward drift at wash rim (contact line ~pinned)
      maxSpeed: 0.6,    // CFL guard, cells/step
      // the contact line: a face into dry paper opens as the film deepens
      // from pinLo to pinHi (pinHi 0 = no pinning)
      pinLo: 0.012,
      pinHi: 0.03,
      // Surface tension levelling the film. 0.04 let a fifty-texel patch
      // stay thicker than its neighbour for the whole drying time, and the
      // thinner patch dried first, as a front with the rim's evaporation.
      // At 0.3 the film is level across a wash well before it dries, and
      // the levelling carries pigment with it (see advect).
      smooth: 0.3,
      // Drying budget, applied in PULSES (see dryPulse). The state textures
      // are RGBA16F, so a per-substep decrement smaller than ~0.05% of the
      // stored value rounds away to nothing — which silently froze drying
      // entirely once the rates were slowed to a realistic pace. Applying
      // the same total loss once every `dryPulse` substeps keeps every
      // decrement comfortably above the precision floor.
      dryPulse: 16,     // substeps between drying updates
      // Open time. Measured on one stroke at these rates: the water's
      // half-life is ~600 steps (ten seconds at 60 fps, twenty at the
      // drying slider's default), and the sheet is dry in about four
      // half-lives. The old rates dried the same stroke in 275 steps —
      // under five seconds — which is why wet-in-wet never had time.
      evap: 0.0000005,  // bulk evaporation (per substep, scaled by dryPulse)
      // Extra rim evaporation (edge darkening). 20x drank the rim so fast
      // that the levelling, now that it carries pigment, fed the whole
      // wash's colour into the edge; a ring is a share, not the lot.
      edgeEvap: 5.0,
      absorb: 0.0000016, // absorption into the sheet
      runAbsorb: 0.0025, // extra imbibition under moving water on dry paper
      satEvap: 0.0000002, // the damp sheet drying out: must be well under
                          // `absorb`, or the paper can never become damp
                          // and there is no damp stage and no backruns
      dryScale: 1.0,    // user drying-speed control
      wetThresh: 0.0008,
      wick: 0.15,       // capillary diffusion rate
      wickThresh: 0.18,
      backrun: 0.35,    // fraction of fiber capacity that re-wets a wash
      // Brownian pigment diffusion. 0.12 blurred every bloom into a soft
      // gaussian; a real bloom is carried, not diffused, and its edge is
      // fingers. Most of the mixing now rides the levelling flow instead.
      pigDiff: 0.05,
      // Global time scale on Curtis deposition rates. Pigment stays mobile
      // while the wash is wet: half of a stroke's load settles in ~400
      // steps, the rest as the film thins (dryBoost in transfer).
      settle: 0.012,
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
    for (const name of ['paper', 'splat', 'velocity', 'height', 'moisture', 'capillary', 'transferSusp', 'transferDep', 'render', 'salt', 'probe', 'diff', 'clear', 'copy']) {
      this.progs[name] = this._program(name, SHADERS[name]);
    }
  }

  _makeTexture(w, h) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.texFormat, w, h);
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
  // Quality: the two knobs that actually cost power. `maxSim` sets how many
  // cells the physics runs on, `dprCap` how many fragments the final image
  // is drawn at — measured at 729k cells and 3.9M fragments on an iPad in
  // landscape, which is where the heat came from.
  setQuality(maxSim, dprCap) {
    if (this.maxSim === maxSim && this.dprCap === dprCap) return;
    this.maxSim = maxSim;
    this.dprCap = dprCap;
    this.simW = -1; // force the textures to be rebuilt at the new size
    this.resize();
  }

  // The SHEET is a fixed piece of paper with its own size in css pixels,
  // decided when it is made and kept until a new painting. The screen is a
  // VIEW onto it: a zoom and a centre. The two used to be the same thing —
  // the sim grid was sized from the canvas — so turning the iPad, or Safari
  // showing its toolbar, reallocated every texture and wiped the painting.
  // Now a resize only changes the canvas backing store and re-fits the view.
  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, this.dprCap || 3);
    const cssW = this.canvas.clientWidth || window.innerWidth;
    const cssH = this.canvas.clientHeight || window.innerHeight;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.cssW = cssW;
    this.cssH = cssH;
    if (!this.sheetW) {
      this.newSheet(cssW, cssH);
      return;
    }
    // The sheet stays; keep the grid resolution in step with the quality
    // setting (which is the only thing allowed to resample the painting).
    this._fitGrid(true);
    this.fitView();
    this.renderDirty = true;
  }

  // A fresh sheet sized to the screen it is made on (or an explicit size, as
  // when a saved painting is restored). Clears the painting.
  newSheet(w, h) {
    this.sheetW = Math.max(64, Math.round(w || this.cssW || window.innerWidth));
    this.sheetH = Math.max(64, Math.round(h || this.cssH || window.innerHeight));
    this._fitGrid(false);
    this.clearAll();
    this.regenPaper(Math.random() * 100);
    this.fitView();
  }

  // Allocate the grid for the current sheet and quality. `keep` resamples
  // the painting into the new textures (a quality change mid-painting);
  // otherwise the textures start empty.
  _fitGrid(keep) {
    const gl = this.gl;
    const scale = Math.min(1, this.maxSim / Math.max(this.sheetW, this.sheetH));
    const w = Math.max(64, Math.round(this.sheetW * scale));
    const h = Math.max(64, Math.round(this.sheetH * scale));
    if (this.simW === w && this.simH === h) return;
    const old = keep && this.flow ? { pairs: this._statePairs(), paper: this.paperTex, seed: this.paperSeed } : null;
    this.simW = w;
    this.simH = h;
    this.texel = [1 / w, 1 / h];

    if (!old) {
      for (const p of ['flow', 'sat']) if (this[p]) this._deletePair(this[p]);
      if (this.susp) { this.susp.forEach((p) => this._deletePair(p)); this.dep.forEach((p) => this._deletePair(p)); }
    }
    this.flow = this._makePair(w, h);
    this.sat = this._makePair(w, h);
    this.susp = [];
    this.dep = [];
    for (let i = 0; i < PIG_TEXTURES; i++) {
      this.susp.push(this._makePair(w, h));
      this.dep.push(this._makePair(w, h));
    }
    this.clearUndo();
    if (this.probeTex) { gl.deleteTexture(this.probeTex); this.probeTex = null; }
    if (this._diffTex) { gl.deleteTexture(this._diffTex); this._diffTex = null; }
    if (this._pre) { for (const t of this._pre) gl.deleteTexture(t); this._pre = null; }
    if (!old && this.paperTex) gl.deleteTexture(this.paperTex);
    this.paperTex = this._makeTexture(w, h);
    if (!this.fbo) this.fbo = gl.createFramebuffer();

    if (old) {
      // bilinear resample of every state texture into the new grid
      this._statePairs().forEach((p, i) => {
        this._copyInto(old.pairs[i].read, p.read);
        this._copyInto(old.pairs[i].read, p.write);
        this._deletePair(old.pairs[i]);
      });
      gl.deleteTexture(old.paper);
      this.regenPaper(old.seed != null ? old.seed : Math.random() * 100);
      this.markDirty();
    }
  }

  // ---------------------------------------------------------------- view --
  // zoom: screen css px per sheet css px. (cx, cy): the sheet point, in sheet
  // css px, drawn at the centre of the screen.
  fitView() {
    const zoom = Math.min(this.cssW / this.sheetW, this.cssH / this.sheetH);
    this.view = { zoom, cx: this.sheetW / 2, cy: this.sheetH / 2 };
    this.renderDirty = true;
  }

  setView(zoom, cx, cy) {
    const fit = Math.min(this.cssW / this.sheetW, this.cssH / this.sheetH);
    zoom = Math.max(fit * 0.5, Math.min(fit * 12, zoom));
    // keep at least a quarter of the screen on paper, so the sheet cannot be
    // pushed away out of reach
    const halfW = this.cssW / zoom / 2, halfH = this.cssH / zoom / 2;
    cx = Math.max(-halfW / 2, Math.min(this.sheetW + halfW / 2, cx));
    cy = Math.max(-halfH / 2, Math.min(this.sheetH + halfH / 2, cy));
    this.view = { zoom, cx, cy };
    this.renderDirty = true;
  }

  // screen css px -> sheet css px, and back
  toSheet(sx, sy) {
    const v = this.view;
    return { x: (sx - this.cssW / 2) / v.zoom + v.cx, y: (sy - this.cssH / 2) / v.zoom + v.cy };
  }
  toScreen(x, y) {
    const v = this.view;
    return { x: (x - v.cx) * v.zoom + this.cssW / 2, y: (y - v.cy) * v.zoom + this.cssH / 2 };
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
    if (!snap || !snap.layers) return;
    // a snapshot from a 16-channel session carries four layers; take the
    // first three, which are the twelve channels that still exist
    if (snap.layers.length < PIG_TEXTURES) return;
    this.markDirty();
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

  // ------------------------------------------------------------ channels --
  // Change how many pigment texture pairs are allocated. Growing keeps the
  // existing textures exactly as they are and appends empty ones, so the
  // painting is untouched when a fourth colour becomes a fifth; only the
  // pigment shaders are recompiled, because they are generated for a fixed
  // pair count. Shrinking would throw away paint, so it is only allowed on
  // an empty sheet — which is what starting a new painting is.
  setChannelTextures(n) {
    const gl = this.gl;
    n = Math.max(1, Math.min(3, n));
    if (n === PIG_TEXTURES) return true;
    if (n > gl.getParameter(gl.MAX_COLOR_ATTACHMENTS) - 1) return false;

    PIG_TEXTURES = n;
    SHADERS = buildShaders(n);
    for (const p of Object.values(this.progs)) gl.deleteProgram(p.prog);
    this._initPrograms();

    while (this.susp.length < n) {
      this.susp.push(this._makePair(this.simW, this.simH));
      this.dep.push(this._makePair(this.simW, this.simH));
    }
    while (this.susp.length > n) {
      this._deletePair(this.susp.pop());
      this._deletePair(this.dep.pop());
    }
    // undo snapshots hold a different number of layers now
    this.clearUndo();
    this._pigParams = null;
    this._pigVersion = -1;
    this.markDirty();
    return true;
  }

  // ----------------------------------------------------------------- idle --
  // Nothing on the sheet moves once the paper is dry, so there is no reason
  // to keep running the pipeline — and most of a painting session is spent
  // looking at the sheet rather than touching it. anythingWet() answers the
  // question on the GPU and reads back 16x16 bytes, cheap enough to ask a
  // few times a second; markDirty() covers everything that could have made
  // the sheet wet since the last check.
  markDirty() {
    this._dirtyUntil = (this._frames || 0) + 90; // keep running for a moment
  }

  anythingWet() {
    const gl = this.gl;
    const N = 16;
    if (!this.probeTex) {
      this.probeTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.probeTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, N, N);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this._probeBuf = new Uint8Array(N * N * 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.probeTex, 0);
    for (let i = 1; i < PIG_TEXTURES + 1; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, N, N);
    const p = this._use('probe', [['uFlow', this.flow.read], ['uSat', this.sat.read]]);
    gl.uniform2f(p.uniforms.uBlock, 1 / N, 1 / N);
    this._draw();
    let wet = false;
    try {
      gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, this._probeBuf);
      for (let i = 0; i < this._probeBuf.length; i += 4) {
        if (this._probeBuf[i] > 2) { wet = true; break; }
      }
    } catch (e) {
      wet = true; // if the readback fails, keep simulating rather than freeze
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return wet;
  }

  // Should this frame be simulated at all?
  needsStep() {
    this._frames = (this._frames || 0) + 1;
    if (this._frames < (this._dirtyUntil || 0)) return true;
    // re-ask a few times a second rather than every frame
    if (this._frames % 20 !== 0) return this._wasWet !== false;
    this._wasWet = this.anythingWet();
    return this._wasWet;
  }

  // ----------------------------------------------------------------- undo --
  // The painting is not a list of strokes, it is the state of a fluid
  // simulation, so undo has to restore that state: water, pigment still in
  // suspension and deposits alike, or undoing into a half-dry wash would
  // jump to a dried state that never existed.
  //
  // It used to copy every texture into a GPU slot per stroke — tens of
  // megabytes each, which bought two or three steps on a phone and one on a
  // big canvas. A mistake into a wash was unrecoverable, so people painted
  // timidly. Now a step stores only the REGION a stroke changed, on the CPU:
  //
  //   pushUndo()    before anything marks the sheet: the whole state is
  //                 copied into a GPU "pre" buffer (cheap), and a pending
  //                 record starts collecting the texels touched.
  //   _touch(box)   every splat / sprinkle / clear adds its footprint.
  //   commitUndo()  when the stroke ends: the touched box plus everything
  //                 wet is read back from "pre" now, while the user is not
  //                 waiting on the pen.
  //   _finalize()   at the next pushUndo (or at undo): the sheet has gone on
  //                 flowing and drying since, so the cells that actually
  //                 differ from "pre" are found on the GPU, and if they
  //                 reach outside what was read early, the record is re-read
  //                 to cover them. Then it goes on the stack.
  //   undo()        writes the record's region straight back.
  //
  // A stroke on a dry sheet is a few hundred kilobytes; a wash over the whole
  // sheet is the whole sheet. The depth is whatever fits the byte budget,
  // which is dozens of ordinary strokes rather than two.
  //
  // If the GPU cannot read float textures back, the old whole-texture GPU
  // slots are used instead, with their shallow depth.
  _statePairs() {
    return [this.flow, this.sat, ...this.susp, ...this.dep];
  }

  get undoDepth() {
    const bytes = this.simW * this.simH * 8 * 10;
    return Math.max(1, Math.min(4, Math.floor(80e6 / Math.max(bytes, 1))));
  }

  get undoCount() {
    const u = this._undo;
    if (!u) return 0;
    return u.cpu ? u.stack.length + (u.pending ? 1 : 0) : u.gpuStack.length;
  }

  get undoBytes() {
    return this._undo ? this._undo.bytes : 0;
  }

  clearUndo() {
    if (!this._undo) return;
    for (const slot of [...this._undo.gpuStack, ...this._undo.gpuPool]) {
      for (const t of slot) this.gl.deleteTexture(t);
    }
    this._undo = null;
  }

  _copyInto(src, dst) {
    this._bindOutputs([dst]);
    this._use('copy', [['uTex', src]]);
    this._draw();
  }

  _ensureUndo() {
    const u = this._undo;
    if (u && u.w === this.simW && u.h === this.simH && u.n === PIG_TEXTURES) return u;
    this.clearUndo();
    this._undo = {
      stack: [], pending: null, bytes: 0,
      budget: this.undoBudget || 110e6,
      cpu: this._cpuUndoOk !== false,
      gpuStack: [], gpuPool: [],
      w: this.simW, h: this.simH, n: PIG_TEXTURES,
    };
    return this._undo;
  }

  pushUndo() {
    const u = this._ensureUndo();
    this._finalize();
    if (!u.cpu) return this._pushUndoGpu();
    const pairs = this._statePairs();
    if (!this._pre || this._pre.length !== pairs.length) {
      if (this._pre) for (const t of this._pre) this.gl.deleteTexture(t);
      try {
        this._pre = pairs.map(() => this._makeTexture(this.simW, this.simH));
      } catch (e) {
        this._pre = null;
        u.cpu = false;
        return this._pushUndoGpu();
      }
    }
    pairs.forEach((p, i) => this._copyInto(p.read, this._pre[i]));
    u.pending = { box: null, data: null, read: null };
    return true;
  }

  _touch(box) {
    const u = this._undo;
    if (!u || !u.pending || box.w <= 0 || box.h <= 0) return;
    u.pending.box = this._unionBox(u.pending.box, box);
  }

  _unionBox(a, b) {
    if (!a) return { ...b };
    if (!b) return { ...a };
    const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
    const x1 = Math.max(a.x + a.w, b.x + b.w), y1 = Math.max(a.y + a.h, b.y + b.h);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  _growBox(box, m) {
    if (!box) return null;
    const x0 = Math.max(0, box.x - m), y0 = Math.max(0, box.y - m);
    const x1 = Math.min(this.simW, box.x + box.w + m), y1 = Math.min(this.simH, box.y + box.h + m);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }

  _containsBox(outer, inner) {
    if (!inner) return true;
    if (!outer) return false;
    return inner.x >= outer.x && inner.y >= outer.y &&
      inner.x + inner.w <= outer.x + outer.w && inner.y + inner.h <= outer.y + outer.h;
  }

  // The stroke is over: read its region back now, generously, so the next
  // pen-down does not have to wait for the readback.
  commitUndo() {
    const u = this._undo;
    if (!u || !u.pending || !u.cpu) return;
    const wet = this._blockBox('probe', [['uFlow', this.flow.read], ['uSat', this.sat.read]]);
    const box = this._growBox(this._unionBox(u.pending.box, wet), 12);
    if (!box || box.w <= 0 || box.h <= 0) return;
    const data = this._readRegion(this._pre, box);
    if (!data) return;
    u.pending.data = data;
    u.pending.read = box;
  }

  // Close the pending record against what the sheet actually did.
  _finalize() {
    const u = this._undo;
    if (!u || !u.pending) return;
    const pend = u.pending;
    u.pending = null;
    if (!u.cpu) return;
    const diff = this._blockBox('diff', [
      ['uFlow', this.flow.read], ['uSat', this.sat.read],
      ...this.dep.map((p, i) => [`uDep${i}`, p.read]),
      ['uPreFlow', this._pre[0]], ['uPreSat', this._pre[1]],
      ...this.dep.map((p, i) => [`uPreDep${i}`, this._pre[2 + this.susp.length + i]]),
    ]);
    let box = this._growBox(this._unionBox(pend.box, diff), 2);
    if (!box || box.w <= 0 || box.h <= 0) return; // nothing changed: nothing to undo
    let data = pend.data;
    if (!data || !this._containsBox(pend.read, box)) {
      data = this._readRegion(this._pre, box);
      if (!data) return;
    } else {
      box = pend.read;
    }
    const bytes = data.reduce((s, a) => s + a.byteLength, 0);
    u.stack.push({ box, data, bytes });
    u.bytes += bytes;
    while (u.bytes > u.budget && u.stack.length > 1) {
      u.bytes -= u.stack.shift().bytes;
    }
  }

  undo() {
    this.markDirty();
    const u = this._undo;
    if (!u) return false;
    this._finalize();
    if (!u.cpu) return this._undoGpu();
    const rec = u.stack.pop();
    if (!rec) return false;
    u.bytes -= rec.bytes;
    const gl = this.gl;
    const pairs = this._statePairs();
    const { box } = rec;
    pairs.forEach((p, i) => {
      gl.bindTexture(gl.TEXTURE_2D, p.read);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, box.x, box.y, box.w, box.h, gl.RGBA, this._readType, rec.data[i]);
    });
    // and the write halves, so the pair agrees with itself
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(box.x, box.y, box.w, box.h);
    for (const p of pairs) this._copyInto(p.read, p.write);
    gl.disable(gl.SCISSOR_TEST);
    // "pre" no longer describes the sheet; the next pushUndo rewrites it
    return true;
  }

  // Read a texel rectangle of each texture to the CPU. Returns null (and
  // disables CPU undo) if the GPU will not read floats back.
  _readRegion(texs, box) {
    const gl = this.gl;
    if (!this._readFbo) this._readFbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this._readFbo);
    const out = [];
    try {
      for (const t of texs) {
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
        if (!this._readType) {
          // HALF_FLOAT halves the memory and skips a conversion; take it
          // when the implementation offers it, else FLOAT, which it must
          const ty = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE);
          this._readType = ty === gl.HALF_FLOAT ? gl.HALF_FLOAT : gl.FLOAT;
        }
        if (this.texFormat === gl.RGBA32F) this._readType = gl.FLOAT; // the only type a 32F texture takes back
        const n = box.w * box.h * 4;
        const buf = this._readType === gl.HALF_FLOAT ? new Uint16Array(n) : new Float32Array(n);
        gl.readPixels(box.x, box.y, box.w, box.h, gl.RGBA, this._readType, buf);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('readPixels failed');
        out.push(buf);
      }
    } catch (e) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this._cpuUndoOk = false;
      if (this._undo) this._undo.cpu = false;
      return null;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return out;
  }

  // Run a block-reduction shader over the grid at 64x64 and return the texel
  // bounding box of the blocks it lit, or null if none did.
  _blockBox(prog, inputs) {
    const gl = this.gl;
    const N = 64;
    if (!this._diffTex) {
      this._diffTex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this._diffTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, N, N);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this._diffBuf = new Uint8Array(N * N * 4);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this._diffTex, 0);
    for (let i = 1; i < PIG_TEXTURES + 1; i++) {
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, null, 0);
    }
    gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
    gl.viewport(0, 0, N, N);
    const p = this._use(prog, inputs);
    gl.uniform2f(p.uniforms.uBlock, 1 / N, 1 / N);
    this._draw();
    let x0 = N, y0 = N, x1 = -1, y1 = -1;
    try {
      gl.readPixels(0, 0, N, N, gl.RGBA, gl.UNSIGNED_BYTE, this._diffBuf);
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          if (this._diffBuf[(j * N + i) * 4] > 2) {
            if (i < x0) x0 = i; if (i > x1) x1 = i;
            if (j < y0) y0 = j; if (j > y1) y1 = j;
          }
        }
      }
    } catch (e) {
      x0 = 0; y0 = 0; x1 = N - 1; y1 = N - 1; // cannot tell: assume everything
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (x1 < 0) return null;
    // a block's worth of margin on every side: the reduction samples the
    // block sparsely and a change can sit between its samples
    const bw = this.simW / N, bh = this.simH / N;
    return this._growBox({
      x: Math.floor(x0 * bw), y: Math.floor(y0 * bh),
      w: Math.ceil((x1 + 1) * bw) - Math.floor(x0 * bw), h: Math.ceil((y1 + 1) * bh) - Math.floor(y0 * bh),
    }, Math.ceil(Math.max(bw, bh)));
  }

  // ---- the whole-texture GPU fallback ----
  _pushUndoGpu() {
    const u = this._undo;
    const pairs = this._statePairs();
    let slot = u.gpuPool.pop();
    if (!slot) {
      if (u.gpuStack.length >= this.undoDepth) slot = u.gpuStack.shift();
      else {
        try {
          slot = pairs.map(() => this._makeTexture(this.simW, this.simH));
        } catch (e) {
          if (!u.gpuStack.length) return false;
          slot = u.gpuStack.shift();
        }
      }
    }
    pairs.forEach((p, i) => this._copyInto(p.read, slot[i]));
    u.gpuStack.push(slot);
    u.pending = { box: null, data: null, read: null, gpu: true };
    return true;
  }

  _undoGpu() {
    const u = this._undo;
    const slot = u.gpuStack.pop();
    if (!slot) return false;
    this._statePairs().forEach((p, i) => {
      this._copyInto(slot[i], p.write);
      p.swap();
    });
    u.gpuPool.push(slot);
    return true;
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
    this.markDirty();
    this._touch({ x: 0, y: 0, w: this.simW, h: this.simH });
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
    const cssW = this.sheetW;
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

  // Clean water landing on a wash that has lost its shine is what makes a
  // bloom, and a backrun is not just water pushing pigment about: the water
  // RE-DISSOLVES paint that has only just set and carries it out to its own
  // rim, where it strands as the cauliflower edge. Lifting is gated on free
  // surface water, so raising it globally for a while only acts where the
  // water actually is. This used to belong to a dedicated water-drop tool;
  // it belongs to any clean wet brush, which is the same thing.
  rewet(frames = 300) {
    this._rewet = Math.max(this._rewet || 0, frames);
  }

  // --------------------------------------------------------------- brush --
  // pig: Float32Array(16) of pigment amounts; water in [0..~0.1]
  // Coordinates are SHEET css px (see resize). `shape`, optional, is the
  // footprint of a tilted pen: { angle, elong } stretches the dab `elong`
  // times along `angle` (radians, screen sense, y down). The caller has
  // already divided the amplitudes by `elong` so the mass laid is unchanged.
  //
  // A dab touches a few hundred texels, so the pass is scissored to its
  // footprint rather than drawn over the whole grid: a fine brush spaces its
  // dabs two pixels apart and a quick line used to fire hundreds of
  // full-grid passes a second, which is where the lag and the heat on small
  // brushes came from. The ping-pong is replaced by a write-then-copy-back
  // of the same region, so neither texture of a pair goes stale.
  splat(xCss, yCss, radiusCss, water, pig, wetness, scrub = 0, shape = null) {
    this.markDirty();
    const gl = this.gl;
    const sw = this.sheetW, sh = this.sheetH;
    const u = xCss / sw;
    const v = 1 - yCss / sh;
    const aspect = sw / sh;
    const elong = shape && shape.elong > 1 ? Math.min(shape.elong, 4) : 1;
    const ang = shape ? -(shape.angle || 0) : 0; // y flips between screen and uv

    const box = this._footprint(u, v, (radiusCss * elong) / sw, (radiusCss * elong) / sh);
    this._touch(box);
    const targets = [this.flow, ...this.susp];
    this._bindOutputs(targets.map((p) => p.write));
    const p = this._use('splat', [
      ['uFlow', this.flow.read],
      ...this._suspInputs(),
      ['uPaper', this.paperTex],
    ]);
    gl.uniform2f(p.uniforms.uCenter, u, v);
    gl.uniform1f(p.uniforms.uRadius, radiusCss / sw);
    gl.uniform2f(p.uniforms.uAspect, 1.0, 1.0 / aspect);
    gl.uniform2f(p.uniforms.uAxis, Math.cos(ang), Math.sin(ang));
    gl.uniform1f(p.uniforms.uElong, elong);
    gl.uniform1f(p.uniforms.uWaterAmt, water);
    for (let i = 0; i < PIG_TEXTURES; i++) {
      gl.uniform4f(p.uniforms[`uPig${i}`], pig[i * 4], pig[i * 4 + 1], pig[i * 4 + 2], pig[i * 4 + 3]);
    }
    gl.uniform1f(p.uniforms.uWetness, wetness);
    gl.uniform1f(p.uniforms.uPush, Math.min(0.6, water * 8.0));
    gl.uniform1f(p.uniforms.uScrub, scrub);
    this._drawRegion(box);
    this._copyBackRegion(targets, box);
  }

  // The texel rectangle a circle of uv radius (ru, rv) at (u, v) covers,
  // with a margin for the soft edge: {x, y, w, h} in sim texels.
  _footprint(u, v, ru, rv) {
    const m = 2;
    const x0 = Math.max(0, Math.floor((u - ru) * this.simW) - m);
    const y0 = Math.max(0, Math.floor((v - rv) * this.simH) - m);
    const x1 = Math.min(this.simW, Math.ceil((u + ru) * this.simW) + m);
    const y1 = Math.min(this.simH, Math.ceil((v + rv) * this.simH) + m);
    return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
  }

  _drawRegion(box) {
    const gl = this.gl;
    if (box.w <= 0 || box.h <= 0) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(box.x, box.y, box.w, box.h);
    this._draw();
    gl.disable(gl.SCISSOR_TEST);
  }

  // After a scissored pass into each pair's write texture, bring the same
  // region back into the read texture — the pair is then identical again and
  // nothing has to swap.
  _copyBackRegion(pairs, box) {
    const gl = this.gl;
    if (box.w <= 0 || box.h <= 0) return;
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(box.x, box.y, box.w, box.h);
    for (const pr of pairs) {
      this._bindOutputs([pr.read]);
      this._use('copy', [['uTex', pr.write]]);
      this._draw();
    }
    gl.disable(gl.SCISSOR_TEST);
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

      // 2. transport: water continuity and the pigment riding it
      this._bindOutputs([this.flow.write, ...this.susp.map((pr) => pr.write)]);
      p = this._use('height', [['uFlow', this.flow.read], ['uSat', this.sat.read], ...this._suspInputs()]);
      gl.uniform1f(p.uniforms.uSmooth, P.smooth);
      gl.uniform1f(p.uniforms.uPigDiff, P.pigDiff);
      gl.uniform1f(p.uniforms.uSaltPush, P.saltPush);
      gl.uniform2f(p.uniforms.uPin, P.pinLo, P.pinHi);
      this._draw();
      this.flow.swap();
      this.susp.forEach((pr) => pr.swap());

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
      gl.uniform1f(p.uniforms.uRunAbsorb, P.runAbsorb);
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
    const v = this.view || { zoom: 1, cx: this.sheetW / 2, cy: this.sheetH / 2 };
    gl.uniform4f(p.uniforms.uView,
      this.cssW / (v.zoom * this.sheetW), this.cssH / (v.zoom * this.sheetH),
      v.cx / this.sheetW, 1 - v.cy / this.sheetH);
    this._draw();
    this.renderDirty = false;
  }

  // Sprinkle salt into the wash: grains soak water and shove pigment into
  // starbursts while the paper is in the damp band.
  sprinkleSalt(xCss, yCss, radiusCss) {
    this.markDirty();
    const gl = this.gl;
    const sw = this.sheetW, sh = this.sheetH;
    const u = xCss / sw, v = 1 - yCss / sh;
    const box = this._footprint(u, v, radiusCss / sw, radiusCss / sh);
    this._touch(box);
    this._bindOutputs([this.sat.write]);
    const p = this._use('salt', [['uSat', this.sat.read]]);
    gl.uniform2f(p.uniforms.uCenter, u, v);
    gl.uniform1f(p.uniforms.uRadius, radiusCss / sw);
    gl.uniform2f(p.uniforms.uAspect, 1.0, sh / sw);
    gl.uniform1f(p.uniforms.uSeed, Math.random() * 100);
    gl.uniform1f(p.uniforms.uDensity, this.params.saltDensity);
    gl.uniform1f(p.uniforms.uSpacing, this.params.saltSpacing);
    gl.uniform1f(p.uniforms.uGrainSize, this.params.saltGrain);
    this._drawRegion(box);
    this._copyBackRegion([this.sat], box);
  }

  // Average pigment mixture + water under a brush footprint (css px), used
  // by the mixing tray so the brush picks up what it touches. Reads one
  // pixel per pigment texture at the sim cell under the center.
  readMix(xCss, yCss) {
    const gl = this.gl;
    const cssW = this.sheetW;
    const cssH = this.sheetH;
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
