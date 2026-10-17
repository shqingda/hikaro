# hikaro — identity

A room, a sun, a horizon.

## The idea

The **h** is the room. The light is a **circle**, not a square: a sun that sits behind the letter’s shoulder. One horizon line holds both. Nothing is placed inside the letter; the light is a separate body, and the overlap is the picture.

The wordmark carries the same light at a smaller size: the dot over the **i** is a round beam tittle.

## The mark

- Letter: **Literata Light 300**, lowercase **h**.
- Sun: a circle, radius **190 / 1000** em, behind the h’s right shoulder.
- Horizon: one bar, **18 / 1000** em, at the baseline.
- The sun is never placed inside the h’s counter. It is a circle, never a square.
- One-colour use: the sun becomes a **ring** (stroke 14), so the h stays separate from it.

## The wordmark

- **hikaro**, lowercase, Literata Light 300.
- Tracking: **−15 / 1000** em.
- The tittle over the **i** is a **circle**, diameter 110 / 1000, in Beam. This is the only change to the type.
- Minimum wordmark width: **160 px**.

## Colour

| Name | Hex | Role |
| --- | --- | --- |
| Beam | `#F2B500` | sun, horizon, tittle |
| Ink | `#12120F` | letter, icon field |
| Paper | `#F7F7F6` | ground, icon letter |

Beam is a field, not a glow. No gradients, no shadows on the mark, no coloured halo.
Contrast: ink on beam 10.2:1 · paper on ink 17.5:1 · ink on paper 17.5:1.

## macOS icon

The Dock icon is drawn, not a full-bleed tile:

- **1024 × 1024** canvas.
- **824 × 824** icon field, centred: **100 px** transparent margin on every side.
- Continuous **185** corner (superellipse).
- Ink field, paper **h**, Beam sun and horizon.
- The icon is flat; the Dock supplies the shadow.

The icon is supplied as:

- `exports/AppIcon.icns` — macOS icon for the app bundle.
- `exports/AppIcon.iconset/` — the 10 PNG slots used to build the icns.
- `exports/app-icon-1024.png` … `app-icon-16.png` — transparent-corner PNGs.
- `assets/app-icon.svg` — source vector.

At **16 px** the h and sun remain; the horizon becomes a single line. Minimum icon size: 16 px.

## Type

**Literata Light 300** is the voice: a reading serif with open counters, a sturdy x-height, and serifs that soften first at small sizes. That is deliberate: the letter may lose its detail before the light does.

The product UI keeps its terminal monospace. The serif is the brand voice, not a UI font.

## Rules

- Clear space: **one sun** on every side of the mark and wordmark.
- Minimum mark: **16 px**. Minimum wordmark: **160 px**. Minimum stacked lockup: **220 px** wide.
- Never put a light shape inside the h. The sun sits behind the shoulder.
- Never replace the circle with a square, a rounded square, or an icon tile.
- The macOS rounded square is the canvas, not a second logo frame. Do not add another tile, ring, or monogram frame inside it.
- Do not add rays, stars, gradients, glows, or shadows to the mark.
- The horizon is one line. Do not double it, dash it, or curve it.
- The mono mark uses the sun as a ring; it is not a solid mono sun.
- Do not re-letter the wordmark. The round tittle is the only typographic intervention.

## Files

```
assets/
  mark.svg, mark-on-ink.svg, mark-mono-ink.svg, mark-mono-paper.svg
  wordmark.svg, wordmark-on-ink.svg, wordmark-on-beam.svg,
  wordmark-mono-ink.svg, wordmark-mono-paper.svg
  lockup-stacked.svg, lockup-stacked-on-ink.svg
  app-icon.svg, favicon.svg
exports/
  AppIcon.icns, AppIcon.iconset/
  app-icon-16…1024.png
  wordmark-400/800/1600.png, mark-300/600/1200.png
  lockup-stacked-750/1500.png
  favicon.ico
fonts/
  Literata-Light.ttf, Literata-Regular.ttf, OFL.txt
```

The superseded terracotta/cream assets remain untouched in `brand/` (one level up). This folder is the replacement system.

## Licence

Literata is by TypeTogether, licensed under the SIL Open Font License 1.1 (`fonts/OFL.txt`). The font files are self-hosted here for this brand sheet and the wordmarks. The logo assets are outlined vectors; the font files are not required to use them.
