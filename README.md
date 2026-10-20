# Paintwheel — Wet Watercolor Simulation

A physically-based, real-time wet watercolor simulator that runs in the browser
(WebGL2, works on iPhone/iPad Safari). Open `index.html` from any static
server and paint with mouse, finger, or Apple Pencil (pressure and tilt
supported).

## Hands and pencil

The input contract is the one Procreate, Fresco and ArtSet share, because it
is what an iPad hand already knows:

- **The Pencil paints.** Pressure sets the width and how fast paint leaves
  the brush; tilt stretches the footprint along the barrel.
- **Fingers navigate.** Pinch to zoom, drag to pan, tap with two fingers to
  undo. Pinch the sheet smaller than the screen and it snaps back to fit;
  ⤢ in the bar does the same.
- **Until a Pencil has touched the sheet, one finger paints too**, and a
  second finger turns that touch into navigation — taking back the mark it
  had started if it had barely begun. *Finger paints* in Settings makes this
  always or never.
- **Lifting the pen dips the brush again.** Within a stroke the hairs run
  out and the line fades to dry-brush; between strokes the load comes back.

The paper is a **sheet** with its own size, decided when it is made, and the
screen is a view onto it. Turning the device, Split View, Safari showing its
toolbar: none of it touches the painting any more. It used to — the grid was
sized from the canvas, so a rotation reallocated every texture and wiped the
sheet. Brush size is a size on the paper, so zoomed in, the same Size paints
a finer line on screen.

Supports **wet-on-wet** (blooms, feathering, backruns) and **wet-on-dry**
(crisp edges, edge darkening, dry-brush texture).

## The physics

The model follows Curtis, Anderson, Seims, Fleischer & Salesin,
*Computer-Generated Watercolor* (SIGGRAPH 1997), with boundary-evaporation
ideas from Chu & Tai, *MoXi: Real-Time Ink Dispersion in Absorbent Paper*
(SIGGRAPH 2005), implemented as WebGL2 fragment-shader passes over ping-ponged
RGBA32F textures (RGBA16F where the GPU cannot render to full floats; the
finished picture is shaded at grid resolution into an RGBA8 frame and
magnified onto the screen from there):

1. **Shallow-water layer** — a film of water on the sheet. It levels under
   its own weight and surface tension, as an exchange between neighbouring
   cells; a velocity field carries the Marangoni flow, device tilt, the
   outward drift at a wash boundary (the "coffee ring" effect that makes
   edges dry darker) and a gentle drift into the paper's valleys.
2. **Pigment layers** — 12 real pigments tracked individually, each as
   *suspended* (moving with the water) and *deposited* (settled on the sheet)
   concentration. Suspended pigment rides exactly the water that moves: the
   same face fluxes, the same levelling exchange, at the concentration of
   the cell the water came from. Deposition/lifting uses Curtis' equations
   with each pigment's measured **density**, **staining power** and
   **granulation**.
3. **Capillary layer** — water absorbed into the sheet wicks between fibers;
   when it seeps back into a drying wash it re-wets it and produces
   **backruns** ("cauliflowers"). Wicking is deliberately *heterogeneous*:
   paper is not a uniform sponge, it is a mat of fiber bundles, and Darcy
   flow through it runs fast along a bundle and stalls between them. Each
   cell-to-cell exchange is weighted by the fiber noise of both cells (the
   pair average keeps the exchange symmetric, so heterogeneity cannot create
   or destroy water) — which is why a damp fringe creeps outward ragged and
   feathered rather than as a smooth blurred halo.
4. **Kubelka-Munk rendering** — colors are not RGB-blended: every pixel
   composites the pigment mixture optically over textured paper using the
   measured K (absorption) / S (scattering) spectra from the Curtis paper.
   That's why ultramarine + hansa yellow makes green, glazes behave like
   glazes, and cadmiums cover while quinacridones stain transparently.
   (No Saunderson surface-reflection correction on top, and deliberately:
   each paint's K/S is inverted from its *observed* mass tone and undertone
   colours, so the air/paint interface reflection is already baked into the
   calibration — adding the correction would count it twice.)

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
  dries into dark edge lines. Water crosses onto dry paper only from a film
  deeper than the sheet's capillary barrier (a dab of a wet brush leaves
  about 0.04; the barrier opens between 0.035 and 0.07), so an ordinary
  stroke keeps the edge its brush gave it and only a flooded passage
  creeps. Inside the wet mask flow is free.

- **Wet things are darker** — two distinct optical mechanisms, both in the
  render pass and neither of them a "darken by 11%" fudge (which is what
  they replaced). *Wet paper* darkens because water fills the pores and
  index-matches the cellulose fibers: light trapped by internal reflection
  in the film makes extra passes through the absorbing sheet, so the wet
  reflectance is a **power** of the dry one (Ångström's argument, quantified
  by Lekner & Dorf 1988) — which also deepens colour, since dark channels
  fall faster than light ones. *Wet pigment* is darker for the mirrored
  reason: water index-matches the pigment particles, so Kubelka-Munk
  scattering S collapses and the layer acts as a nearly pure absorber; as
  the wash dries, air returns between the grains, S recovers, and the colour
  lightens. That is "watercolor dries lighter" — the painter's constant
  complaint — falling out of the optics instead of being painted on.

### What the numbers had to say

The marks were checked against a sheet of real painter's marks
(`test/scenes.html`) and the physics against mass totals
(`test/variants.html`), and both found faults that no amount of tuning had
reached:

- **Pigment was being invented.** The semi-Lagrangian resample that moved
  suspended pigment is not conservative, and in the outward flow at a wash
  rim it stretched pigment into being: 60% more over one stroke's drying.
  Underneath that, the state textures were half floats, which resolve about
  one part in a thousand, and most of what happens to a wash in a substep
  is smaller: a slow settling takes 0.06% of the suspended pigment. In half
  floats "suspended minus that" rounds back to the same number while
  "deposit plus that" is representable, so every substep made pigment and
  settling itself stalled. Transport is now one conservative upwind pass
  for water and pigment together, and the state lives in full floats where
  the GPU can render to them (the half-float path remains as a fallback).
  Measured: a wash plus a stroke plus a bloom, dried, holds its pigment to
  the unit. Apple GPUs render to full floats but will not filter them, and
  for a while that alone sent every iPhone and iPad down the half-float
  path (which is what "it looks worse than before" on a phone was). The
  simulation never needed the filter — every pass reads at cell centres —
  only the picture did, so the picture is now shaded once per grid cell
  into an ordinary 8-bit texture and magnified from there. Settings → About
  says which engine a device got.
- **Salt made pigment.** The starburst was done by resampling the pigment
  field a few texels sideways, the one resample left in the engine, and a
  resample is not conservative: two cells could read the same source
  texel. It is now a pigment-only face flux down the salt gradient,
  upwind and symmetric like every other transport term. Measured: a
  sprinkle of salt on a wash changes the total pigment by under 0.1%.
- **A run left a stroke as a comb of single-pixel trickles** ("water seeps
  into the paper as thin lines"). Four things conspired. The tilt flow was
  sped up and slowed down cell by cell by the fibre noise, meant to break
  the front into fingers, but a flow that varies cell to cell is a field
  of sinks and sources, and the body of a run drained into threads along
  the noise. Water crossing the contact line went one cell at a time along
  whichever row the tilt pointed down, and the levelling that would have
  widened a thread was confined to the wet mask. The backrun rule opened
  cells one at a time wherever wicking along a fibre had dampened the
  sheet enough, so wet islands marched ahead of the front. And a cell the
  sheet drank dry in the middle of a run could never be re-wetted by a
  film of ordinary depth, so runs were peppered with pinholes. Now: the run
  moves as one film; a face into dry paper (for the velocity fluxes and
  the levelling alike) opens in proportion to how wet the destination's
  surroundings are — a 3×3 mean of the wet mask, carried in a spare
  channel of the moisture texture so both sides of a face agree and the
  flux stays conservative — so a broad front advances and the tip of a
  thread does not; the backrun opening takes the same gate; a pinhole with
  wet film all round it closes over; and the fingering comes from the
  contact line instead, which opens sooner where the sheet's coarse grain
  is open, so a bead breaks through in a few places and runs as tongues.
- **A stroke's water was gone in under five seconds.** The imbibition term
  meant for tilted runs fired on the brush's own push. The rates are now
  set so one stroke's water has a half-life of about 600 steps — ten
  seconds at 60 fps, twenty at the drying slider's default — and pigment
  stays mobile for most of it.
- **The film flow blew up on puddles.** Lubrication says a deeper film
  flows faster, but an explicit scheme can only carry a diffusion number
  under a quarter; a puddle of 0.9 drove the velocity to its cap, flipping
  sign every substep, until a cell gave more than it had and the clamp at
  zero flooded the sheet by twelve percent a substep. The mobility now
  saturates at a film of 0.04, the levelling is a face exchange capped at
  0.12 per face (the cell-velocity form also decoupled odd and even cells
  and dried with a fingerprint of ripples), and the speed cap is 0.1 so
  four faces and the exchange together can never empty a cell.
- **Every edge grew hairs.** The Marangoni term had the steepest pigment
  gradient of all at the rim of a stroke on dry paper and shoved fluid off
  it along the fibre noise. It is gated on every neighbour being wet: a
  bloom inside a wash satisfies that, a contact line never does.
- **Washes dried as clouds.** The sheet's absorbency varied by half its
  base over fifty-texel patches, so one part of a wash drank its water
  well before the next and dried as internal fronts. It is gentler and
  finer now; the fibre field is lanes rather than speckle, which is what
  breaks an advancing bloom into fingers; and rim evaporation is a fifth of
  what it was, a ring being a share of the pigment, not the lot.
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

**Lifting the pen refills it.** Whatever the hairs carried at the start of a
stroke, they carry again at the start of the next. This was documented and
never done: after one wash the artist held an empty, dry brush and had to
rebuild it from two sliders and a pan before the next mark. Every other
painting app dips the brush between strokes; now so does this one.

**Pressure drives flow** as well as width. Pressing harder lets paint leave
the brush faster — a touch at about half the rate, leaning on it at nearly
one and a half times — so a firm pass is darker and a light one a tint. The
brush still pays for every bit it lays: this scales the *rate* of release,
not the mass, so nothing about "pigment mass per area decides value" is
bent. A finger or a mouse reports a fixed pressure and paints exactly as
before. Off in Settings, pressure changes only the width.

**Tilt shapes the footprint.** An upright Pencil lays a round dab; a leaning
one lays its hairs along the paper, and the dab stretches in the direction
of the barrel, up to nearly three times as long. The mass is divided by the
stretch so a leaning stroke is the same depth as an upright one, only wider.
It is the cheap version of Expresii's 3D brush, and the difference between
a mark and a dot.

## The workbench

The UI mirrors a physical setup: a **paint box of 12 pans**, a **water
glass** and a **sponge**. The brush is stateful — it carries water and a
12-pigment load:

- **Dip a pan** to pick up paint (a wet brush dissolves the pan and picks up
  far more than a dry one, which only scuffs colour off it).
- **Mix by parts.** A pan is a dial for its own share of the recipe:
  **tap** adds a part, **drag up or down** sets it live (down to zero takes
  it out), **hold** makes it the only colour. Yellow to 7, black to 1, blue
  to 2 and the brush carries 7:1:2. Dragging matters more than tapping —
  a proportion is something you feel your way to, and tapping seven times
  to correct one part is not that. The Paint slider then says *how much*
  of that mixture is on the hairs, so ratio and quantity stay separate.

  The hold used to remove a colour, which a drag to zero does as well. It
  now does the one thing nothing else could: **switch**. Tapping adds parts,
  which is right for mixing and wrong for changing colour — tap red, tap
  blue and you were painting purple, and the only way to just have blue was
  a rinse and a tap. A double tap was tried for this and collided with
  tapping quickly to add parts.

  Above the pans, the mix is shown as **a dried stroke on the current
  paper** — not a chip of flat colour, which cannot show the two things that
  actually distinguish one watercolour from another. Heavy pigments drop out
  of suspension into the tooth of the sheet and separate into mottle; thin
  paint lets the paper through. So the strip is rendered with the same
  Kubelka-Munk optics and the same granulation rule as the painting itself,
  per pigment and per pixel, running from full strength at the left out to a
  dry-brush tail. It is drawn on the CPU at 420x34, which costs nothing and
  needs no second GL context, and it is hidden entirely when the brush is
  empty.

  Measured across the middle of the stroke, the pixel-to-pixel variation is
  10.1 for ultramarine (granulation 0.91) against 0.2 for Prussian
  (granulation 0.15) — the separation is real, not decoration. Every component keeps its own physics on the paper, so a mix
  containing ultramarine still granulates and one containing quinacridone
  still stains.

  This replaced a simulated ceramic mixing plate. The plate was a second
  full instance of the watercolor simulation running every frame: 18% of all
  the work done on an iPhone, and the reason the sheet could only afford 12
  pigment channels once it was gone. Diluting a mix is now the Water and
  Dilution sliders rather than a puddle.
- **🌀 Rinse** takes the colour off the hairs and nothing else. It leaves the
  water alone (that is the water slider's job) and it leaves the recipe
  standing, so the next tap on any pan brings the whole mix back. It used to
  empty all three, and a session log showed what that cost: after one rinse
  the artist made 592 more dabs, every one of them carrying no colour,
  painting clean water over the picture and then trying to dry it off again.
  The preview strip disappearing is now the signal that the brush is empty.
- **💧 Water glass**: adds water to the brush and washes a little pigment off.
  Hold and swirl for more of both.
- **🧽 Sponge**: blots water off the brush while keeping most of the pigment
  — the "thirsty brush" for dry-brush work and lifting.
- **Paper picker**: Rough (the default) / Cold press / Hot press / Toned
  cream — different tooth, absorbency and tint (switching gives a fresh
  sheet).
- **↶ Undo** (or a two-finger tap, or ⌘Z) steps back through strokes,
  saltings and clears. The painting is the state of a fluid simulation
  rather than a list of shapes, so undo has to restore that state — water,
  suspended pigment and deposits alike — and undoing into a half-dry wash
  brings back the wetness too, not just the colour.

  It used to copy every texture into a GPU slot per stroke, tens of
  megabytes each, which bought two or three steps on a phone and one on a
  big canvas; a mistake into a wash was unrecoverable, so people painted
  timidly. Now a step stores only the **region a stroke changed**, on the
  CPU. Before a stroke the whole state is copied into a GPU "pre" buffer,
  which is cheap; as the stroke ends, the texels it touched plus everything
  wet are read back from that copy while nobody is waiting on the pen; and
  at the next pen-down the sheet is compared with "pre" on the GPU, block by
  block, so that whatever flowed or dried in between is covered too. A
  stroke on a dry sheet is a few hundred kilobytes, a wash over the whole
  sheet is the whole sheet, and the depth is whatever fits the budget —
  dozens of ordinary strokes rather than two. Replaying the stroke log was
  the other way to do this and was rejected: the sheet is time-dependent,
  so replaying five minutes of painting means five minutes of simulation.

## Timing tools

- **👁 Wetness view** — the digital "look for the shine": blue = wet
  (paint into it for soft blends), teal = satin (controlled soft edges),
  amber = damp (touching it blooms), untinted = dry (crisp edges, glazing).
- **🧂 Salt** — toggle, then tap or drag over the painting. Grains are a
  scatter of individual crystals of varying size, sparse and clumpy, sized
  from table salt to rock salt in Settings. Each one soaks water and shoves
  pigment into a starburst; like real salt it only textures a wash caught in
  the damp band — too wet and it dissolves, too dry and nothing happens.
- **💦 Water drop** — toggle, then tap. What makes this different from
  touching the paper with a clean wet brush is not the water, it is that a
  drop briefly **re-dissolves paint that has already set** and carries it to
  its own rim. That is what a backrun is; a wet brush merely wets. It also
  carries a fixed volume regardless of what the brush holds — about ten
  brush dabs' worth over a slightly wider footprint. It used to be
  twenty-four dabs' worth, which was less a drop than a spill.

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
- **A dab touches only its footprint.** Every dab used to be a full-grid
  pass over four render targets. A fine brush spaces its dabs two pixels
  apart, so a quick line fired hundreds of full-screen passes a second —
  the lag and the heat on small brushes. The pass is now scissored to the
  dab, and instead of ping-ponging the whole texture the region is copied
  back, so a 4px brush costs a few hundred texels per dab rather than four
  hundred thousand.
- **Fewer, fatter passes.** Every pass is memory-bound — its real cost is
  writing and re-reading the full state textures — so two merges cut the
  per-substep traffic directly. Moisture and capillary were two passes each
  round-tripping flow+sat; they are one pass now (the capillary half sees
  neighbours one substep stale, far below anything visible). And the
  deposition/lifting stage, which reads flow, paper and *every* pigment
  texture, used to run as two identical draws purely because the WebGL2
  guaranteed MRT minimum is 4 attachments; on hardware that reports enough
  attachments (8 is typical — desktop and Apple GPUs alike) it now updates
  every suspension and deposit texture in a single draw: half the reads and
  half the draws of the heaviest stage in the pipeline. Devices at the
  minimum keep the split form. The render pass also stopped re-fetching
  every deposit texture for the rim-gradient centre tap (the samples were
  already in registers), and the velocity pass skips its Marangoni
  pigment-gradient taps — five per pigment texture per cell — entirely when
  run-off is off.

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
- **Pencil pressure → paint flow** — pressing harder lets paint leave the
  brush faster. Off: pressure changes only the width.
- **Pencil tilt shapes the brush** — a leaning Pencil stretches the dab
  along the barrel. Off: always round.
- **Finger paints** — until a Pencil is used (default), always, or never.
  Fingers pinch, pan and two-finger-tap-to-undo in every case.

## Paint box & channels

**Four colours by default** — one texture pair, a third of the pigment work
of twelve, and a limited palette is how most watercolours get painted
anyway. The working palette is **1 to 12 pans** chosen from the full paint
box, and
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
  strokes fade and end in dry-brush tails. Lifting the stylus dips it again.
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
  downhill on an iPad held sideways too. The tilt is taken from where
  gravity points in the device's frame, not from the beta and gamma
  angles themselves: gamma is undefined with the phone held upright in
  the hand and the sensor flips it between +90 and −90, which is why the
  water used to run left in portrait with nobody tilting anything.
  Readings are smoothed and the first five degrees away from level do
  nothing: a hand is never still, and taken raw every wobble ran the
  water a different way. **Tilt strength** in Settings sets how steeply
  it runs; with run-off off, tilt does nothing.
- **Dry**: hold to flash-dry the sheet, then glaze over — dried washes
  resist re-blending except through deliberate rewetting.
- **Save** exports a PNG.

## Files

- `js/shaders.js` — all simulation passes (GLSL ES 3.00)
- `js/sim.js` — WebGL2 engine (ping-pong textures, MRT passes)
- `js/pigments.js` — measured pigment data (Curtis et al. 1997, Fig. 5)
- `js/main.js` — UI, pointer/stylus input, finger navigation
- `js/demo.js` — scripted showcase (blooms, strokes, granulation, backrun)
- `tools/tells.js` + `test/tells.html` — the paint model's regression sheet
- `tools/scenes.js` + `test/scenes.html` — the painter's marks, rendered to
  PNG to be judged by eye (`--page variants` renders `test/variants.html`,
  the same marks under several physics settings with mass totals traced)
- `tools/input.js` — the input contract, checked headlessly against the app

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
- Lekner & Dorf, *Why some things are darker when wet*, Applied Optics 27(7)
  1988 — internal reflection in the wetting film makes wet reflectance a
  power of dry reflectance; the wet-paper darkening model
- Jensen, Legakis & Dorsey, *Rendering of Wet Materials*, EG Workshop on
  Rendering 1999 — wet-surface albedo reduction in practice
