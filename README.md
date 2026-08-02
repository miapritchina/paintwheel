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

The paint box reproduces the artist's real paint wheel, pigment by
pigment (Colour Index codes in parentheses): Cadmium Lemon (PY35), Irgazin
Yellow (PY129), Raw Siena and Italian Burnt Siena (PBr7), Titian Red (PO36),
Pyrrole Scarlet (PR255), Carmine (PR176), Quinacridone Pink (PR122), Potters
Pink (PR233 — maximally granulating, non-staining), Dioxazine Purple (PV23),
Ultramarine (PB29), Cobalt Blue (PB28), Prussian Blue (PB27), Cobalt
Turquoise (PB36), Emerald Green (PG7-based), Green (PG8) and a Granulating
Black (PBk11 — coarse magnetite, the most violently granulating pigment
there is: heavy, non-staining, settles as black flecks into every pit of
the tooth). K/S optics are
inverted from each paint's mass tone and undertone; density, staining and
granulation follow the real pigment's chemistry.

**Metallics** (Gold, Silver) are mica in gum — gouache, not watercolor — so
they are deliberately kept *out* of the Kubelka-Munk mixture: they do not
absorb transparently, they cover. They are accumulated separately and laid
over the finished watercolor as an opaque layer whose sheen is a field of
individual flake glints rather than a smooth highlight, because that is what
mica does. Heavy, fast-settling and staying put, which is why they work for
linework over a dry wash.

The paper itself is procedural: a cold-press style height field that steers
flow, granulation, absorbency, and dry-brush texture.

Beyond the papers, the model borrows two effects:

- **Marangoni flow** — paint lowers the water's surface tension, so a loaded
  drop pulls itself outward through a wet wash (log-concentration form per
  the Gibbs isotherm). This is what makes wet-on-wet blooms travel.
- **Pinned contact line** — a wash boundary stays put while rim evaporation
  draws interior fluid (and pigment) outward: the coffee-ring effect that
  dries into dark edge lines.

## The brush: two independent axes

Water and paint are separate quantities on the hairs, and they do separate
jobs — this is the core of the tool's feel:

- **How much water** the brush carries decides *how wet the paper gets*
  (spread, blooming, softness). Nothing else adds water: a bone-dry brush
  loaded with paint wets the paper not at all.
- **How much pigment** the brush carries decides *how strong the colour is*.

So all four combinations are reachable, as in life: potent-and-wet (juicy
dark wash), potent-and-dry (drybrush), pale-and-wet (pale wash),
pale-and-dry (faint scumble). Water leaves the brush faster than pigment,
so a long stroke dries out and concentrates into a natural drybrush tail.

Three sliders sit on the brush itself, and they are the same two axes plus
their ratio:

- **🎨 Paint** — how much colour is on the hairs.
- **💧 Water** — how much water is on the hairs.
- **◍ Dilution** — their ratio, labelled on Zbukvic's consistency scale
  (tea / coffee / milk / cream / butter). Dragging it thins or thickens the
  paint *at constant water*, so you can change the colour's value without
  changing how wet the paper will get.

They double as the level meters: however you load the brush — dipping,
swirling, painting a long stroke — they show where it stands.

Loading is a **swirl, not a tap**: press on a pan (or the water, or the
sponge) and work the brush around, and it keeps taking up more the longer
you go. A single tap still gives one dose.

By default the brush **runs out as you paint** — water and pigment leave the
hairs, so a long stroke fades into a dry-brush tail. That can be switched off
in Settings, and then the hairs hold their load: every line comes out the
same however many you draw. It is the opposite of how a real brush behaves,
which is exactly why it is a choice rather than the default.

## The workbench

The UI mirrors a physical setup: a **palette of pans** along the bottom, a
**ceramic mixing tray**, a **water glass** and a **sponge**. The brush is
stateful — it carries water and a 16-pigment load:

- **Dip a pan** to pick up paint (a wet brush dissolves the pan and picks up
  far more than a dry one, which only scuffs colour off it).
- **Mix on the plate**: the plate is a second instance of the full watercolor
  simulation running on non-absorbent ceramic, moulded into eight **dished
  wells with raised rims**. The rims matter: on a flat plate, water added to
  thin a mix simply ran away across the surface while the pigment stayed
  put, so the mix got *stronger* the more water you added. A well holds the
  water in with the paint.

  What the brush lifts off the plate is fluid, and what counts about that
  fluid is its **concentration** — pigment per unit water — so adding clean
  water genuinely thins what you pick up next. Leftover paint dries in the
  well and re-wets later. **✕** rinses the segment.
- **💧 Water glass**: adds water to the brush and washes a little pigment off.
  Hold and swirl for more of both.
- **🌀 Rinse**: the brush comes out with no colour *and* no water.
- **🧽 Sponge**: blots water off the brush while keeping most of the pigment
  — the "thirsty brush" for dry-brush work and lifting.
- Nothing refills mid-stroke: long strokes shed pigment first, then water,
  and end in dry-brush texture.
- **Paper picker**: Rough (the default) / Cold press / Hot press / Toned
  cream — different tooth, absorbency and tint (switching gives a fresh
  sheet).
- **↶ Undo** steps back through the last strokes, drops, saltings and
  clears. The painting is the state of a fluid simulation rather than a list
  of shapes, so undo works by snapshotting that whole state — water,
  suspended pigment and deposits alike — before anything that marks the
  sheet. Undoing into a half-dry wash therefore brings back the wetness too,
  not just the colour. Snapshots are large, so the depth is whatever fits a
  memory budget: two or three on a phone, one on a big canvas.

## Timing tools

- **👁 Wetness view** — the digital "look for the shine": blue = wet
  (paint into it for soft blends), teal = satin (controlled soft edges),
  amber = damp (touching it blooms), untinted = dry (crisp edges, glazing).
- **🧂 Salt** — toggle, then tap or drag over the painting. Grains are a
  scatter of individual crystals of varying size, sparse and clumpy, sized
  from table salt to rock salt in Settings. Each one soaks water and shoves
  pigment into a starburst; like real salt it only textures a wash caught in
  the damp band — too wet and it dissolves, too dry and nothing happens.
- **💦 Water drop** — toggle, then tap. Drops clean water into a wash. On a
  wash that has just lost its shine this is the classic bloom-maker: the
  drop pushes outward through the damp paint and strands it in a
  cauliflower ring.
- **🌬 Hair dryer** — toggle, then hold on the paper. Dries *only where you
  point it*, so you can freeze a bloom at the moment you like it, or set one
  passage while the next stays open. Drag and the airflow blows the wet film
  along with the nozzle — how you turn a drip into a streak or push a wash
  into a corner. It drives water out of the sheet as well as off the
  surface, so it genuinely sets the paper rather than skinning it.

## Layout

The bar is built to stay out of the way — on an iPhone it takes about a
fifth of the screen, on a landscape iPad about an eighth, and nothing wraps
to a second line at any size. Safe areas are respected: the full-screen panels start below the notch (the
paint box's first row was hidden under the status bar), and the bar ends
flush with the screen with just the home-indicator clearance below the last
row. The root background is painted in the bar's colour so that, on an
installed PWA whose web view is letterboxed short of the screen, the strip
reads as part of the bar instead of a black void. The insets are held in
`--safe-top` / `--safe-bottom` so both layouts can be checked on a desktop
browser, where `env()` is always zero.

The pans sit **beside the mixing plate** — in life they are one paint box,
and dip-then-mix is a constant back-and-forth — as two rows of four, which
also keeps them a comfortable size. Then the brush row, then Size / Paper /
Paint box / ⚙, then the tools. The status line hangs on a tab
above the bar so it costs no height, and a pan's tap target is its whole
cell including the name label, so the pans can stay short without becoming
hard to hit. Occasional actions (Clear, Tilt, Demo, Save, Log, Reset) live
in ⚙ rather than taking two rows of the bar.

## Settings (⚙)

- **Drying speed** — 0.25×–4×: minutes of open wet-in-wet time, or set in
  seconds.
- **Paint per dip** / **Water per dip** — how much one tap gives, on top of
  swirling and the brush sliders.
- **Salt grain size** — fine table salt through coarse rock salt (bigger
  crystals scatter more sparsely and open larger starbursts).
- **Paint and water run off** — off keeps the sheet wetting, drying,
  granulating and taking backruns, but nothing travels: colour stays exactly
  where you put it, for controlled detail work.
- **Brush runs out as you paint** — off keeps the brush's load constant, so
  repeated lines come out identical.
- **Pencil pressure → brush size** — Apple Pencil force drives stroke width
  (a light touch goes genuinely fine, a hard press spreads the whole belly
  of the brush). Off: the Size slider alone decides.

## Paint box & channels

The working palette is 8 pans chosen from the full paint box. Swapping a
pan's paint binds a fresh simulation channel, so strokes already on paper
keep the old paint's color and physics (16 channels total; heavy swapping
in one sheet eventually recycles the oldest unused channel). Each paint is
defined by mass tone + undertone colors (inverted to Kubelka-Munk K/S),
tinting strength, density, staining, granulation strength, and granulation
grain size (fine speckle vs coarse flocs).

## Session logs (for feedback & bug reports)

The **Log** button exports the whole session as JSON: every pan dip, water
dip, sponge wipe, tray smear, paper change, and every brush dab with its
exact pigment load and frame timestamp. A log fully reproduces a painting:
paste it into the console as `REPLAY.load(sessionJson)` and the app replays
it stroke for stroke. Sharing a log + a screenshot of the result is the best
way to report "this didn't behave like real watercolor".

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

## PWA & persistence

The app is installable (Add to Home Screen on iPad/iPhone) and works
offline after the first load. State survives reloads: the painting's
deposited pigment, the tray's mixes, pan/channel bindings, brush load,
paper choice and the session log are snapshotted to IndexedDB every 20 s
and on page hide. Anything still wet "dries" across a reload — like
leaving a real sheet overnight. **Reset** clears the painting, tray,
palette and all saved state.

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
