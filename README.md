# Paintwheel — Wet Watercolor Simulation

A physically-based, real-time wet watercolor simulator that runs in the browser
(WebGL2, works on iPhone/iPad Safari). Open `index.html` from any static
server and paint with mouse, finger, or Apple Pencil (pressure supported).

Supports **wet-on-wet** (blooms, feathering, backruns) and **wet-on-dry**
(crisp edges, edge darkening, dry-brush texture).

## The physics

The model follows Curtis, Anderson, Seims, Fleischer & Salesin,
*Computer-Generated Watercolor* (SIGGRAPH 1997), with boundary-evaporation
ideas from Chu & Tai, *MoXi: Real-Time Ink Dispersion in Absorbent Paper*
(SIGGRAPH 2005), implemented as WebGL2 fragment-shader passes over ping-ponged
RGBA16F textures:

1. **Shallow-water layer** — water depth + velocity driven by the water
   surface slope and paper relief, with viscous drag and outward drift at the
   wash boundary (the "coffee ring" effect that makes edges dry darker).
2. **Pigment layers** — 8 real pigments tracked individually, each as
   *suspended* (moving with the water) and *deposited* (settled on the sheet)
   concentration. Deposition/lifting uses Curtis' equations with each
   pigment's measured **density**, **staining power** and **granulation**.
3. **Capillary layer** — water absorbed into the sheet wicks between fibers;
   when it seeps back into a drying wash it re-wets it and produces
   **backruns** ("cauliflowers").
4. **Kubelka-Munk rendering** — colors are not RGB-blended: every pixel
   composites the pigment mixture optically over textured paper using the
   measured K (absorption) / S (scattering) spectra from the Curtis paper.
   That's why ultramarine + hansa yellow makes green, glazes behave like
   glazes, and cadmiums cover while quinacridones stain transparently.

The paper itself is procedural: a cold-press style height field that steers
flow, granulation, absorbency, and dry-brush texture.

## Files

- `js/shaders.js` — all simulation passes (GLSL ES 3.00)
- `js/sim.js` — WebGL2 engine (ping-pong textures, MRT passes)
- `js/pigments.js` — measured pigment data (Curtis et al. 1997, Fig. 5)
- `js/main.js` — UI, pointer/stylus input
- `js/demo.js` — scripted showcase (blooms, strokes, granulation, backrun)

## Running

Any static file server works:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

## References

- Curtis et al., *Computer-Generated Watercolor*, SIGGRAPH 1997
- Chu & Tai, *MoXi: Real-Time Ink Dispersion in Absorbent Paper*, SIGGRAPH 2005
- Van Laerhoven & Van Reeth, *Real-Time Watercolor Painting on a Distributed
  Paper Model*, CGI 2004
- Stuyck et al., *Real-Time Oil Painting on Mobile Hardware*, CGF 2017
