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
2. **Pigment layers** — 12 real pigments tracked individually, each as
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
  the Gibbs isotherm). This is what makes wet-on-wet blooms travel. It is
  gated on film depth, and that gate has to open where the water a brush
  actually leaves lives: at one point it opened at h=0.02 while a dab lays
  down 0.01–0.05, so for ordinary painting the term was switched off and
  colour dropped into a wet wash barely moved.
- **Imbibition at the advancing front** — dry paper drinks fastest where it
  is first wetted, and slows as it fills (Washburn). Without that, moving
  water only ever lost volume to evaporation, so a tilted run slid on as if
  the paper were glass instead of dying out as the sheet drank it.
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

**Nothing couples the two.** Two sliders, one per axis:

- **🎨 Paint** — how much of the mix is on the hairs.
- **💧 Water** — how much water is on the hairs.

Every water control — the slider, the glass, the sponge — leaves the paint
exactly as it was, and the Paint slider leaves the water alone while keeping
the recipe's proportions. Earlier versions modelled the real couplings (a
wet brush dissolves more out of a pan, a water dip washes pigment off the
hairs) and they were true to life, but they made the two knobs fight each
other. There was also a third slider for dilution, the ratio of the other
two; a control whose value is decided by the other controls is a knob that
moves on its own, and it is gone. The consistency is still named
(tea / coffee / milk / cream / butter) as a readout.

The water glass and sponge still take a **swirl**: press and work the brush
around and it keeps taking up (or blotting off) more the longer you go.

By default the brush **runs out as you paint** — water and pigment leave the
hairs, so a long stroke fades into a dry-brush tail. That can be switched off
in Settings, and then the hairs hold their load: every line comes out the
same however many you draw. It is the opposite of how a real brush behaves,
which is exactly why it is a choice rather than the default.

## The workbench

The UI mirrors a physical setup: a **paint box of 12 pans**, a **water
glass** and a **sponge**. The brush is stateful — it carries water and a
12-pigment load:

- **Dip a pan** to pick up paint (a wet brush dissolves the pan and picks up
  far more than a dry one, which only scuffs colour off it).
- **Mix by parts.** A pan is a dial for its own share of the recipe:
  **tap** adds a part, **drag up or down** sets it live, **long press**
  takes it out. Yellow to 7, black to 1, blue to 2 and the brush carries
  7:1:2. Dragging matters more than tapping —
  a proportion is something you feel your way to, and tapping seven times
  to correct one part is not that. The Paint slider then says *how much*
  of that mixture is on the hairs, so ratio and quantity stay separate.

  Nothing sits beside the pans reporting the mix — not a readout, not a
  preview swatch. The pans carry their own part counts and the status line
  names the recipe as it changes, so a panel restating it was one more thing
  in the bar earning nothing. The row is the pans, and they get all of it. Every component keeps its own physics on the paper, so a mix
  containing ultramarine still granulates and one containing quinacridone
  still stains.

  This replaced a simulated ceramic mixing plate. The plate was a second
  full instance of the watercolor simulation running every frame: 18% of all
  the work done on an iPhone, and the reason the sheet could only afford 12
  pigment channels once it was gone. Diluting a mix is now the Water and
  Dilution sliders rather than a puddle.
- **🌀 Rinse** empties the brush and clears the recipe — which is what
  rinsing a brush means.
- **💧 Water glass**: adds water to the brush and washes a little pigment off.
  Hold and swirl for more of both.
- **🧽 Sponge**: blots water off the brush while keeping most of the pigment
  — the "thirsty brush" for dry-brush work and lifting.
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

## Layout

The bar is built to stay out of the way — on an iPhone it takes about a
fifth of the screen, on a landscape iPad about an eighth, and nothing wraps
to a second line at any size. Safe areas are respected: the full-screen panels start below the notch (the
paint box's first row was hidden under the status bar), and the bar ends
flush with the screen with just the home-indicator clearance below the last
row. An installed PWA may be *letterboxed* — its web view stops short of the
screen and iOS fills the strip below with the manifest background colour. In
that case the OS has already moved the content clear of the home indicator,
so padding by the inset as well stacks a second gap on the first; the app
measures whether the view actually reaches the screen edge and only pays the
inset when it does. The root background is painted in the bar's colour so that, on an
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

## Performance

The **Detail** setting is named for battery rather than for quality, because
that is the choice being made: most detail is heaviest on the battery, least
is lightest.

Two things cost power, and both are measured rather than guessed. On an iPad
in landscape the simulation runs **729,000 cells** and the final image
**3.9 million pixels**, every frame — about 294 million texture reads per
frame in the old build. Three changes:

- **Quality** (High / Balanced / Battery) sets the simulation grid and the
  drawn resolution: 237M / 133M / 70M reads per frame. Balanced is the
  default and roughly halves the work for a slightly softer paper grain.
- **12 channels instead of 16** takes a quarter off every simulation step.
- **Nothing is simulated when nothing is wet.** A dry, untouched sheet used
  to run the whole pipeline forever — most of a session is spent looking
  rather than painting. A 16×16 probe asks the GPU "is anything still wet?"
  a few times a second and reads back 1KB; on a dry sheet the app now
  simulates **0 frames out of 100**, and on a wet one 92 of 100.

## Settings (⚙)

- **Detail** — most / medium / least, named for what they cost: battery and
  heat run highest to lowest in that order. Medium does about half the work
  of Most and Least about a third. Only the fineness of the simulation and
  the drawn resolution change; the painting behaves identically.
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

The working palette is **1 to 12 pans** chosen from the full paint box, and
a pan *is* a simulation channel — slot i always paints with channel i.
Swapping a pan therefore recolours any earlier strokes made with the paint
that left.

**The size of the palette is the main thing you can spend or save**, and it
comes in blocks of four, because one RGBA texture carries four channels:

| colours | pigment texture pairs |
|---|---|
| 1–4 | 1 |
| 5–8 | 2 |
| 9–12 | 3 |

So a three-colour painting runs a third of the pigment work of a twelve, and
a fourth colour on top of three is free. **New painting…** (in ⚙) clears the
sheet and opens the palette with the count unlocked; the panel says which
block you are in and when the next colour will cost a layer.

**Adding a colour works at any time, mid-painting.** Crossing a block
boundary allocates another texture pair and recompiles the pigment shaders,
which are generated for a fixed pair count — the existing textures are kept
as they are and empty ones appended, so nothing already painted is
disturbed. Verified: deposited pigment identical before and after going
from four colours to five. *Removing* a colour shifts every later pan down a
slot, and a pan is a channel, so it would recolour strokes; it is offered
only on a blank sheet.
An earlier build carried 16 channels so a swap could take a spare one and
leave old strokes alone; that cost a quarter of every simulation step to
protect a case the artist does not care about. Each paint is
shown in the paint box as a **ramp from mass tone to a thin wash** rather
than a single chip — at full strength Prussian, Phthalo and Ultramarine are
three near-identical blacks, and a paint only shows what it is once it is
let down. The dilute steps are divided by tinting strength so every paint
spends its ramp across the range where it actually changes. Each paint is
defined by mass tone + undertone colors (inverted to Kubelka-Munk K/S),
tinting strength, density, staining, granulation strength, and granulation
grain size (fine speckle vs coarse flocs).

## Version

The top of Settings shows the build that is actually running — commit and
timestamp — and **Check for update** re-fetches that stamp from the server
with caching bypassed and compares. If the server is newer it drops the
service worker's caches, saves the session and reloads onto the new build.
That answers a question a service worker and an installed PWA can otherwise
hide: not "did the deploy finish" but "did the deploy reach this device".

The build id is a hash of the app's own source, written by `tools/stamp.sh`
and committed; CI fails the deploy if it is stale. It is a hash rather than
a commit SHA injected at deploy time for a reason: this site is published by
**two** deployers that both fire on a push — the workflow in
`.github/workflows`, and GitHub's own built-in branch builder — and
whichever finishes last wins. A stamp written by one of them is a coin toss,
and the built-in builder publishes the branch verbatim. Committing it makes
both deployers publish the same thing. A hash also answers the real question
better than a SHA: it changes exactly when the served files change.

Every exported session log carries the build too, so a report always says
which one produced it.

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
- **Tilt**: toggle Tilt and physically tilt the device. iOS requires motion
  access, and there are three ways it can silently not happen — denied now,
  denied on a previous visit (iOS then never asks again), or granted but
  withholding readings, which is common in an installed web app. All three
  used to fail without a word; each now says which one it was and what to do
  about it, and the button does not light up unless readings are actually
  arriving. — thick wet paint
  runs downhill and fingers along paper fibres (damp washes hold). The
  angle you are holding the device at when you switch it on is taken as
  level, so you can work at whatever angle is comfortable rather than flat
  on a table, and the reading is rotated into screen space so it points
  downhill on an iPad held sideways too. **Tilt strength** in Settings sets
  how steeply it runs.
- **Dry**: hold to flash-dry the sheet, then glaze over — dried washes
  resist re-blending except through deliberate rewetting.
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
