# Homestead Valley StoryMap — Working Prototype

A minimal, no-build-step scroll-driven story map. A map chapter opens with a
full-width band of map and the narrative follows underneath it, so the two
never overlap and the map scrolls away like any other block. There is still
only **one** MapLibre GL JS instance on the page: it is moved into whichever
chapter's map band is coming up, and its camera, visible layers and legend
change as you go. Photos and video sit in a column beside the chapter's
text — in normal flow, not pinned to the window — so nothing ever overlaps
anything else. This version is hand-built so it's fully inspectable/editable as
plain HTML/CSS/JS, using MapLibre GL JS (open source, no API key/account)
instead of Mapbox.

**Everything in here is placeholder content** — the point is to prove out
the mechanics (hero/title screen, text chapters, photo embeds, video
embeds, map layers, legend, theme, footer) before wiring in final
narrative copy, final graphics, and final GIS data.

## What's in this prototype

- `index.html` — page shell, loads MapLibre GL JS + Google Fonts from a CDN (no API key/account needed)
- `css/style.css` — the theme token system (`:root` plus one block per `html[data-theme]`), hero/cover styling, the stacked map-chapter layout, the text+media chapter row, the nav bar, legend, footer
- `js/story.js` — all logic: loads `data/chapters.json`, renders the hero + chapters, drives the map, legend, theme, and footer
- `data/chapters.json` — **the only file you need to touch to change content.** Plain JSON, no JavaScript knowledge needed.
- `data/dummy-csa14-boundary.geojson` — placeholder shape standing in for the real Marin County CSA 14 (Homestead Valley) boundary
- `data/csa14-boundary.geojson` — the real CSA 14 boundary, already converted from the County's shapefile and sitting ready — not wired into the map yet on purpose (see "Swapping in the real CSA 14 boundary" below)
- `data/sample-risk-zone.geojson` — dummy polygons (two risk categories) standing in for a real hazard/vegetation overlay
- `data/sample-points.geojson` — dummy points standing in for real waypoints (e.g. evacuation route, chimney/ridge markers)
- `media/` — all client-supplied photos/video, served locally so paths work both here and on GitHub Pages

## Editing content — `data/chapters.json`

Everything editorial lives in this one JSON file: global settings, theme
colors/fonts, chapter order, titles, body text, images, video URLs, map
camera position per chapter, which map layers are visible in each chapter
and which side the map sits on, the legend labels/colors, and the footer.
Add a new chapter by copying an existing object in the `"chapters"` array —
no code changes needed.

### Global `"settings"` block

```json
"settings": {
  "pauseVideoOffscreen": true,
  "legendPosition": "right"
}
```

- **`pauseVideoOffscreen`** — `true`/`false`. When `true`, any playing
  video (local `.mov`/`.mp4` or YouTube embed) automatically pauses the
  moment its chapter scrolls fully out of view (above or below the
  viewport). Set to `false` to let videos keep playing in the background
  while scrolling past.
- **`legendPosition`** — `"left"` or `"right"` — which bottom corner the
  legend box sits in.

### `"themes"` + `"activeTheme"` — colors and fonts

Four themes ship with the prototype. `"activeTheme"` names the one that
loads by default; the rest are available from the theme picker in the nav.
A theme is more than a palette — it changes the page background, the
surface treatment, the hero scrim and the nav — so each one is defined in
two places, described under *Where a theme lives* below.

```json
"activeTheme": "serpintine",
"themes": {
  "ember": {
    "label": "Ember",
    "colors": {
      "primary": "#4ca08c",
      "secondary": "#dd8a3e",
      "accent": "#5f9ec9",
      "dark": "#0d1917",
      "light": "#e9f1ee"
    },
    "fonts": {
      "heading": "'Chivo', 'Segoe UI', sans-serif",
      "body": "'Literata', Georgia, serif"
    },
    "fontsHref": "https://fonts.googleapis.com/css2?family=Poppins..."
  }
}
```

| Theme | What it is for | Primary / Secondary / Accent | Fonts |
| `serpentine` | Dark, for presenting to a room with the lights down | `#4ca08c` `#dd8a3e` `#5f9ec9` | Chivo / Literata |

 `serpentine` existsbecause this gets shown at community meetings on a projector, where a
bright page is the wrong thing in the room.

**Which role goes where.** `primary` is the nav marker and the narrative
card's signal edge; `secondary` is the hero dateline rule, the scroll cue
and chapter numbers; `accent` is Block Explorer outlines and focus rings;
`dark` and `light` are map label ink and halo (see the constraint below).

**Where a theme lives.** Two files, with one rule for which:

- `data/chapters.json` holds the five colours and the two font families.
  These are the values the map needs, because MapLibre paint properties
  cannot read CSS custom properties — `themeColor()` in `js/story.js`
  reads the computed value back out instead. `applyTheme()` writes them
  as inline styles on `<html>`, so they win over any stylesheet rule.
- `css/style.css` holds everything else, as a block of ~40 custom
  properties under `html[data-theme="<name>"]`: page background, surface
  fills, radii, shadows, rule colours, ink ramp, nav colours, the hero
  scrim, the footer. `:root` carries the full set as the `ember`
  defaults, and each theme block overrides what it needs to change.

So **adding a theme is two edits**, not one: an entry in `"themes"` and a
matching `html[data-theme]` block. Add the name to the short whitelist in
the inline script at the top of `index.html` too — that script sets
`data-theme` from `?theme=` / `localStorage` before first paint, so a
reader on `serpentine` does not get a flash of the light default while
`chapters.json` is still loading. `story.js` then sets the attribute
again, authoritatively, once the config is in.

The map layers that carry branding (the Marin-context boundary highlight,
Block Explorer outlines and labels) repaint on switch. Layers that encode
*data* — the vegetation classes, elevation ramp and contour brown, all
described in the legend — are deliberately left alone.

**One hard constraint on `dark` and `light`.** They are not just text
colours: `dark` is the `text-color` of the Block Explorer block labels and
`light` is the `text-halo-color` of the contour labels, both drawn over
the light CARTO Positron basemap. So in *every* theme, including
`serpentine`, `dark` has to stay dark enough to read on a pale map and
`light` light enough to halo against it. Inverting them for a dark theme
would make the map labels illegible.

Each theme names its own Google Fonts URL in `fontsHref`, injected the
first time that theme is applied; only the default pairing is loaded
statically in `index.html`.

**Switching:** click the swatches in the nav (the choice is remembered in
`localStorage`), or force one with a query string — `index.html?theme=fieldbook`
— which is handy for sharing a specific look without committing to it.

### Two visual languages: Voice and Instrument

The stylesheet splits every surface into one of two families, and the
theme tokens are named for which:

- **Voice** (`--voice-*`) — someone talking. The narrative card, the
  pull-quotes, the footer. Soft shadow, a coloured edge on the left, text
  set to a reading measure (`--voice-measure`).
- **Instrument** (`--panel-*`) — something you operate or read a value
  off. Map buttons, the legend, the map popup, the basemap bed. Hairline
  ring, tight radius, near-flat.

Before this split every one of those surfaces shared a single radius and a
single shadow, which left no way to tell a control apart from a sentence.
If you add a surface, pick a family and use its tokens rather than
introducing a third treatment.

### Per-chapter `"mapPosition"` — does this chapter show the map?

```json
"mapPosition": "left" | "right" | "none"
```

Either of `"left"` / `"right"` makes this a **map chapter**: it opens with a
full-width band of map (85% of the viewport height, 58% on phones — the
`--map-stage-h` token in `css/style.css`) and the chapter's text and map note
run underneath it in normal flow. The reader scrolls the map away to read.
`"none"` hides the map entirely and the text renders full-width and centered,
like a plain narrative panel.

A map chapter can have photographs too — `"mapPosition"` and
`"mediaPosition"` are independent. The media panel just waits until the band
has scrolled off; see **Two things that make the panel yield** below. Note
that a map chapter's section is `display: block`, so the `justify-content`
that docks the text card has to be restated on `.chapter-stage-text`, the
flex container the card is actually a child of.

`"left"` and `"right"` currently behave identically, since the map is no
longer docked to one side; the two values are kept so the layout can be
changed back per chapter without re-editing the data file.

A map chapter should also carry a `"mapTitle"` — the short cartographic
title shown on the plate at the map's top-left ("Elevation and Terrain",
"Vegetation × Elevation"). It is deliberately not `"title"`: the narrative
headline is a question or a claim ("See the Shape of Homestead") and says
why the reader is looking at the map, while this says what they are looking
at. Omit it and the plate falls back to `"title"`, which is a fallback, not
a default — one MapLibre instance serves every map chapter, so the plate is
the only thing on the band that names which of the six maps is on screen.

There is only ever one MapLibre instance on the page. As you scroll, the
`#map` element is physically moved into the next map chapter's band — moving
a `<canvas>` between parents doesn't disturb its WebGL context, so this costs
one `resize()` and nothing else. The move is only safe because every map
chapter reserves at least a full viewport of text below its band, which
guarantees two bands are never on screen at once; if you change
`.chapter-stage-text`'s `min-height` in the CSS, keep it at `100vh` or more.

### Per-chapter `"mediaPosition"` — where the photos sit

```json
"mediaPosition": "right" | "left" | "full" | "none"
```

**Every image and video in the story lives in one place: `#media-sidecar`.**
There are no images inline in the prose. A chapter's `"media"` array is
rendered into that one panel by `placeMediaForChapter()` when the chapter
activates, and `"mediaPosition"` says where the panel docks. The panel is
`position: fixed`, a sibling of `#story`, so it stays put while the words
scroll past it.

- `"right"` (the default) — panel docked to the right 58% of the viewport;
  the text card is pushed into the free left-hand 42%.
- `"left"` — mirror image.
- `"full"` — panel takes the whole viewport width and the text card floats
  on top of it. For media too wide to read in a half-viewport panel: the
  valley panoramas (11800 px and 12554 px) and the full-page posters.
  Currently only `section1-built-by-neighbors` uses it.
- `"none"` — panel fades out, text card centres at the wider measure.

The default is **media-aware**, which matters more than it sounds: a chapter
with media and no `"mediaPosition"` key gets `"right"` (an omitted key never
throws content away), and a chapter with *no* media is forced to `"none"`
regardless of what the key says (so a text-only chapter never fades in an
empty panel). Anything unrecognised falls back to `"right"` — a typo costs
you a layout preference, not the content.

The text card's measure (`--voice-measure`, 32 rem) is sized to clear a
docked panel: at 1440 px the free 42% strip is 605 px and `--gutter` takes
86 px, so 32 rem (512 px) fits with room to spare. If you widen the dock
past 58%, re-check that arithmetic.

Images are never cropped — `width/height: auto` with `max-width/max-height:
100%` means the element box takes each image's real aspect ratio, so the
frame hugs the artwork instead of letterboxing it.

Below 820 px there is no "side" to dock to: the panel becomes a full-width
46vh band at the top of the viewport and the card is padded down to clear
it.

#### What the panel follows: media regions

`setupMediaRegions()` cuts the story into regions laid end to end, and the
panel shows the media of whichever one covers most of the screen:

- a plain chapter owns its whole section;
- a map chapter owns only its narrative, `.chapter-stage-text`;
- a map band and the Block Explorer own **no** media, so whenever one of
  them is the biggest thing on screen the panel docks to `none` and fades
  out.

The band has to be its own region because the panel is pinned to the
*viewport* while the band is in the *page*. Both want the same pixels, and
the panel can't simply be painted over: `.chapter-map-stage` is
deliberately transparent (that's what makes the `--map-frame-pad` inset
read as a frame), so the photograph would show through as a band running
around the map. Yielding to the band also gives the reader the two things
in sequence — ground first, photograph second.

Regions are measured live on every scroll, not cached. Chapters move as
fonts land, as carousel images decode and as the sticky toolbar wraps, and
a cache that misses any of those hands the panel to the wrong region. The
measurements are reads with no writes between them, so they cost one layout
pass.

This is deliberately *not* driven by the chapter-activation observers in
`setupScrollTriggers()`. A map chapter has to claim the shared map the
instant its band touches the bottom of the viewport or the reader watches
an empty stage scroll past — but a section between two maps is taller than
the screen, so that moment arrives while the reader is only halfway down
the text above. Driving the panel from it blanked the photograph a full
screen early, which is exactly the bug this replaced.

`setupFooterRelease()` is the one other thing that moves the panel — it
lets it go at the very bottom of the page so the footer isn't read through
it. `#map` is deliberately *not* in that function any more, because it
scrolls away with its own chapter.

### Per-chapter `"icon"`

```json
"icon": "flame" | "map-pin" | "home" | "tree" | "wind" | "shield"
```

Renders a small inline SVG icon (hand-drawn, no icon-library dependency)
next to the chapter heading, colored from the theme. Omit the field for no
icon. Add more icons by adding an entry to the `ICONS` object in
`js/story.js`.

### Per-chapter `"dummy"`

Set `"dummy": false` on a chapter once its text/photos are final — this
removes the orange "Dummy content" tag. Any chapter that omits this field,
or sets it to `true`, keeps showing the tag.

### The `"isTitleScreen"` hero chapter

The first chapter in the array is normally the hero/cover: a full-bleed
background image or video, a themed scrim over it (`--hero-scrim`), and
the eyebrow/title/lede set bottom-left on a reading measure rather than
centered — so the title shares its left edge with every chapter that
follows it. Mark a chapter this way with `"isTitleScreen": true` and give
it an `"eyebrow"` field, which reads as a dateline (*where* this is
about) under a short rule.

The "scroll to begin" cue is the page's only piece of motion that the
reader did not trigger, and it is there to do a job: tell a first-time
visitor that this page is driven by scrolling. It is a line travelling
down a 1px track, and it holds still under
`prefers-reduced-motion: reduce`.

### `"footer"` block

```json
"footer": {
  "title": "Take the Next Step, Together",
  "text": "Closing paragraph...",
  "links": [{ "label": "Ember Ready sign-up", "url": "#" }],
  "credit": "Small print at the very bottom."
}
```

Renders as a full-width dark closing section after the last chapter, with
a title, paragraph, a row of pill-shaped links, and a small credit line.
Leave any field out to skip that part of the footer.

## Swapping in the real CSA 14 boundary

`data/csa14-boundary.geojson` already exists in this folder — a real
Marin County CSA 14 polygon converted from the County's own shapefile —
but the map currently loads `data/dummy-csa14-boundary.geojson` instead
(a rough placeholder outline), per an explicit choice to keep a simple
placeholder in place until the real layer is finalized/re-supplied. To
switch to the real data, open `js/story.js`, find the `map.addSource("csa14", ...)`
call, and change its `data` path from `"data/dummy-csa14-boundary.geojson"`
to `"data/csa14-boundary.geojson"`. Nothing else needs to change — the
fill/outline layers, per-chapter visibility toggling, and legend entry all
key off the same `"csa14"` source name either way.

## Viewing it

`data/chapters.json` and the `.geojson` files are loaded via `fetch()`,
which browsers block under `file://` (i.e. double-clicking `index.html`
directly won't work — the page will look empty). Serve the folder over
local HTTP instead, using `serve.py` in the repo root (one level up):

```
python serve.py 8765 storymap-prototype
```

then open `http://localhost:8765/`.

## Interaction notes

- Mouse-wheel scrolling always scrolls the story/page (the map's own
  scroll-to-zoom is disabled) — no need to hover the browser scrollbar.
  You can still zoom the map with the +/- buttons (top-right) or by
  dragging/pinching.
- The legend only shows entries for layers that are visible in the current
  chapter, and the whole legend box hides itself when no layer in the
  current chapter is active (instead of showing an empty box).
- Video (local file or YouTube) auto-pauses once its chapter is fully
  scrolled out of view — see `pauseVideoOffscreen` above to turn this off.
- The map hands itself off from one map chapter's band to the next as you
  scroll, and fades out entirely on `"mapPosition": "none"` chapters. The
  hand-off happens while both bands are off screen, so you never see it.
- Both maps sit inside a themed frame — inset from the edge of their band,
  with the hairline, radius and shadow the rest of the page's controls use
  (`--map-frame-pad` / `--map-frame-radius`), so a map reads as a framed
  exhibit rather than a hole cut through the page.
- Both maps carry a **title plate** (top-left) and a **north arrow** (first
  item in the bottom-right control stack). The arrow's rose counter-rotates
  with the camera's bearing — drag-rotate is live on both maps, so a rose
  painted at a fixed angle would start lying the moment a reader used it.
  The story map's plate is re-filled per chapter from `"mapTitle"`; the
  Block Explorer's is static markup in `renderExplorerSection()`.
- The nav bar is one tier: the eight narrative sections, plus a pinned tail
  on the right holding the **Explore Your Block** button and the theme
  swatches. The section tabs may wrap to a second line on a narrow window;
  the tail never moves. There used to be a second tier listing every
  chapter in the active section — 46 pills nobody aimed at, and because it
  appeared and disappeared per section it changed the height of a sticky
  element mid-scroll, which the reader saw as the page jumping.
- **Explore Your Block** is drawn as a filled call-to-action rather than
  another tab, because it's the one interactive thing on the page. It
  carries a slow halo animation, suppressed under `prefers-reduced-motion`.

## Known placeholder caveats

- `.mov` playback support varies by browser/codec — this is standing in for wherever the client's final video ends up (self-hosted file or YouTube).
- The CSA 14 boundary layer is a hand-drawn placeholder shape, not the real County GIS geometry — see "Swapping in the real CSA 14 boundary" above.
- The risk-zone/points layers are dummy shapes with approximate coordinates, not real hazard data.

## Deploying to GitHub Pages — things that can go wrong

This prototype is 100% static (HTML/CSS/JS + JSON + GeoJSON + images/video),
so GitHub Pages works with zero build step — just push the `storymap-prototype`
folder contents to a repo and enable Pages on that branch/folder. Watch out for:

- **Repo file size limits.** GitHub blocks any single file over 100 MB by default (and warns starting at 50 MB). `media/HV_PANORAMIC_VIDEO_1.mov` (~58 MB) and a couple of the panoramic JPGs are worth checking — if any production file ends up over 100 MB, either compress/convert it or don't self-host it at all (upload to YouTube, unlisted if needed, and embed it the same way the Shorts video is embedded here).
- **Repo size soft cap.** GitHub recommends keeping repos under ~1 GB and will nag (not hard-block) past that. A photo/video-heavy StoryMap repo can creep up fast once all 48 production graphics + final video are added — worth checking total repo size before the final push, and considering Git LFS or external hosting (e.g. Cloudflare R2, YouTube for video) for the heaviest files if so.
- **Bandwidth soft limit.** GitHub Pages has a soft ~100 GB/month bandwidth guideline. Fine for a community-sized audience; would matter if the page went viral or got embedded/shared heavily elsewhere.
- **Build frequency soft limit.** ~10 Pages builds/hour soft cap — irrelevant here since there's no build step, but worth knowing if a build process (e.g. Jekyll) gets added later.
- **Case sensitivity.** GitHub Pages serves from Linux, which treats file paths as case-sensitive — unlike Windows. Double-check that the exact casing in `chapters.json` image/video paths matches the real filenames in `media/` byte-for-byte, or images that "work locally on Windows" can silently 404 once deployed.
- **Spaces in paths.** Filenames like `media/HV Panoramic.jpg` work fine as literal spaces in `chapters.json` — browsers and GitHub Pages both handle the un-encoded space transparently as long as it's used consistently.
- **Public visibility.** GitHub Pages sites are public by default on free/personal accounts (a private repo can still have a public Pages site unless you're on GitHub Enterprise) — worth confirming with the client whether the site should be publicly discoverable/indexable before launch, or whether it should go on a host with access control instead (e.g. Cloudflare Pages behind Cloudflare Access).
- **Custom domain HTTPS certs** can take up to 24 hours to provision the first time a custom domain is attached — plan any launch-day timing around that if the client wants their own domain rather than the default `github.io` URL.

None of these are blockers for this prototype's current size — they matter once the real 48 production graphics, real GIS layers, and final video are swapped in.

## Next steps (per the main project plan)

1. Replace remaining dummy chapter text in `data/chapters.json` with real narrative copy from the brief.
2. Replace remaining dummy images/video with final production assets.
3. Add the rest of the sections from the full content plan (8 sections + opening).
4. Deploy to GitHub Pages / Cloudflare Pages / Netlify (all free) once content is finalized.
