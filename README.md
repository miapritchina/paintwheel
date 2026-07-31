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
2. **Pigment layers** — 16 real pigments tracked individually, each as
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

The 16-color palette reproduces the artist's real paint wheel, pigment by
pigment (Colour Index codes in parentheses): Cadmium Lemon (PY35), Irgazin
Yellow (PY129), Raw Siena and Italian Burnt Siena (PBr7), Titian Red (PO36),
Pyrrole Scarlet (PR255), Carmine (PR176), Quinacridone Pink (PR122), Potters
Pink (PR233 — maximally granulating, non-staining), Dioxazine Purple (PV23),
Ultramarine (PB29), Cobalt Blue (PB28), Prussian Blue (PB27), Cobalt
Turquoise (PB36), Emerald Green (PG7-based) and Green (PG8). K/S optics are
inverted from each paint's mass tone and undertone; density, staining and
granulation follow the real pigment's chemistry.

The paper itself is procedural: a cold-press style height field that steers
flow, granulation, absorbency, and dry-brush texture.

Beyond the papers, the model borrows two effects:

- **Marangoni flow** — paint lowers the water's surface tension, so a loaded
  drop pulls itself outward through a wet wash (log-concentration form per
  the Gibbs isotherm). This is what makes wet-on-wet blooms travel.
- **Pinned contact line** — a wash boundary stays put while rim evaporation
  draws interior fluid (and pigment) outward: the coffee-ring effect that
  dries into dark edge lines.

## Brush & workflow (inspired by Adobe Fresco / Art Set 4)

- **Depleting reservoirs**: the brush carries finite water and pigment;
  strokes fade and end in dry-brush tails. Dip again by lifting the stylus.
- **Mixing well** (dashed swatch): tap it, then tap pigments to add parts —
  the well shows the Kubelka-Munk color of the mixture; tap the well again to
  paint with it (double-tap empties it). A mix is carried as real proportions
  of its component pigments, so each keeps its physical behavior: an
  ultramarine + quinacridone violet still granulates (the ultramarine part)
  AND stains (the quinacridone part), and the components separate in a wet
  wash just like real paint.
- **Plain-water brush** (droplet swatch): pre-wet the sheet for wet-on-wet,
  dilute a wash, trigger backruns on a drying wash, or scrub/lift dried
  paint — non-staining pigments (cerulean) lift, staining ones
  (quinacridone, phthalo) leave a permanent tint, per their measured
  staining power.
- **Tilt**: on iPhone/iPad, toggle Tilt and physically tilt the device —
  thick wet paint runs downhill and fingers along paper fibers
  (damp washes hold).
- **Dry fast**: hold to flash-dry, then glaze over — dried washes resist
  re-blending except through deliberate rewetting.
- **Save** exports a PNG.

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

- Curtis et al., *Computer-Generated Watercolor*, SIGGRAPH 1997 — three-layer
  model, pigment equations, and the measured pigment K/S table used here
- Chu & Tai, *MoXi: Real-Time Ink Dispersion in Absorbent Paper*, SIGGRAPH
  2005 — boundary evaporation / edge darkening (the engine behind Expresii)
- Van Laerhoven & Van Reeth, *Real-Time Watercolor Painting on a Distributed
  Paper Model*, CGI 2004
- Stuyck et al., *Real-Time Oil Painting on Mobile Hardware*, CGF 2017 —
  proof that this class of sim runs at interactive rates on iPad GPUs
- Adobe Research on Fresco's tile-based "Iris" live-brush engine
  (research.adobe.com, "Fresco: The Future of Painting...")
- DiVerdi et al., *Painting with Polygons*, TVCG 2013 — composite-time edge
  darkening trick adopted in the render pass
- Corel patent US 9,240,063 — three-layer canvas & rewetting model that
  informed the dried-paint resolubility behavior
