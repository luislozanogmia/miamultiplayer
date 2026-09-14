# Mia Mote

Mascot for Mia (the pink clay "envelope" blob). The body uses a transparent
raster plate with vector eyes drawn on top so it can blink.

| File | Use |
|---|---|
| `mote.svg` | **Drop-in animated mascot.** Self-contained (body embedded as WebP) with a SMIL blink every 4.6s: open → half-lid → closed arcs → open. Works in a plain `<img src="mote.svg">`, as a CSS `background-image`, or inline. Scales to any size; at ≤32px the blink is still visible. |
| `mote-static.svg` | Same, no animation (eyes open). |
| `mote-static.png` | Original render cut-out with its real eyes, 620×580, transparent. |
| `mote-512.png` | 512px version of the above (OG image / app icon source). |
| `mote-icon-256.png` | Square 256px, centred (favicon / avatar fallback). |
| `mote-body.png` / `.webp` | Eyeless body plate, if you want to draw your own eye states. Eye centres (620×580 space): L (293,199), R (415,202), pill 36×64, tilt −3°. |

Aspect ratio is 620:580. Pink reference: base `#E9407F`, highlight `#FF6FA6`, shade `#B8245C`.

Only one instance of `mote.svg` per `<img>` is needed; several on one page blink in
sync unless you stagger them (inline the SVG and set `begin` on the `<animate>`s, or
add a random `?v=` query so each `<img>` loads a separate document timeline).

## Department variants

Same body plate, hue-shifted, plus one small motif each. `mote-<v>.svg` blinks,
`mote-<v>-static.svg` doesn't. Routing: `moteVariantFor(name)` in app.js.

| Variant | Colour | Motif |
|---|---|---|
| `inbox` | pink `#E9407F` | envelope crease (the original) |
| `research` | purple `#8A4BE0` | crystalline ridge on the crown |
| `calendar` | orange `#F2712B` | ring / halo |
| `sales` | red `#E03535` | two upward fins |
| `general` | beige `#E9D7C4` | plain Mote |

Motifs are rendered as raster clay (same top-left key light, contact shadow at the
joint) into the plate, so the SVG is just one WebP + the vector eyes. viewBox is
`0 0 620 640` (60px headroom).

The motif and body color are separate signals in the UI: `moteVariantFor(name)`
keeps the department motif, while `moteColorSlotFor(name)` assigns each Mote a
stable slot in a 16-color palette. Hash collisions are resolved so visible Motes
do not repeat a color until the palette is exhausted; the color is applied as a
small hue adjustment to the existing asset, preserving its clay lighting.

### Smile sizes

Every variant also ships with a smaller crease: `mote-<v>-half.svg` (½) and
`mote-<v>-third.svg` (⅓), scaled about the V's vertex; `-static` twins too.
`moteSmileFor(name)` in app.js hashes the bot name so each bot keeps one size.
The crease is split from the plate as a signed detail layer and re-added at
scale, so shading stays native.
