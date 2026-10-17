// Minimal scroll-driven "sidecar" story map built directly on MapLibre GL JS.
// No build step, no API key, no account required. All chapter content, theme,
// icons, legend, and footer content live in data/chapters.json - this file
// only contains the logic that reads that JSON and drives the page/map.

// --- Global settings (overridden by data/chapters.json "settings") --------
const SETTINGS = {
  pauseVideoOffscreen: true, // pause video when its chapter scrolls fully out of view
  legendPosition: "left" // "left" | "right"
};

function applySettings(userSettings) {
  Object.assign(SETTINGS, userSettings || {});
}

// data/chapters.json "legend" block, kept module-level because two separate
// map instances render legends off it: the scroll-driven story legend
// (renderLegendShell) and the Block Explorer's own in-section legend
// (renderExplorerLegend), which is built lazily long after bootstrap().
let LEGEND_CONFIG = null;

// Tracks whichever chapter is currently active in the viewport - read by
// the map's "home" control to know what view to reset back to.
let currentChapterId = null;

// Shared reference to the single MapLibre instance + a readiness flag (true
// once its layers actually exist, after the "load" event's addLayer calls
// finish) - both the automatic per-chapter layer visibility in
// setupScrollTriggers() and the manual legend toggle clicks in
// renderLegendShell() drive the SAME map through setMapLayerVisibility()
// below, so a user's manual on/off click and the story's own scroll-driven
// state never fight each other via two different code paths.
let mapInstance = null;
let mapLayersReady = false;

// The Block Explorer runs a second, independent MapLibre instance. Held here
// so a theme switch can repaint its themed layers too.
let explorerMapInstance = null;

// Last chapter handed to updateHomesteadBoundaryStyle(). A theme switch has to
// re-run that paint for the chapter currently on screen, because the
// Marin-context highlight is drawn in the theme's primary colour.
let currentBoundaryChapter = null;

// Maps each legend/chapters.json layer key to the real MapLibre layer id(s)
// it controls (homesteadHighlight is backed by a fill + line pair sharing
// one on/off state; the old sample "risk"/"points" dummy layers and the
// duplicate black-dashed "homesteadBoundary" treatment have been removed -
// see data/chapters.json legend config for the current real layers).
const LEGEND_LAYER_IDS = {
  marin: ["marin-line"],
  homesteadHighlight: ["homestead-highlight-fill", "homestead-highlight-line"],
  vegetation: ["vegetation-fill"],
  elevation: ["elevation-fill"],
  bivariate: ["bivariate-fill"],
  contours: ["contours-line-casing", "contours-line", "contours-label"],
  streets: [
    "streets-halo-main",
    "streets-halo-trail",
    "streets-line-main",
    "streets-line-trail"
  ],
  // Deliberately absent from chapters.json's "legend" config, unlike every
  // other key here. Chapters still switch it on/off through this table (see
  // setupScrollTriggers), but it gets no legend section: it carries no
  // classes, no values and nothing to decode - it's a shading treatment
  // applied to the layers below it, not a dataset a reader looks up.
  hillshade: ["hillshade-relief"],
  // The Community Center - one landmark
  communityCenter: [
    "community-center-point"
  ]
};

// --- Terrain shade overlay ("Multiply" without a blend mode) -------------
// Built by topo_work/11_hillshade_shade.py from the USGS 3DEP 1 m LIDAR DEM,
// clipped to CSA 14 and warped to Web Mercator.
//
// This is NOT a picture of a hillshade. It is a picture of the shading
// OPERATOR, and the difference is the whole reason the map now reads as 3D.
//
// The first version of this overlay was a grey hillshade drawn UNDERNEATH the
// translucent choropleths. That composite is `f*C + (1-f)*H` - a linear
// average - so every class colour got pulled toward mid-grey in proportion to
// how much relief you let through. You could have the colour or the terrain,
// never both, which is exactly the "washed out" gap against the ArcGIS Pro
// reference render (NDVI over hillshade, Layer Blend: Multiply, Transparency
// 50%).
//
// ArcGIS Multiply at transparency (1-s) is `C * (1 - s + s*H)`: it darkens by
// relief and never desaturates. MapLibre GL v4 has no blend modes - but it
// does not need them, because Multiply is exactly reproducible with ordinary
// alpha compositing by moving this layer ON TOP and encoding it as
// black-with-alpha:
//
//     src = black, alpha a  ->  result = C * (1 - a)
//     with a = s * (1 - H)  ->  result = C * (1 - s + s*H)     <- identical
//
// So in the PNG, colour carries only the SIGN of the effect (black = darken,
// white = lighten) and alpha carries the magnitude. The build script also adds
// a deliberately weak white/highlight half on the sunlit side: white-over-
// colour is `C + a*(1-C)`, a linear dodge toward white, i.e. the very
// desaturation we are escaping, so it is held at ~0.10 against the shadow
// half's ~0.50 and never gets to dominate.
//
// Consequences that are easy to get wrong later:
//   * The fills underneath must be near-OPAQUE now (see THEMATIC_OPACITY
//     below). Transparency was the old mechanism for letting relief through;
//     here transparency only lets the basemap through and dilutes the colour
//     for nothing.
//   * Never set raster-contrast / -brightness-* / -saturation on this layer.
//     Those operate on RGB and leave alpha untouched, so they cannot change
//     the strength of an alpha-encoded operator - they can only decalibrate
//     the black/white sign channel. `raster-opacity` scales alpha linearly and
//     is the one correct strength dial.
//
// Delivered as a MapLibre `image` source (one PNG + four corner coordinates)
// rather than a tiled raster source: it's a single ~2.5 x 1.5 km overlay, so
// cutting an XYZ pyramid and standing up a tile server for it would be all
// cost and no benefit. The corners are read from the sidecar JSON the build
// script emits, so regenerating the PNG at a different size or extent can
// never leave the app pointing at stale coordinates.
const HILLSHADE_META_URL = "data/hillshade_homestead.json";
const HILLSHADE_LAYER_ID = "hillshade-relief";
const HILLSHADE_SOURCE_ID = "hillshade";
// The contract with topo_work/11_hillshade_shade.py. The superseded
// 10_hillshade_overlay.py writes a file with the SAME name at the same path
// but a luminance encoding, and pairing that one with the code below would
// look plausible while being wrong (a grey image composited on top just fogs
// the map). Checking the string makes a stale pairing loud.
const HILLSHADE_ENCODING = "shadow-highlight-alpha";

// --- Vegetation raster overlay ------------------------------------------
// Built by ndvi_work/11_ndvi_overlay.py onto the SAME Web Mercator grid as the
// shade overlay above.
//
// data/homestead_ndvi_vegetation.geojson is still loaded and still the source
// of truth (the Block Explorer queries it per-parcel, the legend acreages come
// from it, and it is the fallback below if this PNG is missing). But its edges
// trace the 10 m Sentinel-2 grid exactly, which on screen is a staircase on
// every class boundary - the other half of the "blocky" complaint. This PNG
// renders the identical classification with edges interpolated from the
// continuous index instead of quantised to the source grid.
//
// Areas below the NDVI 0.41 vegetated break are fully transparent on purpose,
// so bare relief shows through: on a September dry-season scene roads, roofs
// and cured grass genuinely are not live fuel, and leaving them open is what
// makes the shade overlay legible as terrain.
const VEGETATION_META_URL = "data/vegetation_homestead.json";
const VEGETATION_LAYER_ID = "vegetation-raster";
const VEGETATION_SOURCE_ID = "vegetation-image";
const VEGETATION_ENCODING = "classified-rgba";

let hillshadeMeta = null;
let vegetationMeta = null;

// Non-fatal on purpose: both overlays are visual enhancements. A missing or
// malformed sidecar should cost the reader the 3D effect (or the smooth
// vegetation edges), not the whole map.
async function loadOverlayMeta(url, expectedEncoding, label) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const meta = await res.json();
    if (meta.encoding !== expectedEncoding) {
      throw new Error(
        `encoding is "${meta.encoding}", expected "${expectedEncoding}" - the ` +
          "sidecar was written by a superseded build script"
      );
    }
    if (!Array.isArray(meta.coordinates) || meta.coordinates.length !== 4) {
      throw new Error("coordinates must be four [lon, lat] pairs (TL, TR, BR, BL)");
    }
    return meta;
  } catch (err) {
    console.warn(`${label} unavailable - continuing without it.`, err);
    return null;
  }
}

const loadHillshadeMeta = () =>
  loadOverlayMeta(HILLSHADE_META_URL, HILLSHADE_ENCODING, "Terrain shade overlay");
const loadVegetationMeta = () =>
  loadOverlayMeta(VEGETATION_META_URL, VEGETATION_ENCODING, "Vegetation raster overlay");

// The shade and the colour it shades have to sit on the SAME pixel grid. They
// are derived from rasters in different CRSs (EPSG:26910 for the DEM,
// EPSG:32610 for Sentinel-2), so ndvi_work/11_ndvi_overlay.py deliberately
// reads its target grid out of the shade sidecar instead of computing its own.
// A 1-2 px misregistration would show up as a coloured fringe along every
// ridge, so it is worth catching here too rather than trusting the build order.
function checkOverlayGridsAgree() {
  if (!hillshadeMeta || !vegetationMeta) return;
  const same =
    hillshadeMeta.width === vegetationMeta.width &&
    hillshadeMeta.height === vegetationMeta.height &&
    JSON.stringify(hillshadeMeta.coordinates) === JSON.stringify(vegetationMeta.coordinates);
  if (!same) {
    console.warn(
      "Shade and vegetation overlays are on different grids - expect a coloured " +
        "fringe along relief edges. Re-run topo_work/11_hillshade_shade.py and " +
        "then ndvi_work/11_ndvi_overlay.py, in that order.",
      { shade: hillshadeMeta, vegetation: vegetationMeta }
    );
  }
}

// The vegetation ramp is authored in three places that must agree: this file's
// VEGETATION_RAMP_NORMAL (the vector fallback), chapters.json's legend chips,
// and the PNG's baked-in pixels. Only the first two can be reconciled at
// runtime; the third can at least be compared against what the build script
// recorded it used.
function checkVegetationRampAgrees(rampFromMap) {
  if (!vegetationMeta || !Array.isArray(vegetationMeta.ramp)) return;
  const a = vegetationMeta.ramp.map((c) => String(c).toLowerCase());
  const b = rampFromMap.map((c) => String(c).toLowerCase());
  if (a.join() !== b.join()) {
    console.warn(
      "Vegetation raster was baked with a different ramp than the legend/vector " +
        "layer uses - re-run ndvi_work/11_ndvi_overlay.py.",
      { baked: a, expected: b }
    );
  }
}

// Adds an `image` source + `raster` layer for one of the two overlays above,
// positioned beneath `beforeLayerId` (or on top of everything so far when that
// is omitted).
function addImageOverlayLayer(map, meta, { layerId, sourceId, beforeLayerId, paint }) {
  if (!meta) return;
  map.addSource(sourceId, {
    type: "image",
    url: meta.image,
    coordinates: meta.coordinates
  });
  map.addLayer(
    {
      id: layerId,
      type: "raster",
      source: sourceId,
      layout: { visibility: "none" },
      paint: {
        "raster-opacity": 1,
        // Off by default: MapLibre's raster fade cross-dissolves through
        // transparent when an image source first paints, which reads as a
        // flash on a layer that is toggled per chapter.
        "raster-fade-duration": 0,
        ...paint
      }
    },
    beforeLayerId
  );
}

// Point the "vegetation" legend key at whichever rendering actually exists.
//
// The vector fill is added unconditionally and is the fallback; the raster is
// added only if its sidecar loaded. Swapping the ID list (rather than, say,
// adding both and hiding one) means exactly one of the two is ever visible, so
// they cannot double-darken each other where their edges disagree - and it
// keeps the manual legend toggle, the per-chapter scroll trigger and this
// choice all flowing through the same single table.
//
// Must run after initMap() has added the layers, since it is asserting which
// ones exist.
function resolveVegetationLayerIds(map) {
  if (map && map.getLayer(VEGETATION_LAYER_ID)) {
    LEGEND_LAYER_IDS.vegetation = [VEGETATION_LAYER_ID];
  } else {
    LEGEND_LAYER_IDS.vegetation = ["vegetation-fill"];
    if (vegetationMeta) {
      console.warn(
        "Vegetation raster sidecar loaded but its layer is missing - falling " +
          "back to the vector fill."
      );
    }
  }
}

// --- Shared contour / road line symbology -------------------------------
// Both the scroll-driven story map and the Explorer's second map instance
// draw the same contour and road layers, so the numbers live here once
// rather than being retyped (and drifting) in each addLayer() call.

// White casing drawn underneath each contour/road line so it reads cleanly
// over the vegetation and elevation fills, and so two lines crossing each
// other stay visually separable.
const LINE_HALO_COLOR = "#ffffff";
const LINE_HALO_OPACITY = 0.9;
const LINE_HALO_PAD = 1; // px the halo extends past each edge of the line

const CONTOUR_LINE_WIDTH = 1;

// Contours are generated at a 20 ft interval, so labels can only land on
// multiples of 20. 40 ft is the closest achievable step to the 30 ft asked
// for; drop this to 20 to label every single contour.
const CONTOUR_LABEL_INTERVAL_FT = 40;
const CONTOUR_LABEL_FILTER = [
  "==",
  ["%", ["get", "elev_ft"], CONTOUR_LABEL_INTERVAL_FT],
  0
];

// Through-streets and trails share one color and one width - the dot
// pattern is the only thing telling them apart.
const ROAD_COLOR = "#2b2f33";
const ROAD_LINE_WIDTH = 2;
const ROAD_LINE_OPACITY = 0.8;
const ROAD_HALO_WIDTH = ROAD_LINE_WIDTH + 2 * LINE_HALO_PAD;
const TRAIL_DASHARRAY = [0.1, 1.6];
// line-dasharray is measured in multiples of line-width, so the wider halo
// needs its own array scaled by the width ratio - otherwise its dots drift
// out of step with the dots they are supposed to sit behind.
const TRAIL_HALO_DASHARRAY = TRAIL_DASHARRAY.map(
  (n) => (n * ROAD_LINE_WIDTH) / ROAD_HALO_WIDTH
);

const ROAD_MAIN_FILTER = ["match", ["get", "highway"], ["tertiary", "residential"], true, false];
const ROAD_TRAIL_FILTER = ["match", ["get", "highway"], ["tertiary", "residential"], false, true];

// Adds the four road layers in one go: both halos first, then both lines,
// so a halo can never be painted over the line it belongs behind.
function addRoadLayers(map, ids) {
  const base = {
    type: "line",
    source: ids.source,
    layout: { visibility: "none", "line-cap": "round", "line-join": "round" }
  };

  map.addLayer({
    ...base,
    id: ids.haloMainId,
    filter: ids.mainFilter,
    paint: {
      "line-color": LINE_HALO_COLOR,
      "line-width": ROAD_HALO_WIDTH,
      "line-opacity": LINE_HALO_OPACITY
    }
  });
  map.addLayer({
    ...base,
    id: ids.haloTrailId,
    filter: ids.trailFilter,
    paint: {
      "line-color": LINE_HALO_COLOR,
      "line-width": ROAD_HALO_WIDTH,
      "line-opacity": LINE_HALO_OPACITY,
      "line-dasharray": TRAIL_HALO_DASHARRAY
    }
  });
  map.addLayer({
    ...base,
    id: ids.mainId,
    filter: ids.mainFilter,
    paint: {
      "line-color": ROAD_COLOR,
      "line-width": ROAD_LINE_WIDTH,
      "line-opacity": ROAD_LINE_OPACITY
    }
  });
  map.addLayer({
    ...base,
    id: ids.trailId,
    filter: ids.trailFilter,
    paint: {
      "line-color": ROAD_COLOR,
      "line-width": ROAD_LINE_WIDTH,
      "line-opacity": ROAD_LINE_OPACITY,
      "line-dasharray": TRAIL_DASHARRAY
    }
  });
}

function setMapLayerVisibility(layerKey, visible) {
  if (!mapInstance || !mapLayersReady) return;
  const ids = LEGEND_LAYER_IDS[layerKey] || [];
  ids.forEach((id) => {
    // getLayer guard, matching setExplorerLayerVisibility(). Needed because
    // the two image overlays are optional: if a sidecar 404s, their addLayer
    // never ran, and MapLibre v4's setLayoutProperty does NOT throw on a
    // missing layer - it fires an ErrorEvent and returns. That is worse than
    // throwing, because the graceful-degradation path then silently spams the
    // console on every single chapter change.
    if (!mapInstance.getLayer(id)) return;
    mapInstance.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
  });
}

// Homestead/CSA14 boundary paint states, keyed by whether the current
// chapter also shows the Marin County outline (chapter.layers.marin).
// Only "homestead-in-marin" is true - every other chapter showing the
// boundary uses the subtle black/transparent treatment instead.
const HOMESTEAD_BOUNDARY_STYLES = {
  // Resolved on read (not at module load) so the highlight tracks the active
  // theme's primary even when the reader switches theme mid-story.
  get marin() {
    const color = themeColor("primary", "#4ca08c");
    return { fillColor: color, fillOpacity: 0.55, lineColor: color, lineWidth: 2.5 };
  },
  default: { fillColor: "#000000", fillOpacity: 0.08, lineColor: "#000000", lineWidth: 2 },
  // Line-only (fill fully transparent) - used whenever a chapter stacks two
  // or more thematic layers (vegetation/elevation/contours/streets) on top
  // of the boundary, so it reads as a clean outline instead of a
  // translucent black wash muddying the colors underneath it. The boundary
  // LINE itself is also added last in initMap() (after every thematic
  // layer) so it's never visually buried regardless of fill state.
  lineOnly: { fillColor: "#000000", fillOpacity: 0, lineColor: "#000000", lineWidth: 2 }
};

function updateHomesteadBoundaryStyle(map, chapter) {
  currentBoundaryChapter = chapter;
  if (!map || !mapLayersReady) return;

  const layers = (chapter && chapter.layers) || {};
  // "hillshade" counts here even though it has no legend section. The point of
  // this list is "how much is already painted inside the boundary", and the
  // shade overlay paints the whole polygon - `default`'s 8% black wash on top
  // of it would just be a second, flatter darkening competing with a real one.
  const stackedThematicCount = [
    "vegetation",
    "elevation",
    "bivariate",
    "contours",
    "streets",
    "hillshade"
  ].filter((key) => layers[key]).length;

  // The bivariate layer forces lineOnly on its own, without needing a second
  // thematic layer stacked on it. Its whole point is that a reader can match
  // a fill against a 16-cell legend, and default's translucent black wash
  // would shift all 16 toward grey - most damagingly the light low/low corner,
  // which is already near-neutral by design.
  const style = layers.marin
    ? HOMESTEAD_BOUNDARY_STYLES.marin
    : stackedThematicCount >= 2 || layers.bivariate
      ? HOMESTEAD_BOUNDARY_STYLES.lineOnly
      : HOMESTEAD_BOUNDARY_STYLES.default;

  map.setPaintProperty("homestead-highlight-fill", "fill-color", style.fillColor);
  map.setPaintProperty("homestead-highlight-fill", "fill-opacity", style.fillOpacity);
  map.setPaintProperty("homestead-highlight-line", "line-color", style.lineColor);
  map.setPaintProperty("homestead-highlight-line", "line-width", style.lineWidth);

  // Keep the legend swatch honest - it should show whichever boundary
  // color is actually live on the map right now, not a fixed color baked
  // into chapters.json. It's a line-style swatch (see renderLegendShell()),
  // so the color goes on border-top, not background.
  //
  // Scoped to #legend: the Block Explorer renders its own .legend-section
  // blocks with the same data-layer attributes, and a document-wide selector
  // repaints its swatches to match whatever the SCROLL map's current chapter
  // is doing - which is a different map with a different boundary treatment.
  // (renderExplorerLegend's own updaters scope to #explorer-legend-sections
  // for exactly this reason.)
  const swatch = document.querySelector(
    '#legend .legend-section[data-layer="homesteadHighlight"] .legend-swatch'
  );
  if (swatch) swatch.style.borderTopColor = style.lineColor;
}

// Vegetation/elevation use their own fixed green/hypsometric ramps
// (documented in the legend) at fairly high opacity - see the "vegetation"/
// "elevation-fill" addLayer calls in initMap(). One chapter needs those SAME
// two layers backed off:
//   - "reduced" (chapter.reducedOpacity: true) - the "Why Homestead Is
//     Different" chapter shows every layer together, backed off to <=50%
//     opacity so none of them visually competes with the others.
// Every other chapter keeps the original ramps/opacity untouched.
//
// There used to be a third mode here, "bivariate": the intervention chapter
// recolored these two layers to a red ramp and a blue ramp at 30% opacity
// each and let the translucent fills blend toward purple where they
// overlapped. That treatment is gone, replaced by the real bivariate layer
// below, because stacked transparency cannot deliver what a bivariate map
// is for. Two independent 4-class ramps composited at 30% produce a
// continuum of muddy colors, not 16 identifiable ones; the reader cannot
// invert a given purple back into a (fuel, elevation) pair; and no legend
// can honestly enumerate the result. It also could not have shown a 4-step
// elevation axis, since the hypsometric layer has 8 classes.
const VEGETATION_RAMP_NORMAL = [
  "match", ["get", "ndvi_class"],
  1, "#d9f0a3", 2, "#78c679", 3, "#31a354", 4, "#006837",
  "#cccccc"
];
const ELEVATION_RAMP_NORMAL = [
  "match", ["get", "elev_class"],
  1, "#F0F0F0", 2, "#D9D9D9", 3, "#BDBDBD", 4, "#969696",
  5, "#737373", 6, "#525252", 7, "#353535", 8, "#1A1A1A",
  "#cccccc"
];

// --- Bivariate fuel x elevation ------------------------------------------
// A TRUE bivariate choropleth: one layer, one polygon per contiguous joint
// class, each carrying a single integer `bv` that encodes both class values
// as bv = (veg_class - 1) * 4 + elev_class. That encoding is what lets the
// paint expression be one flat "match" on one attribute instead of a nested
// 4x4 decision tree, and it is asserted feature-by-feature by
// bivariate_work/04_qa_bivariate.py (check 1).
//
// Colors are the 4x4 matrix from bivariate_work/02_palette.py - bilinear in
// sRGB between four hand-picked corners (neutral / red = fuel / blue =
// elevation / dark plum = both), verified luminance-monotonic along every row
// and column so "more of either factor" always reads as darker. They are
// transcribed here from bivariate_palette.json's by_bv_code block, and the
// same values are baked into each feature's `fill_color` property in the
// GeoJSON, so a mismatch between this expression and the data is detectable
// rather than silent (04's check 2 re-derives the matrix from the corners
// independently and compares against the file).
const BIVARIATE_FILL_COLOR = [
  "match", ["get", "bv"],
  // veg 1 (Sparse)      elev 1 -> 4
  1, "#e4e2dd", 2, "#a8bccb", 3, "#6b95ba", 4, "#2f6fa8",
  // veg 2 (Moderate)
  5, "#d4a3a2", 6, "#a08a9b", 7, "#6c7194", 8, "#38588c",
  // veg 3 (Dense)
  9, "#c36367", 10, "#98586a", 11, "#6c4d6d", 12, "#414271",
  // veg 4 (Very dense)
  13, "#b3242c", 14, "#90263a", 15, "#6d2947", 16, "#4a2b55",
  "#cccccc"
];
// High enough that each fill stays close to its legend chip, low enough that
// Positron's street lines and place labels still read through it. The
// compositing shift is small BECAUSE Positron's land is near-white, the same
// surface the legend chips sit on - so the same 0.85 that keeps the map
// readable also keeps map and legend showing effectively the same color.
// This is the one place transparency is acceptable in a bivariate map: it is
// uniform across all 16 classes, so it cannot make two classes converge.
const BIVARIATE_FILL_OPACITY = 0.85;

// Pulls the plain hex colors back out of a ["match", ["get", field], class1,
// color1, class2, color2, ..., defaultColor] paint expression, in class order
// (skipping the trailing default fallback), and pushes them onto that
// layer's legend swatches - the same "keep the legend honest" idea used for
// the homestead boundary swatch above.
//
// These two functions existed to swap the vegetation/elevation swatches
// between their normal and (now removed) pseudo-bivariate ramps. With one
// ramp per layer they no longer switch anything, but they are kept because
// they make the MAP the single source of truth for those swatch colors: if
// the ramps above and the colors authored in chapters.json ever drift apart,
// the legend follows the map rather than quietly describing a color that
// isn't on screen. They are deliberately NOT used for the bivariate matrix,
// whose colors are checked against the data by 04_qa_bivariate.py instead.
function extractRampColors(rampExpression) {
  const colors = [];
  for (let i = 3; i < rampExpression.length - 1; i += 2) {
    colors.push(rampExpression[i]);
  }
  return colors;
}

// Scoped to #legend for the same reason as the boundary swatch above - the
// Explorer's legend uses identical markup and must not be driven by the scroll
// map's chapter state.
function applyLegendSwatchColors(layerKey, colors) {
  const swatches = document.querySelectorAll(
    `#legend .legend-section[data-layer="${layerKey}"] .legend-swatch`
  );
  swatches.forEach((swatch, i) => {
    if (colors[i]) swatch.style.background = colors[i];
  });
}

// Fill opacity is INDEPENDENT of the relief, and that is the real dividend of
// moving the shade on top.
//
// Before, the hillshade was underneath, so the only route relief had to the
// reader was the fills' transparency - which is why this used to be a 0.6
// CEILING. Colour and terrain were in direct competition and you had to give
// up some of one to get the other.
//
// A first pass at v18 inverted that into a 0.92 FLOOR, on the reasoning that
// since `result = fill x (1 - a)` preserves relief contrast at any fill
// opacity, transparency now buys nothing but a diluted class colour. The
// premise is right; the conclusion was not. Transparency was never only a
// carrier for the hillshade - it also lets Positron's street grid and place
// labels read through, which is how a reader finds their own block, and it
// keeps the dark end of each ramp off the floor of the tone range, where a 50%
// multiply has nothing left to darken. At 0.92 the "very dense" green went
// nearly black under shadow and the relief stopped reading inside it.
//
// So: no floor, no ceiling. The shade handles relief, these defaults handle
// legibility, and the two no longer trade against each other.
function updateThematicLayerStyle(map, chapter) {
  if (!map || !mapLayersReady) return;

  // "reduced" is set on one chapter, "Why Homestead Is Different", which stacks
  // vegetation, elevation, streets and shade at once and needs none of them to
  // dominate. Note its softer look comes as much from the greyscale elevation
  // wash underneath the vegetation as from the opacity itself - a chapter
  // without that layer will read lighter and more pastel at the same number,
  // not darker and greyer, because reducing opacity blends toward the near-
  // white basemap rather than toward grey.
  const mode = chapter && chapter.reducedOpacity ? "reduced" : "default";

  map.setPaintProperty("vegetation-fill", "fill-color", VEGETATION_RAMP_NORMAL);
  const vegOpacity = mode === "reduced" ? 0.5 : 0.6;
  map.setPaintProperty("vegetation-fill", "fill-opacity", vegOpacity);
  // The raster overlay replaces the vector fill wherever it loaded (see
  // resolveVegetationLayerIds), so it takes the same opacity - one dial, so the
  // two renderings of the same classification can never look like two
  // different datasets.
  if (map.getLayer(VEGETATION_LAYER_ID)) {
    map.setPaintProperty(VEGETATION_LAYER_ID, "raster-opacity", vegOpacity);
  }
  applyLegendSwatchColors("vegetation", extractRampColors(VEGETATION_RAMP_NORMAL));

  map.setPaintProperty("elevation-fill", "fill-color", ELEVATION_RAMP_NORMAL);
  map.setPaintProperty(
    "elevation-fill",
    "fill-opacity",
    mode === "reduced" ? 0.5 : 0.75
  );
  applyLegendSwatchColors("elevation", extractRampColors(ELEVATION_RAMP_NORMAL));

  // One fade factor for the whole road stack, so the white halos dim in step
  // with the lines they sit behind - fading only the lines would leave the
  // halos reading as solid white streaks on a "reduced" chapter.
  const roadFade = mode === "reduced" ? 0.7 : 1;
  ["streets-line-main", "streets-line-trail"].forEach((id) => {
    map.setPaintProperty(id, "line-opacity", ROAD_LINE_OPACITY * roadFade);
  });
  ["streets-halo-main", "streets-halo-trail"].forEach((id) => {
    map.setPaintProperty(id, "line-opacity", LINE_HALO_OPACITY * roadFade);
  });
}

// --- Wind arrows --------------------------------------------------------
// Schematic Diablo (offshore, NE->SW) and reverse (onshore, SW->NE) wind
// arrows. They're decorative annotations rather than a data layer, so they
// ride on MapLibre markers instead of going through
// LEGEND_LAYER_IDS/setMapLayerVisibility - but being markers (not a fixed
// HTML overlay) they stay pinned to the ground as the reader pans and
// zooms. All of them appear/disappear together on chapter.layers.wind.
//
// They also DRIFT: each arrow slides along its own heading and fades out,
// looping, so the pair of fans animates like moving air. The brief asks for
// this explicitly ("pulsing arrows ideally or slightly advancing in the
// wind direction").
//
// The animation runs on the <svg> INSIDE the marker element, never on the
// marker element itself. MapLibre writes `transform` on the marker root on
// every render to place and rotate it, so any transform of ours there is
// overwritten (and would fight the map's own positioning). The child is
// untouched by MapLibre and inherits the parent's rotation for free, which
// is what makes a plain translateY on it travel downwind: the SVG is drawn
// pointing up (tip at y=1), so its local -Y is wherever the marker's
// `rotation: bearing` is aimed.
const WIND_ARROWS_PER_SIDE = 4;

// --- Flow field -----------------------------------------------------------
// Each scenario is a curved FLOW FIELD rather than a block of parallel
// chevrons: its four arrows are spread right across Homestead and their
// headings rotate progressively from one side of the valley to the other, so
// the set reads as air bending through the terrain. The bearings are the
// editorial content - they are the regional geography:
//
//   diablo   Offshore. Spills down off the Great Basin / Nevada side on a
//            roughly SSW heading, then bends west as it drops to the coast
//            and runs out over the Pacific. 208 -> 252.
//   reverse  Onshore. Comes in off the Pacific heading ENE, then bends left
//            and straightens to very nearly due north, up the corridor
//            toward Mill Valley. 58 -> 5.
//
// Only the SHAPE is geographic. The arrows stay inside the homestead frame -
// they annotate which way the air is going as it passes through here, they
// are not a journey that begins in Nevada or ends in Mill Valley.
const WIND_FLOWS = [
  { side: "diablo", bearingIn: 208, bearingOut: 252 },
  { side: "reverse", bearingIn: 58, bearingOut: 5 }
];

// --- The rank -------------------------------------------------------------
// All eight arrows sit on one line across the valley, INTERLEAVED - orange,
// blue, orange, blue - so each one has a neighbour of the other colour on
// either side and both scenarios span the whole of Homestead instead of
// clustering in opposite corners.
//
// The bearing of the rank is the load-bearing number. It is set ACROSS the
// wind axis (the two scenarios average out to roughly a 40/220 axis, so its
// perpendicular is about 130), never along it. That is what keeps the
// animation clean: neighbouring arrows are offset along the rank while they
// drift perpendicular to it in opposite directions, so a pair always slides
// APART rather than along the rank into each other. A rank laid along the
// wind axis would have every arrow drifting straight at its neighbour.
//
// 118 rather than a true 130 is the compromise the bbox forces: Homestead is
// about 1.6x wider than it is tall, so a steeper rank cannot span the width
// without running off the top and bottom edges. 118 still clears the blue
// fan's mean heading by 86 degrees and the orange fan's by 112.
//
// Length is in bbox HEIGHTS (height being the scarce axis on a wide bbox),
// measured about the centre of the bbox.
const WIND_RANK_BEARING = 118;
const WIND_RANK_LENGTH = 1.63;
const WIND_RANK_CENTER = [0.5, 0.5];

// How much of the fan's total bend an arrow sweeps through during one drift
// cycle, as a fraction. An arrow travels about one of its own lengths per
// cycle, which is a small slice of the whole field, so it should turn by a
// correspondingly small slice of the whole bend - a few degrees. That bank is
// what keeps the motion reading as curved rather than as a rigid chevron
// sliding down a diagonal.
const WIND_CURL_SHARE = 0.14;

// --- Drift animation timing ---------------------------------------------
// Each arrow slides along its own heading and fades at both ends, so the
// fan reads as air moving through the valley rather than as eight pins
// stuck in it. The motion itself is CSS (see @keyframes wind-drift); what
// is set here is only the per-arrow PHASING, because that is what stops
// eight identical loops from pulsing in unison and reading as a blinking
// decoration.
//
// Two independent knobs, both written onto the marker element as custom
// properties and inherited by the <svg> the animation actually runs on:
//
//   --wind-duration  spread slightly per arrow, so the fan drifts out of
//                    phase over time instead of ticking like a metronome.
//   --wind-delay     NEGATIVE, which starts each arrow already part-way
//                    through its cycle. A positive delay would park every
//                    arrow at its un-animated resting state and then have
//                    them all lurch into motion as the chapter scrolls in;
//                    negative means the fan is already mid-flight the
//                    instant it becomes visible.
const WIND_DRIFT_BASE_S = 3.6;
const WIND_DRIFT_SPREAD_S = 0.22;

// --- Crowding guard -------------------------------------------------------
// WIND_ARROWS_PER_SIDE is the number we WANT, not the number we always get.
// The arrows are a fixed pixel size (they are UI, not geography), but the
// rank they sit on is geographic, so it shrinks with the map panel: on a
// 1440px window the rank is ~866px long and neighbours sit ~124px apart,
// while on a 375px phone the same rank is ~190px and the gap collapses to
// ~27px. At that spacing eight arrows do not merely look tight - each one
// travels about one of its own lengths per drift cycle, so they pass clean
// through each other, which is exactly what the interleave exists to
// prevent.
//
// So the count is derived from the rank's measured on-screen length rather
// than assumed. 92px is the smallest neighbour gap that still clears, and
// it was measured, not guessed: a swept simulation of the full drift cycle
// (every pair, every phase, arrows treated as their full bounding boxes)
// puts the overlap threshold at ~88px, so 92 is that plus a little air.
//
// The practical effect is a graceful ladder rather than a mobile hack -
// 4 per side above ~1020px wide, then 2, then a single pair on a phone.
// Both scenarios stay represented and interleaved at every step.
const WIND_MIN_ARROW_GAP_PX = 92;

// The wind chapter frames the homestead layer through flyToChapter(), which
// falls back to this padding when a chapter doesn't override it. Shared so
// the crowding guard measures the rank at the same camera the reader gets -
// if these two ever disagreed the guard would be sizing for a view that
// never appears.
const MAP_FIT_PADDING = 60;
const WIND_FIT_PADDING = MAP_FIT_PADDING;

const windArrowElements = [];
const windArrowMarkers = [];
let windArrowsPerSide = 0;

function windArrowSvg(gradientId) {
  return `<svg viewBox="0 0 34 62" xmlns="http://www.w3.org/2000/svg">
    <linearGradient id="${gradientId}" x1="17" y1="1" x2="17" y2="55.5" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="currentColor" stop-opacity="1"/>
      <stop offset="0.45" stop-color="currentColor" stop-opacity="0.82"/>
      <stop offset="1" stop-color="currentColor" stop-opacity="0.22"/>
    </linearGradient>
    <path d="M17 1 L31.5 19.5 L21.5 19.5 C22.8 31 24.5 43 25.5 55.5 L8.5 55.5 C9.5 43 11.2 31 12.5 19.5 L2.5 19.5 Z"
          fill="url(#${gradientId})" stroke="rgba(255,255,255,0.9)" stroke-width="1.1" stroke-linejoin="round"/>
  </svg>`;
}

// Normalised bbox space is NOT square on the ground: at Marin's latitude a
// degree of longitude is only ~0.79 of a degree of latitude, and the bbox
// itself is not 1:1 either. `aspect` is the bbox's true ground width over its
// true ground height, and it is what lets WIND_RANK_BEARING be an honest
// compass bearing. Without this correction the rank would be sheared by the
// bbox's proportions and would no longer sit across the wind axis - which is
// the one property the whole interleaved layout depends on.
function windBboxAspect(bounds) {
  const [[west, south], [east, north]] = bounds;
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  return ((east - west) * Math.cos(midLat)) / (north - south);
}

// A step of length `len` (in bbox heights) along true bearing `deg`,
// expressed in normalised bbox coordinates.
function windBearingStep(deg, len, aspect) {
  const rad = (deg * Math.PI) / 180;
  return [(len * Math.sin(rad)) / aspect, len * Math.cos(rad)];
}

// Where slot `u` (0 at one end of the rank, 1 at the other) falls, as real
// coordinates. The rank is measured out from the centre of the bbox along
// WIND_RANK_BEARING, so u - 0.5 is the signed distance from the middle.
function windRankLngLat(u, bounds, aspect) {
  const [dx, dy] = windBearingStep(
    WIND_RANK_BEARING,
    WIND_RANK_LENGTH * (u - 0.5),
    aspect
  );
  const [[west, south], [east, north]] = bounds;
  return [
    west + (WIND_RANK_CENTER[0] + dx) * (east - west),
    south + (WIND_RANK_CENTER[1] + dy) * (north - south)
  ];
}

// Web-Mercator unit square (0..1 both axes), which is what a zoom level
// scales by 512 * 2^z to get pixels.
function windMercator(lngLat) {
  const [lng, lat] = lngLat;
  const s = Math.sin((lat * Math.PI) / 180);
  return [
    (lng + 180) / 360,
    0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
  ];
}

// How long the rank is, in pixels, AT THE CAMERA THE WIND CHAPTER WILL GET.
// Deliberately not map.project() against the live camera: the arrows are
// built once at start-up, when the map is still parked in the first chapter
// (a county-wide overview), so projecting then would measure the rank at a
// zoom it is never actually seen at and conclude that nothing fits.
// cameraForBounds answers the question that matters - what will this panel
// look like once it has flown here - and it reads the current canvas size,
// so it tracks the panel through resizes and fullscreen for free.
function windRankPixels(map, bounds, aspect) {
  const cam = map.cameraForBounds(bounds, { padding: WIND_FIT_PADDING });
  if (!cam) return 0;
  const a = windMercator(windRankLngLat(0, bounds, aspect));
  const b = windMercator(windRankLngLat(1, bounds, aspect));
  return Math.hypot(b[0] - a[0], b[1] - a[1]) * 512 * Math.pow(2, cam.zoom);
}

// How many arrows per scenario that length can hold without the drift
// cycles running through each other.
function windArrowsThatFit(map, bounds, aspect) {
  const rankPx = windRankPixels(map, bounds, aspect);
  if (!rankPx) return WIND_ARROWS_PER_SIDE;

  // slots = 2 * perSide and the slots are half-step inset, so the neighbour
  // gap is rankPx / slots. Solving gap >= WIND_MIN_ARROW_GAP_PX for perSide.
  const fits = Math.floor(rankPx / (2 * WIND_MIN_ARROW_GAP_PX));
  return Math.max(1, Math.min(WIND_ARROWS_PER_SIDE, fits));
}

function buildWindArrows(map, bounds, perSide) {
  if (!bounds) return;

  const aspect = windBboxAspect(bounds);
  if (!perSide) perSide = windArrowsThatFit(map, bounds, aspect);

  // Rebuilt rather than mutated on resize, so clear out the previous set
  // first. Markers must be removed through MapLibre, not just dropped from
  // the array - it keeps its own list and would go on repositioning
  // orphaned elements on every render.
  windArrowMarkers.splice(0).forEach((m) => m.remove());
  windArrowElements.length = 0;
  windArrowsPerSide = perSide;

  const slots = WIND_FLOWS.length * perSide;

  // One pass over the whole rank, alternating colour every slot. Walking the
  // slots rather than looping per fan is what produces the interleave: slot
  // 0 is orange, 1 blue, 2 orange, and so on, so no arrow ever has a
  // same-colour immediate neighbour.
  for (let slot = 0; slot < slots; slot++) {
    const flow = WIND_FLOWS[slot % WIND_FLOWS.length];
    const i = Math.floor(slot / WIND_FLOWS.length);

    // Half-step in from each end, so the rank is spread across the valley
    // rather than bunched at its tips.
    const u = (slot + 0.5) / slots;
    const lngLat = windRankLngLat(u, bounds, aspect);

    // Heading rotates with position ACROSS the valley, not with the arrow's
    // index within its own fan - so both fans describe one continuous
    // curving field over the same ground, which is what lets them interleave
    // and still read as two coherent flows.
    const bearing = flow.bearingIn + u * (flow.bearingOut - flow.bearingIn);

    // Signed, so an arrow banks the way its own fan actually turns: diablo
    // bends right (208 -> 252), reverse bends left (58 -> 5).
    const curl = (flow.bearingOut - flow.bearingIn) * WIND_CURL_SHARE;

    const el = document.createElement("div");
    el.className = `wind-arrow wind-arrow-${flow.side}`;
    el.innerHTML = windArrowSvg(`wind-grad-${flow.side}-${i}`);

    // The two fans are half a step out of phase with each other as well as
    // within themselves; syncing them would read as one pulsing graphic
    // rather than two independent wind scenarios. The quarter/three-quarter
    // offsets also keep every phase off zero - a phase of exactly 0 is the
    // one value that defeats the negative delay, parking that arrow at the
    // 0% keyframe (opacity 0) so it alone fades up from nothing while its
    // neighbours are already in flight.
    const duration = WIND_DRIFT_BASE_S + i * WIND_DRIFT_SPREAD_S;
    const phase = (i + (flow.side === "reverse" ? 0.75 : 0.25)) / perSide;
    el.style.setProperty("--wind-duration", `${duration.toFixed(2)}s`);
    el.style.setProperty("--wind-delay", `${(-phase * duration).toFixed(2)}s`);

    // Straddles the arrow's static heading rather than starting from it, so
    // the mid-point of the drift is the heading the field actually has at
    // this spot and the bank reads as following through the turn.
    el.style.setProperty("--wind-curl-in", `${(-curl / 2).toFixed(2)}deg`);
    el.style.setProperty("--wind-curl-out", `${(curl / 2).toFixed(2)}deg`);

    const marker = new maplibregl.Marker({
      element: el,
      rotation: bearing,
      rotationAlignment: "map",
      pitchAlignment: "map"
    })
      .setLngLat(lngLat)
      .addTo(map);

    windArrowMarkers.push(marker);
    windArrowElements.push(el);
  }
}

// Re-checks the crowding guard after anything that can change the map
// panel's size, and rebuilds only when the verdict actually changes. The
// guard on the count is what makes this cheap enough to hang off a resize
// listener: dragging a window edge crosses the same verdict hundreds of
// times and rebuilds on none of them.
function syncWindArrows(map, bounds) {
  if (!bounds || !windArrowElements.length) return;
  const perSide = windArrowsThatFit(map, bounds, windBboxAspect(bounds));
  if (perSide === windArrowsPerSide) return;

  // The arrows are only shown on wind chapters, and a rebuild starts them
  // hidden, so carry the current state across or they would silently
  // vanish if the reader resized while standing in one.
  const wasVisible = windArrowElements[0].classList.contains("visible");
  buildWindArrows(map, bounds, perSide);
  if (wasVisible) {
    windArrowElements.forEach((el) => el.classList.add("visible"));
  }
}

function updateWindIndicator(chapter) {
  const on = Boolean(chapter && chapter.layers && chapter.layers.wind);
  const key = document.getElementById("wind-indicator");
  if (key) key.classList.toggle("visible", on);
  windArrowElements.forEach((el) => el.classList.toggle("visible", on));
}

// --- Theme (colors + fonts) -----------------------------------------------
// Applied as CSS custom properties so css/style.css can reference
// var(--color-primary), var(--font-heading), etc. Falls back to whatever
// defaults are already declared on :root in style.css if chapters.json
// doesn't supply a theme block.
//
// chapters.json carries a "themes" registry plus an "activeTheme" key. The
// selected name resolves in this order, first hit wins:
//   1. ?theme=<name> in the URL        - one-off share/preview link
//   2. localStorage                    - the reader's own switcher choice
//   3. config.activeTheme              - the committed default
const THEME_STORAGE_KEY = "storymap-theme";
let THEMES = {};
let activeThemeName = null;

function resolveThemeName(config) {
  const available = Object.keys(config.themes || {});
  if (!available.length) return null;

  const fromUrl = new URLSearchParams(location.search).get("theme");
  if (fromUrl && available.includes(fromUrl)) return fromUrl;

  // localStorage throws in private-mode Safari and when the page is opened
  // from a file:// URL in some browsers - a missing preference is never fatal.
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_STORAGE_KEY);
  } catch (err) {
    stored = null;
  }
  if (stored && available.includes(stored)) return stored;

  if (config.activeTheme && available.includes(config.activeTheme)) {
    return config.activeTheme;
  }
  return available[0];
}

// Each theme names its own Google Fonts pairing. Rather than making every
// visitor download every registered pairing up front, a theme's stylesheet is
// injected the first time that theme is applied (index.html statically loads
// only the default pairing, so first paint is never blocked). With Serpentine
// the sole registered theme this is a no-op - its pairing IS the static one -
// but it keeps adding a second theme a chapters.json edit, not a code change.
function ensureThemeFonts(href) {
  if (!href) return;
  const existing = document.querySelector(`link[data-theme-font="${href}"]`);
  if (existing) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.themeFont = href;
  document.head.appendChild(link);
}

// The five map-facing colours live in chapters.json because MapLibre reads
// them back through themeColor(). Everything else a theme changes - page
// background, surface treatment, scrim, nav, rules - is a block of custom
// properties in the stylesheet, which is why the theme's *name* has to land
// on the root element too: Serpentine's set is :root itself, and any theme
// added later overrides it from an html[data-theme="..."] block.
function applyTheme(theme, name) {
  if (!theme) return;
  const root = document.documentElement;

  if (name) root.dataset.theme = name;

  Object.entries(theme.colors || {}).forEach(([name, value]) => {
    root.style.setProperty(`--color-${name}`, value);
  });

  const fonts = theme.fonts || {};
  if (fonts.heading) root.style.setProperty("--font-heading", fonts.heading);
  if (fonts.body) root.style.setProperty("--font-body", fonts.body);

  ensureThemeFonts(theme.fontsHref);
}

// Reads a resolved theme colour back out of the cascade. The MapLibre layers
// need real colour strings (they can't consume CSS custom properties), so they
// ask for the computed value instead of hardcoding hexes that would drift out
// of sync with the active theme.
function themeColor(name, fallback) {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--color-${name}`)
    .trim();
  return value || fallback;
}

// --- Community Center landmark ---
const COMMUNITY_CENTER_POINT_URL = "data/home_stead_community_center.json";
const COMMUNITY_CENTER_ICON_ID = "community-center-pin";

function communityCenterColor() {
  return themeColor("secondary", "#dd8a3e");
}

// Draws a Material-style "place" teardrop into an offscreen canvas and hands
// back raw RGBA for map.addImage().
//
// Rendered rather than shipped as an SDF or a PNG for one reason: it has to
// be re-tintable. An SDF can be tinted via `icon-color`, but an SDF is
// single-channel, so it would lose the white casing and the white centre dot
// - and those are what keep the pin legible over the dark end of the
// elevation ramp and the near-black corner of the bivariate surface. Drawing
// it means a theme switch can just re-draw at the new colour (see
// ensureCommunityCenterIcon).
//
// Geometry: a circle of radius R centred at (CX, CY) with the two tangent
// lines from the tip at (CX, TIP_Y). The tangent points sit at
// acos(R/d) either side of the centre->tip direction, which is what makes
// the head meet the point with no crease.
function createPinImage(color, scale) {
  const W = 26;
  const H = 34;
  const CX = 13;
  const CY = 13;
  const R = 8;
  const TIP_Y = 31;

  const canvas = document.createElement("canvas");
  canvas.width = W * scale;
  canvas.height = H * scale;
  const ctx = canvas.getContext("2d");
  ctx.scale(scale, scale);

  const d = TIP_Y - CY;
  const theta = Math.acos(R / d);
  // Canvas angles: 0 = +x, increasing clockwise on screen (y points down),
  // so 90 deg = straight down = the direction of the tip.
  const down = Math.PI / 2;
  const startAngle = down + theta; // left tangent point
  const endAngle = down - theta + Math.PI * 2; // right tangent point, the long way round (over the top)

  ctx.beginPath();
  ctx.moveTo(CX, TIP_Y);
  ctx.arc(CX, CY, R, startAngle, endAngle);
  ctx.closePath();

  // White casing first, as a thick stroke under the fill, so the pin keeps a
  // hard edge against dark fills without the outline eating into its shape.
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#ffffff";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.fill();

  // Centre dot - the "places" read. White, not a knocked-out hole: a hole
  // would show whatever fill is underneath and stop reading as a pin on the
  // busier maps.
  ctx.beginPath();
  ctx.arc(CX, CY, 3, 0, Math.PI * 2);
  ctx.fillStyle = "#ffffff";
  ctx.fill();

  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

// Adds the pin on first call, re-tints it on every call after that.
// `pixelRatio: 2` tells MapLibre the bitmap is double-density, so the pin
// lands at ~26x34 CSS px and stays crisp on retina.
function ensureCommunityCenterIcon(map) {
  if (!map) return;
  const image = createPinImage(communityCenterColor(), 2);
  if (map.hasImage(COMMUNITY_CENTER_ICON_ID)) {
    map.updateImage(COMMUNITY_CENTER_ICON_ID, image);
  } else {
    map.addImage(COMMUNITY_CENTER_ICON_ID, image, { pixelRatio: 2 });
  }
}

// Block Explorer outlines: secondary marks the selected block, accent the rest.
function explorerBlockLineColor() {
  return [
    "case",
    ["boolean", ["feature-state", "selected"], false], themeColor("secondary", "#dd8a3e"),
    themeColor("accent", "#5f9ec9")
  ];
}

// The themed MapLibre paint properties are baked in as literal colour strings
// when each layer is added, so switching theme after load has to push the new
// values back onto the live layers. Everything else on the map (vegetation
// classes, elevation ramp, contour brown) is deliberately untouched: those are
// data encodings described by the legend, not branding.
function restyleMapForTheme() {
  [mapInstance, explorerMapInstance].forEach((instance) => {
    if (!instance || !instance.isStyleLoaded()) return;
    const setPaint = (layerId, prop, value) => {
      if (instance.getLayer(layerId)) instance.setPaintProperty(layerId, prop, value);
    };
    setPaint("explorer-blocks-line", "line-color", explorerBlockLineColor());
    setPaint("explorer-blocks-label", "text-color", themeColor("dark", "#0d1917"));
    setPaint("contours-label", "text-halo-color", themeColor("light", "#e9f1ee"));
    setPaint("explorer-contours-label", "text-halo-color", themeColor("light", "#e9f1ee"));
  });
  // The pin is a drawn bitmap, not a paint property, so it has to be
  // re-rendered at the new accent rather than re-set. Only the scroll map
  // carries it - the Block Explorer is deliberately excluded (see
  // chapters.json / the communityCenter layer key).
  if (mapInstance && mapInstance.isStyleLoaded()) {
    ensureCommunityCenterIcon(mapInstance);
  }
  updateCommunityCenterLegendSwatches();
  // Re-runs the boundary paint for whatever chapter is on screen, which is
  // what picks up the new primary for the Marin-context highlight.
  if (mapInstance && currentBoundaryChapter) {
    updateHomesteadBoundaryStyle(mapInstance, currentBoundaryChapter);
  }
}

// The Community Center legend rows are themed, so their swatch colours
// cannot be baked into chapters.json the way the data ramps are. Same
// approach as the homesteadHighlight swatch in updateHomesteadBoundaryStyle:
// repaint from the live theme, scoped to #legend so the Block Explorer's own
// legend (which renders the same data-layer attributes) is never touched.
function updateCommunityCenterLegendSwatches() {
  const color = communityCenterColor();
  document
    .querySelectorAll('#legend .legend-section[data-layer="communityCenter"] .legend-swatch')
    .forEach((swatch) => {
      if (
        swatch.classList.contains("legend-swatch-pin") ||
        swatch.classList.contains("legend-swatch-fill")
      ) {
        swatch.style.background = color;
      } else {
        swatch.style.borderTopColor = color;
      }
    });
}

// Switcher entry point: apply, persist, and restyle the already-built map.
function setActiveTheme(name) {
  const theme = THEMES[name];
  if (!theme) return;
  activeThemeName = name;
  applyTheme(theme, name);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, name);
  } catch (err) {
    /* preference is best-effort only */
  }
  document.querySelectorAll(".theme-option").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.theme === name);
    btn.setAttribute("aria-checked", String(btn.dataset.theme === name));
  });
  restyleMapForTheme();
}

// --- Icons ------------------------------------------------------------
// Small hand-drawn inline SVGs (no icon-library dependency, no build step).
// Each draws in a 24x24 box and inherits color via currentColor, so it
// picks up whatever text color/theme color surrounds it in CSS.
const ICONS = {
  flame: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2c1 3-3 4-3 8a3 3 0 0 0 6 0c0-1-.5-2-1-2.5 1.5 1 3 3 3 5.5a5 5 0 0 1-10 0c0-4 2-5.5 3-8.5.4-1.2.7-2 2-2.5z" fill="currentColor"/>
  </svg>`,
  "map-pin": `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 22s7-7.2 7-12.5A7 7 0 0 0 5 9.5C5 14.8 12 22 12 22z" fill="currentColor"/>
    <circle cx="12" cy="9.5" r="2.6" fill="#fff"/>
  </svg>`,
  home: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 11.5 12 4l9 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M5.5 10v9a1 1 0 0 0 1 1H9v-5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V20h2.5a1 1 0 0 0 1-1v-9" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  tree: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2 7 9h2.5L6 15h4v6h4v-6h4l-3.5-6H17z" fill="currentColor"/>
  </svg>`,
  wind: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 8h11a2.5 2.5 0 1 0-2.2-3.7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M3 12h15a2.5 2.5 0 1 1-2.2 3.7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
    <path d="M3 16h9a2.5 2.5 0 1 1-2.2 3.7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  </svg>`,
  shield: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 2 4 5v6c0 5 3.4 8.7 8 11 4.6-2.3 8-6 8-11V5l-8-3z" fill="currentColor"/>
    <path d="M8.5 12.2 11 14.7l4.8-5.2" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  mountain: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M3 20 9 8l4 6 2-3 6 9H3z" fill="currentColor"/>
  </svg>`,
  layers: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M12 3 2 9l10 6 10-6-10-6z" fill="currentColor"/>
    <path d="M2 15l10 6 10-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`,
  route: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M5 21 9 3h6l4 18" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M12 3v18" stroke="currentColor" stroke-width="2" stroke-dasharray="2 3" stroke-linecap="round"/>
  </svg>`,
  footprints: `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <ellipse cx="8" cy="7" rx="2.4" ry="3.2" fill="currentColor"/>
    <ellipse cx="16" cy="14" rx="2.4" ry="3.2" fill="currentColor"/>
    <circle cx="8" cy="12.2" r="1.1" fill="currentColor"/>
    <circle cx="16" cy="19.2" r="1.1" fill="currentColor"/>
  </svg>`
};

function renderIcon(name) {
  if (!name || !ICONS[name]) return "";
  return `<span class="icon icon-${name}" aria-hidden="true">${ICONS[name]}</span>`;
}

// --- YouTube URL parsing -----------------------------------------------
// Accepts any common YouTube URL shape (watch, youtu.be, shorts, embed)
// pasted straight from a browser address bar and returns just the video ID.
function parseYouTubeId(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) {
      return u.pathname.slice(1);
    }
    if (u.pathname.startsWith("/shorts/")) {
      return u.pathname.split("/shorts/")[1];
    }
    if (u.pathname.startsWith("/embed/")) {
      return u.pathname.split("/embed/")[1];
    }
    if (u.searchParams.get("v")) {
      return u.searchParams.get("v");
    }
  } catch (e) {
    return null;
  }
  return null;
}

// --- Media (images/videos) -------------------------------------------------
// A chapter can carry one or more media items, each either an image or a
// video (local file and/or YouTube embed). The legacy single "image"/"video"
// chapter fields are normalized into that same array shape so both old and
// new chapters.json entries render through the one carousel implementation.
function normalizeMedia(chapter) {
  if (Array.isArray(chapter.media) && chapter.media.length) return chapter.media;

  const media = [];
  if (chapter.image) {
    media.push({ type: "image", ...chapter.image });
  }
  if (chapter.video) {
    if (chapter.video.localSrc) {
      media.push({
        type: "video",
        localSrc: chapter.video.localSrc,
        caption: "Local video embed (client-supplied file)"
      });
    }
    if (chapter.video.youtubeUrl) {
      media.push({
        type: "video",
        youtubeUrl: chapter.video.youtubeUrl,
        caption: "YouTube embed"
      });
    }
  }
  return media;
}

// Where a chapter's media is shown. Read straight off "mediaPosition" in
// data/chapters.json; drives both the docked #media-sidecar panel and which
// side the text card has to keep clear.
//
//   "right"   panel docked over the right 58% of the viewport, card left
//   "left"    panel docked over the left 58%, card right
//   "full"    panel spans the whole width and the card floats on top of it.
//             For material too wide to read in a half panel - the welcome
//             panoramas are 3:1 - where the picture IS the chapter rather
//             than an illustration of it.
//   "none"    no panel; the card is centred and owns the screen
//
// The key used to carry a fifth, implicit meaning: anything that was not
// left/right/full dropped the media INLINE, into the middle of the
// chapter's prose. That inline path is gone - a photo has exactly one place
// it can appear now - so an unrecognised or absent key falls back to
// "right" when the chapter actually has media, and to "none" when it does
// not. A typo in the JSON therefore costs a side preference, never the
// content, and a text-only chapter never fades in an empty panel.
//
// An explicit "none" on a chapter that HAS media is honoured as written -
// that is an author saying "not this one", which is different from an
// author saying nothing.
//
// This is a sibling of "mapPosition" in the data but independent of it: the
// map is a full-width band inside the chapter and no longer competes for a
// side. Where the two would collide - the panel sitting over the band while
// it is on screen - is handled at scroll time by setupMediaRegions(), not
// here.
const MEDIA_POSITIONS = ["left", "right", "full", "none"];

function mediaPositionFor(chapter) {
  if (!normalizeMedia(chapter).length) return "none";
  const want = String(chapter.mediaPosition || "").toLowerCase();
  return MEDIA_POSITIONS.includes(want) ? want : "right";
}

// A <source>'s `type` is a PROMISE the browser holds you to, not a hint: if
// it does not recognise the type it rejects that source outright, without
// ever fetching the file. There is no error event on the <video> when that
// happens - you get networkState 3 (NETWORK_NO_SOURCE) and a silent blank
// player, which is near-undebuggable from the outside.
//
// This is only mapped for the types that genuinely help. Anything else -
// notably .mov - returns "" so the attribute is omitted entirely and the
// browser sniffs the file instead. Omitting is strictly safer than guessing:
// a .mov holding ordinary H.264 plays fine in Chrome when sniffed, but
// declaring the honest `video/quicktime` makes Chrome refuse it. The type
// attribute only earns its keep when there are several <source>s to choose
// between, and here there is exactly one.
const VIDEO_MIME_TYPES = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  ogv: "video/ogg"
};

function videoMimeType(src) {
  const ext = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(src || "");
  return (ext && VIDEO_MIME_TYPES[ext[1].toLowerCase()]) || "";
}

function renderMediaItemInner(item) {
  if (item.type === "video") {
    // `youtubeUrl` is the documented field, but a URL pasted into `src` (the
    // image field) is an easy mistake to make when filling in a reserved video
    // slot - and it used to fail silently as a "coming soon" placeholder. Accept
    // either, so long as a video ID can actually be parsed out of it.
    const ytUrl = item.youtubeUrl || (parseYouTubeId(item.src) ? item.src : null);
    if (ytUrl) {
      const ytId = parseYouTubeId(ytUrl);
      if (!ytId) {
        return `<p><em>Could not parse a video ID from "${ytUrl}".</em></p>`;
      }
      return `
        <iframe
          class="yt-embed"
          src="https://www.youtube.com/embed/${ytId}?enablejsapi=1"
          title="YouTube video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen>
        </iframe>
      `;
    }
    if (item.localSrc) {
      const mime = videoMimeType(item.localSrc);
      return `
        <video controls preload="metadata"${item.poster ? ` poster="${item.poster}"` : ""}>
          <source src="${item.localSrc}"${mime ? ` type="${mime}"` : ""} />
          Your browser cannot play this video inline.
        </video>
      `;
    }
    // A video slot the client has reserved but not yet supplied a URL for.
    // Renders a labelled placeholder so the carousel keeps its shape and the
    // slot is obvious in review; drop in a youtubeUrl to make it live.
    return `
      <div class="video-pending">
        <span class="video-pending-badge">Video coming soon</span>
        <p>${item.alt || "Interview video"}</p>
        ${item.pendingNote ? `<p class="video-pending-note">${item.pendingNote}</p>` : ""}
      </div>
    `;
  }
  return `<img src="${item.src}" alt="${item.alt || ""}" loading="lazy" />`;
}

// Builds a self-contained gallery: a sliding track of media items, plus
// prev/next arrows and dot indicators once there's more than one item.
// Every chapter's images and video go through this one component, and it
// has exactly one destination: the docked #media-sidecar panel (see
// placeMediaForChapter()). It used to also be rendered inline inside a
// chapter card, which is why the base CSS still carries a top margin that
// the sidecar overrides.

// --- Image fullscreen modal ------------------------------------------------
// One overlay, lazily built on first use and reused for every image on the
// page - keeps this to a single DOM node/listener set instead of one modal
// per slide. The sidecar already sizes its images with object-fit:contain,
// so this is not about uncropping them; it is about scale. A tall diagram
// in a 58% panel is legible as a composition but not as a document, and
// this gives the reader the whole screen for it.
let imageModal = null;

function ensureImageModal() {
  if (imageModal) return imageModal;

  const modal = document.createElement("div");
  modal.id = "image-modal";
  modal.className = "image-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-label", "Expanded image");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "image-modal-close";
  closeBtn.setAttribute("aria-label", "Close expanded image");
  // The lightbox is a fixed, full-viewport overlay with nothing clipping
  // it, so this one can use the default downward bubble.
  closeBtn.dataset.tip = "Click to close (or press Escape)";
  closeBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`;

  const figure = document.createElement("figure");
  figure.className = "image-modal-figure";

  const img = document.createElement("img");
  img.className = "image-modal-img";

  const caption = document.createElement("figcaption");
  caption.className = "image-modal-caption";

  figure.appendChild(img);
  figure.appendChild(caption);
  modal.appendChild(closeBtn);
  modal.appendChild(figure);
  document.body.appendChild(modal);

  const close = () => {
    modal.classList.remove("open");
    document.body.classList.remove("image-modal-open");
    // Drop the src once the close transition finishes so a lingering
    // large image doesn't sit decoded in memory between opens.
    window.setTimeout(() => {
      if (!modal.classList.contains("open")) img.src = "";
    }, 250);
  };

  // Click anywhere on the dark backdrop (i.e. not the image/caption/close
  // button themselves) closes it, same convention as most lightboxes.
  modal.addEventListener("click", (event) => {
    if (event.target === modal || event.target === figure) close();
  });
  closeBtn.addEventListener("click", close);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal.classList.contains("open")) close();
  });

  imageModal = { modal, img, caption, closeBtn, close };
  return imageModal;
}

function openImageModal(src, alt, captionText) {
  if (!src) return;
  const { modal, img, caption, closeBtn } = ensureImageModal();
  img.src = src;
  img.alt = alt || "";
  caption.textContent = captionText || "";
  caption.style.display = captionText ? "" : "none";
  modal.classList.add("open");
  document.body.classList.add("image-modal-open");
  closeBtn.focus();
}

function renderMediaCarousel(mediaItems) {
  const wrap = document.createElement("div");
  wrap.className = "media-carousel";
  if (!mediaItems.length) return wrap;

  const track = document.createElement("div");
  track.className = "media-carousel-track";

  mediaItems.forEach((item) => {
    const slide = document.createElement("figure");
    slide.className = "media-carousel-item";
    slide.innerHTML = `
      ${renderMediaItemInner(item)}
      ${item.caption ? `<figcaption>${item.caption}</figcaption>` : ""}
    `;

    // Fullscreen/expand only makes sense for images - videos (local <video
    // controls> or the YouTube iframe) already have their own native
    // fullscreen affordance. Reuses the same four-corner-bracket icon as
    // #map-fullscreen-btn so it reads as the same "expand" action.
    if (item.type !== "video") {
      const expandBtn = document.createElement("button");
      expandBtn.type = "button";
      expandBtn.className = "media-expand-btn";
      expandBtn.setAttribute("aria-label", "View expanded image");
      // Left, because this sits in the slide's top-right corner and
      // .media-carousel is overflow: hidden.
      expandBtn.dataset.tip = "Click to see this photo full size";
      expandBtn.dataset.tipPos = "left";
      expandBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`;
      expandBtn.addEventListener("click", (event) => {
        event.stopPropagation();
        openImageModal(item.src, item.alt, item.caption);
      });
      slide.appendChild(expandBtn);
    }

    track.appendChild(slide);
  });

  wrap.appendChild(track);

  if (mediaItems.length > 1) {
    const dotsWrap = document.createElement("div");
    dotsWrap.className = "media-carousel-dots";

    const dots = mediaItems.map((_, i) => {
      const dot = document.createElement("button");
      dot.type = "button";
      dot.className = "media-carousel-dot" + (i === 0 ? " active" : "");
      dot.setAttribute("aria-label", `Go to slide ${i + 1}`);
      // "of N" because the row of dots is the only thing telling a reader
      // how many photos a chapter has, and it does so only by being
      // counted. Above, into the slide - the row is pinned to the bottom
      // edge of an overflow: hidden box.
      dot.dataset.tip = `Click for photo ${i + 1} of ${mediaItems.length}`;
      dot.dataset.tipPos = "above";
      dotsWrap.appendChild(dot);
      return dot;
    });

    let index = 0;
    const goTo = (i) => {
      index = (i + mediaItems.length) % mediaItems.length;
      track.style.transform = `translateX(-${index * 100}%)`;
      dots.forEach((dot, di) => dot.classList.toggle("active", di === index));
    };
    dots.forEach((dot, i) => dot.addEventListener("click", () => goTo(i)));

    const prevBtn = document.createElement("button");
    prevBtn.type = "button";
    prevBtn.className = "media-carousel-arrow media-carousel-prev";
    prevBtn.setAttribute("aria-label", "Previous");
    // The two arrows' tooltips point INWARD at each other, not outward:
    // each sits 0.75rem off its own edge of .media-carousel, which is
    // overflow: hidden, so an outward bubble would be clipped to nothing.
    prevBtn.dataset.tip = "Click for the previous photo";
    prevBtn.dataset.tipPos = "right";
    prevBtn.innerHTML = "&#8249;";
    prevBtn.addEventListener("click", () => goTo(index - 1));

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "media-carousel-arrow media-carousel-next";
    nextBtn.setAttribute("aria-label", "Next");
    nextBtn.dataset.tip = "Click for the next photo";
    nextBtn.dataset.tipPos = "left";
    nextBtn.innerHTML = "&#8250;";
    nextBtn.addEventListener("click", () => goTo(index + 1));

    wrap.appendChild(prevBtn);
    wrap.appendChild(nextBtn);
    wrap.appendChild(dotsWrap);
  }

  return wrap;
}

// --- Chapter rendering ---------------------------------------------------
// Two distinct shapes: a full-bleed hero/title screen (isTitleScreen), and
// regular chapters, which render as a text card with its media alongside -
// optionally under a band of map, if "mapPosition" says this chapter has
// one. See renderChapter() for the structure and placeMapForChapter() for
// how the shared map moves into the band.
function renderHeroChapter(story, chapter) {
  const section = document.createElement("section");
  section.className = "chapter hero";
  section.id = chapter.id;
  section.dataset.mapPosition = chapter.mapPosition || "none";

  const bgImage = chapter.image ? chapter.image.src : "";
  const bgVideo = chapter.backgroundVideo;
  const prefersReducedMotion =
    window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Background video ("underneath the title") if the chapter supplies one
  // and the reader hasn't asked the OS for reduced motion - otherwise falls
  // back to the original static background-image div. `image`/`image.src`
  // doubles as the video's poster frame so there's never a blank/black
  // flash before the (large) video file has buffered enough to play.
  //
  // The poster attribute is omitted rather than left empty when the chapter
  // supplies neither: poster="" does not mean "no poster", it resolves to
  // the page's own URL, so the browser fetches index.html and tries to
  // decode the HTML as an image - a wasted request on an origin whose
  // connections this video is already competing for.
  const heroPoster = bgVideo && (bgVideo.poster || bgImage);
  const heroBgHtml =
    bgVideo && !prefersReducedMotion
      ? `
        <div class="hero-bg hero-bg-video">
          <video
            class="hero-bg-media"
            autoplay
            muted
            loop
            playsinline
            preload="metadata"
            ${heroPoster ? `poster="${heroPoster}"` : ""}
            aria-hidden="true"
          >
            <source src="${bgVideo.src}" type="video/mp4" />
          </video>
          <div class="hero-bg-overlay"></div>
          <button type="button" class="hero-video-toggle" aria-label="Pause background video" data-tip="Click to pause the background video" data-tip-pos="left">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
          </button>
        </div>
      `
      : `
        <div class="hero-bg"${heroPoster || bgImage ? ` style="background-image: url('${heroPoster || bgImage}')"` : ""}>
          <div class="hero-bg-overlay"></div>
        </div>
      `;

  section.innerHTML = `
    ${heroBgHtml}
    <div class="hero-content">
      ${renderIcon(chapter.icon)}
      ${chapter.eyebrow ? `<p class="eyebrow">${chapter.eyebrow}</p>` : ""}
      <h1>${chapter.title}</h1>
      <p class="hero-lede">${chapter.description}</p>
      <div class="scroll-cue">Scroll to begin<span class="scroll-cue-arrow" aria-hidden="true"></span></div>
    </div>
  `;

  story.appendChild(section);

  // Playback speed isn't a static HTML attribute (there's no such thing as
  // defaultPlaybackRate="2" in markup) - it's a DOM property that has to be
  // set on the actual <video> element in JS. Some browsers reset
  // playbackRate when the source finishes loading, so it's re-applied on
  // loadedmetadata too, not just once immediately after creation.
  const heroVideoEl = section.querySelector(".hero-bg-media");

  if (heroVideoEl && bgVideo && bgVideo.playbackRate && !prefersReducedMotion) {
    heroVideoEl.playbackRate = bgVideo.playbackRate;
    heroVideoEl.addEventListener("loadedmetadata", () => {
      heroVideoEl.playbackRate = bgVideo.playbackRate;
    });
  }

  // Manual play/pause for the background video. Needed for two reasons:
  // a muted autoplay video has no native controls (and adding `controls`
  // would drop a full scrubber bar over the title), and browsers can refuse
  // to autoplay at all - leaving the reader with a still frame and no way
  // to start it. data-user-paused records an explicit pause so the
  // scroll-back resume in resumeMediaIn() doesn't override the reader.
  const heroToggle = section.querySelector(".hero-video-toggle");
  if (heroVideoEl && heroToggle) {
    const PLAY_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>`;
    const PAUSE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>`;

    const syncToggle = () => {
      const playing = !heroVideoEl.paused && !heroVideoEl.ended;
      heroToggle.innerHTML = playing ? PAUSE_ICON : PLAY_ICON;
      const label = playing ? "Pause background video" : "Play background video";
      heroToggle.setAttribute("aria-label", label);
      // The tooltip says what the click will DO, which is the opposite of
      // the state the icon shows - so it cannot just reuse `label`.
      heroToggle.dataset.tip = playing
        ? "Click to pause the background video"
        : "Click to play the background video";
    };

    heroToggle.addEventListener("click", () => {
      if (heroVideoEl.paused) {
        heroVideoEl.dataset.userPaused = "false";
        const played = heroVideoEl.play();
        if (played && typeof played.catch === "function") played.catch(() => {});
      } else {
        heroVideoEl.dataset.userPaused = "true";
        heroVideoEl.pause();
      }
    });

    // Driven off the element's own events rather than set inside the click
    // handler, so the icon also stays correct when playback is started or
    // stopped by something else - autoplay landing, the scroll observer,
    // or the browser blocking playback.
    heroVideoEl.addEventListener("play", syncToggle);
    heroVideoEl.addEventListener("pause", syncToggle);
    syncToggle();
  }
}

function renderChapter(story, chapter) {
  const section = document.createElement("section");
  section.className = "chapter";
  section.id = chapter.id;

  // The map no longer docks to a side - it is a full-width band inside the
  // chapter - so this is no longer a layout instruction. It just records
  // whether this chapter owns the map, for CSS hooks and for reading the
  // DOM while debugging.
  section.dataset.mapPosition = chapter.mapPosition || "none";

  // Which side the media panel docks to for this chapter, and therefore
  // which side the text card has to keep clear. Always set, "none"
  // included, so the CSS can select the centred case directly instead of
  // through a :not() chain.
  const mediaPosition = mediaPositionFor(chapter);
  section.dataset.mediaPosition = mediaPosition;

  // "full" spans the whole viewport instead of docking to one side, so
  // there is no opposite side for the card to sit in - it overlays the
  // media. Flagged separately because the left/right offset rules are
  // wrong for it and the centred "none" rules are too.
  if (mediaPosition === "full") section.dataset.mediaFull = "true";

  const content = document.createElement("div");
  content.className = "chapter-content";

  // "dummy": false marks a chapter as real/final content - everything else
  // is still treated as placeholder and gets the "Dummy content" flag.
  const isDummy = chapter.dummy !== false;

  content.innerHTML = `
    ${isDummy ? '<span class="dummy-tag">Dummy content</span>' : ""}
    <div class="chapter-heading">
      ${renderIcon(chapter.icon)}
      <h2>${chapter.title}</h2>
    </div>
    <div class="chapter-body">${chapter.description}</div>
  `;

  // Optional short caveat noting that the map layer/overlay for this chapter
  // is a stand-in until the client supplies real GIS data (see chapter.mapNote
  // in data/chapters.json) - distinct from the "dummy": true tag, since the
  // narrative copy itself can be final even when its map treatment isn't yet.
  if (chapter.mapNote) {
    const note = document.createElement("p");
    note.className = "map-placeholder-note";
    note.textContent = chapter.mapNote;
    content.appendChild(note);
  }

  // No media is built into the section. Every chapter's images and video
  // live in the one docked #media-sidecar panel, which placeMediaForChapter()
  // fills on scroll - so a chapter renders as text only, and the pictures
  // are swapped in behind/beside it as the reader arrives.
  //
  // Map chapters additionally get a full-width band above the text for the
  // shared MapLibre instance to move into (see dockMapInStage()), with the
  // narrative underneath it, so the map never overlaps the card.
  if (chapter.mapPosition === "left" || chapter.mapPosition === "right") {
    section.classList.add("chapter-stacked");

    const stage = document.createElement("div");
    stage.className = "chapter-map-stage";
    section.appendChild(stage);

    const textWrap = document.createElement("div");
    textWrap.className = "chapter-stage-text";
    textWrap.appendChild(content);
    section.appendChild(textWrap);
  } else {
    section.appendChild(content);
  }

  story.appendChild(section);
}

function renderChapters(chapters) {
  const story = document.getElementById("story");
  chapters.forEach((chapter) => {
    if (chapter.isTitleScreen) {
      renderHeroChapter(story, chapter);
    } else {
      renderChapter(story, chapter);
    }
  });

  // Block Explorer (see renderExplorerSection() below) isn't a narrative
  // chapter - it's an interactive detour dropped in right after "Analyze My
  // Own Block" (section7-analyze-block), the chapter that hands the reader off
  // to it explicitly. It's a plain in-flow section, not a `.chapter`, so it
  // never enters the shared-map IntersectionObserver/docking system - see
  // initExplorerObserver().
  const anchorChapter = document.getElementById("section7-analyze-block");
  const explorerSection = renderExplorerSection();
  if (anchorChapter) {
    anchorChapter.insertAdjacentElement("afterend", explorerSection);
  } else {
    story.appendChild(explorerSection);
  }
}

// --- Toolbar (section navigation) ------------------------------------------
// A single row of section tabs ("Get Oriented", "What Wildfire Means Here",
// ...), one per narrative section, plus the Block Explorer's own tab. It is
// inserted directly after the hero section (see bootstrap()) and uses
// "position: sticky" in CSS, so it scrolls normally underneath the hero and
// only locks to the top once the reader scrolls past it.
//
// There used to be a second tier below this one listing every chapter in
// the active section as a pill. With 46 chapters that was a lot of nav for
// a story the reader is meant to scroll, it doubled the height of the
// fixed chrome at the top of every screen, and showing/hiding rows of
// different heights made the page jump under the reader. Sections are the
// only level of the hierarchy the nav offers now; chapters are reached by
// scrolling, which is the point of a story map.
//
// Section grouping is derived from each chapter's id prefix rather than a
// hardcoded per-chapter list, so new "section1-*"/"section2-*" chapters
// automatically land in the right group.
const SECTION_LABELS = {
  section1: "Risk of Wildfire",
  section2: "Vision & Stewardship",
  section3: "Culture of Preparedness",
  section4: "Whither Homestead",
  section5: "Where Do I Start?",
  section6: "Defensible Space & Hardening",
  section7: "Start With Your Block",
  section8: "Help Is Available"
};

// Anything that isn't a "sectionN-*" chapter (currently just the hero title
// screen) falls into section 1, which is where it sits on the page.
function sectionIdFor(chapter) {
  const match = /^(section[1-8])-/.exec(chapter.id);
  return match ? match[1] : "section1";
}

// Preserves first-appearance order (chapters.json order), grouping chapters
// under whichever section id they belong to.
function groupChaptersBySection(chapters) {
  const order = [];
  const groups = {};
  chapters.forEach((chapter) => {
    const sectionId = sectionIdFor(chapter);
    if (!groups[sectionId]) {
      groups[sectionId] = [];
      order.push(sectionId);
    }
    groups[sectionId].push(chapter);
  });
  return { order, groups };
}

function scrollToChapter(id) {
  const target = document.getElementById(id);
  if (target) target.scrollIntoView({ behavior: "smooth" });
}

// Clicking a top-level toolbar section pill normally jumps to that
// section's first chapter (see renderToolbar() below) - but for section 1
// that first chapter is the full-bleed hero/title screen, which just
// re-scrolls to the very top of the page instead of anywhere useful. This
// override sends it to the first real chapter instead. Add more entries
// here if another section ever needs its pill to land somewhere other than
// its first chapter.
const SECTION_NAV_OVERRIDES = {
  section1: "section1-built-by-neighbors"
};

// The Block Explorer gets a tab of its own, even though it is not a
// narrative section and owns no chapters. It's the one interactive tool in
// the story ("go look at YOUR block"), and a reader who wants it should not
// have to remember which narrative section it happens to sit inside and
// scroll for it. It is styled as a filled button rather than a tab (see
// .toolbar-section-standalone) so it reads as the one thing here you DO
// rather than one more place you can go.
const EXPLORER_NAV_ID = "explorer";
const EXPLORER_NAV_LABEL = "Explore Your Block";
const EXPLORER_SECTION_EL_ID = "block-explorer";

// The Explorer's button used to be spliced into the section row at the
// position matching where its section sits in the page (after "section1"),
// on the principle that the nav should read in page order. It is now
// pinned to the right-hand tail instead - see renderToolbar() - because
// page order only mattered while it looked like a peer of the section
// tabs. As a call-to-action its job is to be findable at any scroll
// position, not to hold a place in a sequence.

// Marks one section's tab as the current one - used both on tab click and,
// via updateToolbar(), as the reader scrolls between sections.
//
// Since the bar is a single row of fixed height, this can never change
// #toolbar's height, and so can never move the page under the reader. The
// previous two-tier version could: switching to the Explorer tab (which has
// no chapters of its own) collapsed the second tier, which shifted the page
// up, which moved the Explorer back across the very intersection threshold
// that had triggered the switch - an oscillation the reader saw as flicker.
function showToolbarSection(sectionId, toolbarEl) {
  const bar = toolbarEl || document.getElementById("toolbar");
  if (!bar) return;
  bar.querySelectorAll(".toolbar-section-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.section === sectionId);
  });
}

function renderToolbar(chapters) {
  const toolbar = document.createElement("nav");
  toolbar.id = "toolbar";
  toolbar.setAttribute("aria-label", "Story sections");

  const { order, groups } = groupChaptersBySection(chapters);

  // The eight narrative section tabs, laid out as a 4x2 grid of
  // equal-sized chips (see .toolbar-sections); the tail below never wraps.
  //
  // Label length here has a layout cost that is not local to one chip.
  // Each sits in a quarter-width track, and the longest label decides the
  // height of all eight: at 1440px a track is 254px and "Defensible Space
  // & Hardening" needs 258px, so it takes two lines and - because the rows
  // are equalised - every chip becomes two lines tall, adding ~20px to the
  // sticky chrome on every screen of the read. Shortening that one label
  // to something that fits on a line would buy it straight back.
  const sectionsRow = document.createElement("div");
  sectionsRow.className = "toolbar-sections";
  sectionsRow.innerHTML = order
    .map((sectionId) => {
      const label = SECTION_LABELS[sectionId] || sectionId;
      return `
        <button type="button" class="toolbar-section-item" data-section="${sectionId}">
          ${label}
        </button>
      `;
    })
    .join("");
  toolbar.appendChild(sectionsRow);

  // The Explorer button and the theme picker are a separate, fixed-width
  // tail rather than two more items at the end of the wrapping row. The
  // eight section labels plus the Explorer plus four theme swatches do not
  // fit on one line at any ordinary desktop width, so when they shared a
  // row the Explorer was whichever happened to land last - sometimes
  // alone on a second line, sometimes pushed off the end. Pinned here it
  // is on screen at every width, which is the entire point of giving it a
  // call-to-action treatment in the first place.
  const tail = document.createElement("div");
  tail.className = "toolbar-tail";

  const explorerBtn = document.createElement("button");
  explorerBtn.type = "button";
  // Keeps the class the click handler and showToolbarSection() look for,
  // so the Explorer still participates in active-state tracking exactly
  // like a section tab - it just isn't drawn like one.
  explorerBtn.className = "toolbar-section-item toolbar-section-standalone";
  explorerBtn.dataset.section = EXPLORER_NAV_ID;
  // The dot is decorative; aria-hidden keeps it out of the accessible
  // name, which stays just the label.
  explorerBtn.innerHTML =
    '<span class="toolbar-standalone-dot" aria-hidden="true"></span>' +
    `<span class="toolbar-standalone-label">${EXPLORER_NAV_LABEL}</span>`;
  tail.appendChild(explorerBtn);

  toolbar.appendChild(tail);

  toolbar.querySelectorAll(".toolbar-section-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sectionId = btn.dataset.section;
      showToolbarSection(sectionId, toolbar);
      if (sectionId === EXPLORER_NAV_ID) {
        // Aim at the map, not the top of the section. The Explorer's heading
        // and intro run ~500px tall, so landing at the section's start leaves
        // the actual interactive map below the fold - the one thing the pill
        // promises. .explorer-map-wrap carries a scroll-margin-top of
        // --nav-offset so it clears the sticky header/toolbar.
        const section = document.getElementById(EXPLORER_SECTION_EL_ID);
        const mapWrap = section && section.querySelector(".explorer-map-wrap");
        (mapWrap || section).scrollIntoView({ behavior: "smooth" });
        return;
      }
      const firstChapter = groups[sectionId] && groups[sectionId][0];
      const targetId = SECTION_NAV_OVERRIDES[sectionId] || (firstChapter && firstChapter.id);
      if (targetId) scrollToChapter(targetId);
    });
  });

  const themePicker = renderThemePicker();
  if (themePicker) tail.appendChild(themePicker);

  // Mark the first section current before any scrolling has happened.
  if (order.length) showToolbarSection(order[0], toolbar);

  return toolbar;
}

// Theme picker - a small swatch group pinned to the end of the section row.
// Returns null when only one theme is registered, so the control simply
// doesn't appear if the registry is ever trimmed back to a single palette.
function renderThemePicker() {
  const names = Object.keys(THEMES);
  if (names.length < 2) return null;

  const wrap = document.createElement("div");
  wrap.className = "theme-picker";
  wrap.setAttribute("role", "radiogroup");
  wrap.setAttribute("aria-label", "Colour theme");

  names.forEach((name) => {
    const theme = THEMES[name];
    const colors = theme.colors || {};
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "theme-option";
    btn.dataset.theme = name;
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(name === activeThemeName));
    btn.title = theme.label || name;
    btn.setAttribute("aria-label", `${theme.label || name} theme`);
    if (name === activeThemeName) btn.classList.add("active");
    // Three stacked bands stand in for the palette, so the choice is legible
    // at swatch size without spelling out five hex codes.
    btn.innerHTML = `
      <span class="theme-swatch">
        <span style="background:${colors.primary}"></span>
        <span style="background:${colors.secondary}"></span>
        <span style="background:${colors.accent}"></span>
      </span>
      <span class="theme-option-label">${theme.label || name}</span>
    `;
    btn.addEventListener("click", () => setActiveTheme(name));
    wrap.appendChild(btn);
  });

  return wrap;
}

function updateToolbar(activeChapterId, chapters) {
  const activeChapter = chapters.find((c) => c.id === activeChapterId);
  if (activeChapter) {
    showToolbarSection(sectionIdFor(activeChapter));
  }
}

// --- Footer ------------------------------------------------------------
function renderFooter(footerConfig) {
  const footer = document.getElementById("footer");
  if (!footer || !footerConfig) return;

  const linksHtml = (footerConfig.links || [])
    .map((link) => `<a class="footer-link" href="${link.url}">${link.label}</a>`)
    .join("");

  footer.innerHTML = `
    <div class="footer-inner">
      ${footerConfig.title ? `<h2>${footerConfig.title}</h2>` : ""}
      ${footerConfig.text ? `<p class="footer-text">${footerConfig.text}</p>` : ""}
      ${linksHtml ? `<nav class="footer-links">${linksHtml}</nav>` : ""}
      ${footerConfig.credit ? `<p class="footer-credit">${footerConfig.credit}</p>` : ""}
    </div>
  `;
}

// --- Video auto-pause/resume as chapters scroll in and out of view --------
// Toggled by settings.pauseVideoOffscreen in data/chapters.json.
function pauseMediaIn(sectionEl) {
  sectionEl.querySelectorAll("video").forEach((v) => v.pause());
  sectionEl.querySelectorAll("iframe.yt-embed").forEach((frame) => {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage(
      JSON.stringify({ event: "command", func: "pauseVideo", args: [] }),
      "*"
    );
  });
}

// The counterpart to pauseMediaIn(): without this, an autoplaying background
// video played once on load, got paused the first time the reader scrolled
// past it, and then stayed frozen on its last frame forever.
//
// Scoped to video[autoplay] so it only ever restarts videos that were
// *meant* to run on their own - a regular <video controls> the reader
// deliberately stopped stays stopped. data-user-paused is the same
// exemption for a background video paused via its own toggle button.
function resumeMediaIn(sectionEl) {
  sectionEl.querySelectorAll("video[autoplay]").forEach((v) => {
    if (v.dataset.userPaused === "true") return;
    // play() rejects if the browser blocks playback (e.g. autoplay policy);
    // the hero's visible play/pause button is the manual fallback.
    const played = v.play();
    if (played && typeof played.catch === "function") played.catch(() => {});
  });
}

function setupVideoPauseOnScrollOut() {
  if (!SETTINGS.pauseVideoOffscreen) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        // threshold 0 fires exactly when a chapter becomes fully hidden
        // (scrolled entirely above or below the viewport) or reappears.
        if (entry.isIntersecting) {
          resumeMediaIn(entry.target);
        } else {
          pauseMediaIn(entry.target);
        }
      });
    },
    { threshold: 0 }
  );

  document.querySelectorAll(".chapter").forEach((el) => observer.observe(el));
}

// --- Legend ---------------------------------------------------------------
// SYMBOLOGY RENDERERS
//
// A legend section declares HOW it should be drawn via an optional
// "symbology" key in data/chapters.json, and renderLegendSymbology() below
// dispatches to the matching renderer. The point of the indirection is that
// a chapter needing a differently-shaped legend (a bivariate matrix, and in
// future a continuous ramp bar, a graduated-symbol column, ...) is a new
// entry in LEGEND_SYMBOLOGY_RENDERERS plus some CSS - it does NOT mean
// touching renderLegendShell(), renderExplorerLegend(), or the existing
// sections, all of which stay on the default "items" renderer.
//
// Contract every renderer honours:
//   - takes the whole section object, returns an HTML string
//   - renders only the section BODY; the header, the on/off switch and the
//     .legend-section box itself belong to buildLegendSectionHtml() below,
//     so all symbologies get the same toggle behaviour for free
//   - is pure (no DOM reads, no map reads) so the same function can serve
//     the story legend and the Block Explorer legend
//
// Escaping note: labels come from our own chapters.json and legitimately
// contain markup-ish characters (en-dashes, ×, ≥), so they are interpolated
// as-is, consistent with how chapter descriptions are already handled. These
// are authored strings, never user input.

// "items" (the default) - a vertical list of swatch + label rows. "swatch"
// on an item (optional, defaults to a flat filled square) lets a row
// visually match a LINE-based map layer (marin/homesteadHighlight
// boundaries, contours, streets) instead of always rendering a filled block
// for what's actually a line on the map - "line-solid" draws a solid rule,
// "line-dashed" a dashed one, both colored via item.color.
function renderLegendItemHtml(item) {
  const swatchType = item.swatch || "fill";
  // "pin" is a teardrop, so like "fill" its colour is a background, not a
  // border-top - the line variants are the odd ones out here, not it.
  const swatchStyle =
    swatchType === "fill" || swatchType === "pin"
      ? `background:${item.color}`
      : `border-top-color:${item.color}`;
  return `
    <div class="legend-item">
      <span class="legend-swatch legend-swatch-${swatchType}" style="${swatchStyle}"></span>
      <span>${item.label}</span>
    </div>
  `;
}

function renderItemsSymbology(section) {
  return (section.items || []).map(renderLegendItemHtml).join("");
}

// "matrix" - a 2D bivariate grid: one axis per variable, one cell per
// combination, so a reader decodes a map color back into a PAIR of classes
// rather than matching it against N arbitrary chips.
//
// section.matrix = {
//   rows:  [[hex x4], ...]   row 0 = LOWEST y-axis class (see the reverse below)
//   yAxis: { label, ticks: [one short name per row] }
//   xAxis: { label, edges: [N+1 numbers/strings], unit }
//   note:  optional sentence under the grid
// }
//
// The two axes are labelled differently on purpose. The y axis is
// CATEGORICAL in the reader's head ("Sparse".."Very dense"), so it gets one
// name per row. The x axis is a continuous variable cut into classes, so it
// gets its N+1 class EDGES rendered at the cell boundaries rather than N
// ranges centred under cells: edge numbers are short enough to fit under a
// ~20px cell, where "265-393 ft" is not, and boundaries are what a reader
// actually needs to place a value.
//
// rows are authored LOW-to-HIGH on the y axis - the same orientation as
// bivariate_work/bivariate_palette.json's matrix[vegClass-1][elevClass-1] -
// so the JSON can be diffed against the palette the data was built with
// without mentally flipping it. They are reversed here because CSS grid
// fills top-down, and "more of the y variable" has to read UPWARD for the
// grid to match the axis arrow (and the reference bivariate legend supplied
// with the request).
//
// Everything lives in ONE CSS grid - tick column, cells, edge row and axis
// label - so the edge numbers stay aligned with the cell boundaries no
// matter how wide the y-axis tick labels turn out to be. A separate row of
// labels underneath could not track an `auto`-width first column.
function renderMatrixSymbology(section) {
  const matrix = section.matrix;
  if (!matrix || !Array.isArray(matrix.rows)) return renderItemsSymbology(section);

  const yTicks = matrix.yAxis?.ticks || [];
  const xEdges = matrix.xAxis?.edges || [];
  const unit = matrix.xAxis?.unit ? ` ${matrix.xAxis.unit}` : "";
  const cols = matrix.rows[0]?.length || 0;

  const bodyRows = matrix.rows
    .map((row, y) => ({ row, y }))
    .reverse()
    .map(({ row, y }) => {
      const cells = row
        .map((color, x) => {
          // title= gives every cell a hover / assistive-tech readable
          // decoding, the only per-cell labelling that fits a grid this size.
          const xRange =
            xEdges.length > x + 1 ? `${xEdges[x]}–${xEdges[x + 1]}${unit}` : `class ${x + 1}`;
          const label = `${yTicks[y] || `class ${y + 1}`} × ${xRange}`;
          return `<span class="legend-matrix-cell" style="background:${color}" title="${label}"></span>`;
        })
        .join("");
      return `<span class="legend-matrix-ytick">${yTicks[y] || ""}</span>${cells}`;
    })
    .join("");

  const edgeSpan = `grid-column: 2 / span ${cols}`;
  const edgesHtml = xEdges.length
    ? `<span></span><span class="legend-matrix-xedges" style="${edgeSpan}">${xEdges
        .map((e) => `<span>${e}</span>`)
        .join("")}</span>`
    : "";
  const xLabelHtml = matrix.xAxis?.label
    ? `<span></span><span class="legend-matrix-xlabel" style="${edgeSpan}">${matrix.xAxis.label}</span>`
    : "";

  return `
    <div class="legend-matrix">
      <div class="legend-matrix-ylabel">${matrix.yAxis?.label || ""}</div>
      <div class="legend-matrix-grid" style="--legend-matrix-cols:${cols}">
        ${bodyRows}
        ${edgesHtml}
        ${xLabelHtml}
      </div>
    </div>
    ${matrix.note ? `<p class="legend-matrix-note">${matrix.note}</p>` : ""}
  `;
}

const LEGEND_SYMBOLOGY_RENDERERS = {
  items: renderItemsSymbology,
  matrix: renderMatrixSymbology
};

function renderLegendSymbology(section) {
  const kind = section.symbology || "items";
  const renderer = LEGEND_SYMBOLOGY_RENDERERS[kind];
  if (!renderer) {
    // Fall back rather than render an empty box - an unknown symbology name
    // is an authoring typo, and a legend section that silently disappears is
    // much harder to notice than one that renders plainly with a console note.
    console.warn(`Unknown legend symbology "${kind}" - falling back to "items".`);
    return renderItemsSymbology(section);
  }
  return renderer(section);
}

// The .legend-section box is identical in the story legend and the Block
// Explorer legend (same markup, same CSS, same switch semantics) - only the
// host element and the toggle callback differ. Building it in one place means
// a new symbology, or a change to the switch markup, lands in both at once.
function buildLegendSectionHtml(section) {
  return `
    <div class="legend-header">
      <h4>${section.title}</h4>
      <span class="legend-toggle" aria-hidden="true"><span class="legend-toggle-thumb"></span></span>
    </div>
    ${renderLegendSymbology(section)}
  `;
}

function createLegendSectionBox(layerKey, section, onToggle) {
  const box = document.createElement("div");
  box.className = "legend-section";
  box.dataset.layer = layerKey;
  // Each section IS the toggle - a reader clicks/taps/Enter-Space's the
  // whole section to flip that map layer on or off, independent of whatever
  // the current chapter set it to.
  box.setAttribute("role", "switch");
  box.setAttribute("tabindex", "0");
  box.setAttribute("aria-checked", "false");
  box.setAttribute("aria-label", `Toggle ${section.title} map layer`);
  box.innerHTML = buildLegendSectionHtml(section);

  box.addEventListener("click", () => onToggle(box));
  box.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggle(box);
    }
  });
  return box;
}

function renderLegendShell(legendConfig) {
  const legend = document.getElementById("legend");
  const reopenBtn = document.getElementById("legend-reopen");
  if (!legendConfig || !legend) return;

  const onRight = SETTINGS.legendPosition === "right";
  legend.classList.toggle("legend-right", onRight);
  if (reopenBtn) reopenBtn.classList.toggle("legend-right", onRight);

  // Start hidden - updateLegend() reveals it once a chapter with an active
  // layer scrolls into view, so there's no empty box flash before then.
  legend.classList.add("legend-hidden");
  // Legend defaults to the closed (collapsed, reopen-button-only) state -
  // a reader has to explicitly reopen it, even once a chapter with active
  // map layers scrolls into view. See updateLegend() below, which keeps
  // this the steady state instead of popping back open on every chapter
  // that has no active layers.
  legend.classList.add("legend-closed");

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "legend-close";
  closeBtn.setAttribute("aria-label", "Close legend");
  // Above, because this legend is anchored bottom-left of the map and the
  // space over it is open basemap. The Explorer's copy sits top-left under
  // its title plate and points right instead.
  closeBtn.dataset.tip = "Click to hide the legend";
  closeBtn.dataset.tipPos = "above";
  closeBtn.innerHTML = "&times;";
  closeBtn.addEventListener("click", () => {
    legend.classList.add("legend-closed");
    if (reopenBtn) reopenBtn.classList.add("visible");
  });
  legend.appendChild(closeBtn);

  if (reopenBtn) {
    reopenBtn.addEventListener("click", () => {
      legend.classList.remove("legend-closed");
      reopenBtn.classList.remove("visible");
    });
  }

  Object.entries(legendConfig).forEach(([layerKey, section]) => {
    const box = createLegendSectionBox(layerKey, section, (el) => {
      const nowActive = !el.classList.contains("active");
      el.classList.toggle("active", nowActive);
      el.setAttribute("aria-checked", String(nowActive));
      setMapLayerVisibility(layerKey, nowActive);
    });
    legend.appendChild(box);
  });
}

function updateLegend(activeLayers) {
  const legend = document.getElementById("legend");
  const reopenBtn = document.getElementById("legend-reopen");
  // Count only keys that actually have a legend section. Some chapter layer
  // keys ("wind", "hillshade") drive map state but render nothing in the
  // legend - counting those would open an empty legend box on a chapter
  // whose only active layer has nothing to explain.
  const anyActive = Object.keys(LEGEND_CONFIG || {}).some((key) => activeLayers[key]);

  legend.classList.toggle("legend-hidden", !anyActive);

  if (reopenBtn) {
    const showReopen = anyActive && legend.classList.contains("legend-closed");
    reopenBtn.classList.toggle("visible", showReopen);
    // Closed is the persistent default - a chapter with no active layers
    // re-affirms it (rather than clearing it) so the legend doesn't pop
    // back open the next time an active-layer chapter is reached. Once a
    // reader explicitly reopens it (legend-reopen / legend-close handlers
    // above), it stays open until they close it again or scroll away.
    if (!anyActive) legend.classList.add("legend-closed");
  }

  // Chapter-scroll resets every section to that chapter's authored state -
  // it overwrites any manual toggle left over from the previous chapter.
  //
  // Scoped to #legend. Unscoped, this also reset the Block Explorer's pills
  // (same markup, same data-layer values) to whatever the nearest scroll
  // chapter happened to have on - so a reader who turned a layer on inside the
  // Explorer would watch it turn itself back off as they scrolled. The
  // Explorer owns that state via setExplorerLayerVisibility().
  document.querySelectorAll("#legend .legend-section").forEach((section) => {
    const key = section.dataset.layer;
    const active = Boolean(activeLayers[key]);
    section.classList.toggle("active", active);
    section.setAttribute("aria-checked", String(active));
  });
}

// The band is one shared MapLibre instance, so its title has to be re-set
// per chapter. Chapters that don't own the map are skipped rather than
// blanked: #map is only faded out on those (body.map-pos-none), and the
// plate is inside it, so clearing the text would just mean the title
// arrives a beat after the map on the way into the next map chapter.
//
// "mapTitle" is authored per chapter in data/chapters.json and says what
// the map is showing; chapter.title is the narrative headline and reads as
// a question or a claim ("See the Shape of Homestead"), so it is only the
// fallback for a map chapter that hasn't been given one yet.
function updateMapTitle(chapter) {
  const plate = document.getElementById("map-title");
  if (!plate) return;

  const position = chapter.mapPosition || "none";
  if (position === "none") return;

  plate.textContent = chapter.mapTitle || chapter.title;
}

// --- Media sidecar ----------------------------------------------------
// Fills and docks #media-sidecar for the chapter that currently owns the
// screen: a panel pinned to the viewport that holds that chapter's
// carousel while the reader is in it, and swaps its contents as they move
// on. Which side it takes, if any, comes from mediaPositionFor() - see
// there for the values. Called with null to hide it, for the stretches of
// the page that belong to no chapter at all (see setupMediaRegions()).
//
// Tracks whichever side the panel was docked to for the previously-active
// chapter, so a content swap only gets the extra crossfade treatment when
// the panel itself stays put - if it's appearing, disappearing or switching
// sides, its own opacity transition (see body.media-pos-* in the CSS)
// already makes that change smooth.
let lastMediaDockPosition = null;
let pendingMediaSwap = null;

function placeMediaForChapter(chapter) {
  const sidecar = document.getElementById("media-sidecar");
  if (!sidecar) return;

  const position = chapter ? mediaPositionFor(chapter) : "none";

  document.body.classList.remove(
    "media-pos-left",
    "media-pos-right",
    "media-pos-full",
    "media-pos-none"
  );
  document.body.classList.add(`media-pos-${position}`);

  const dockPositionChanged = lastMediaDockPosition !== position;
  lastMediaDockPosition = position;

  const swapContent = () => {
    sidecar.innerHTML = "";
    if (position !== "none") {
      sidecar.appendChild(renderMediaCarousel(normalizeMedia(chapter)));
    }
  };

  // A crossfade left half-finished by a faster change of owner would put
  // the previous chapter's media back and strand the panel at opacity 0.
  if (pendingMediaSwap !== null) {
    window.clearTimeout(pendingMediaSwap);
    pendingMediaSwap = null;
    sidecar.classList.remove("media-sidecar-swapping");
  }

  if (dockPositionChanged || position === "none") {
    swapContent();
  } else {
    // Docked to the same side as before, just showing a different
    // chapter's media (e.g. scrolling from one right-docked chapter
    // straight into the next) - crossfade the swap instead of an
    // abrupt cut from one image/video straight to another.
    sidecar.classList.add("media-sidecar-swapping");
    pendingMediaSwap = window.setTimeout(() => {
      pendingMediaSwap = null;
      swapContent();
      requestAnimationFrame(() => sidecar.classList.remove("media-sidecar-swapping"));
    }, 220);
  }
}

// --- Map framing (camera) ------------------------------------------------
// Computes the bounding box of every coordinate in a GeoJSON
// FeatureCollection. Used to fly/fit the map to a layer's true extent -
// the same idea as Esri's view.goTo(layer.fullExtent) - instead of a
// hand-tuned center+zoom, which only ever looks right at one window size
// and tends to crop or drift once you eyeball a "close enough" zoom level.
function computeBBox(geojson) {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;

  const walk = (coords) => {
    if (typeof coords[0] === "number") {
      const [lng, lat] = coords;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    } else {
      coords.forEach(walk);
    }
  };

  geojson.features.forEach((f) => walk(f.geometry.coordinates));
  return [
    [minLng, minLat],
    [maxLng, maxLat]
  ];
}

// Fetched directly (independent of the map's own tile loading) so a
// chapter's camera framing is available immediately, keyed by the same
// names used for the MapLibre sources below ("marin", "homestead").
async function loadLayerBounds() {
  const [marin, homestead] = await Promise.all([
    fetch("data/marin_county.geojson").then((r) => r.json()),
    fetch("data/homestead.geojson").then((r) => r.json())
  ]);
  return {
    marin: computeBBox(marin),
    homestead: computeBBox(homestead)
  };
}

// Moves the camera for a given chapter. A chapter can supply "fitToLayer"
// (one of the names returned by loadLayerBounds()) to reliably frame that
// layer's real extent regardless of viewport size/shape. Chapters that
// aren't framing a specific boundary layer fall back to a hand-tuned
// center/zoom/pitch/bearing ("location").
function flyToChapter(map, chapter, layerBounds, duration = 1200) {
  const bounds = chapter.fitToLayer && layerBounds[chapter.fitToLayer];
  if (bounds) {
    map.fitBounds(bounds, {
      padding: chapter.fitPadding || MAP_FIT_PADDING,
      pitch: chapter.location.pitch || 0,
      bearing: chapter.location.bearing || 0,
      duration
    });
  } else {
    map.flyTo({ ...chapter.location, duration });
  }
}

// --- Block Explorer -----------------------------------------------------
// A self-contained, interactive detour (not a narrative chapter) letting a
// reader click any of Homestead's numbered blocks (data/blocks.geojson) to
// see its Block Contact and description. Runs on its OWN MapLibre instance
// (not the shared docked #map) since it lives inline in the document flow
// instead of being pinned to the viewport - see renderExplorerSection() for
// the markup and initExplorerObserver() for how/when the map instance gets
// created.
const EXPLORER_EMPTY_FC = { type: "FeatureCollection", features: [] };

// The Explorer's own thematic layers, in the order they appear in its
// legend, mapped to the MapLibre layer id(s) each legend row switches.
// Deliberately separate from LEGEND_LAYER_IDS: the Explorer drives a second,
// independent map instance, so its layer ids are prefixed and its on/off
// state never touches the scroll-driven story map. Keys match
// data/chapters.json "legend" so both legends read off one config.
const EXPLORER_LAYER_IDS = {
  streets: [
    "explorer-streets-halo-main",
    "explorer-streets-halo-trail",
    "explorer-streets-main",
    "explorer-streets-trail"
  ],
  contours: [
    "explorer-contours-line-casing",
    "explorer-contours-line",
    "explorer-contours-label"
  ],
  vegetation: ["explorer-vegetation-fill"],
  elevation: ["explorer-elevation-fill"],
  homesteadHighlight: ["explorer-homestead-line"]
};

// The layers that belong to a single block, and so are switched on when one
// is selected and off again on reset. Everything in EXPLORER_LAYER_IDS
// except the CSA 14 boundary, which is valley-wide context and stays on at
// the overview scale - it's what tells a reader what they're looking at
// before they've picked anything.
const EXPLORER_BLOCK_LAYER_KEYS = Object.keys(EXPLORER_LAYER_IDS).filter(
  (key) => key !== "homesteadHighlight"
);

// Base (block-independent) filter for each clipped thematic layer, or null
// where the layer draws everything in its source. Declared here rather than
// inline in addExplorerThematicLayers() because it is needed in two places -
// once when the layer is created, and again every time a block is selected
// and the Block_No clause has to be re-composed on top of it. Two inline
// copies could drift apart and silently widen a filter.
const EXPLORER_BASE_FILTERS = {
  "explorer-elevation-fill": null,
  "explorer-vegetation-fill": null,
  "explorer-contours-line-casing": null,
  "explorer-contours-line": null,
  "explorer-contours-label": CONTOUR_LABEL_FILTER,
  "explorer-streets-halo-main": ROAD_MAIN_FILTER,
  "explorer-streets-halo-trail": ROAD_TRAIL_FILTER,
  "explorer-streets-main": ROAD_MAIN_FILTER,
  "explorer-streets-trail": ROAD_TRAIL_FILTER
};

let explorerMapInitialized = false;
let explorerHomeBounds = null;
let explorerMaskOuterRing = null;
let explorerSelectedBlockId = null;
let explorerPopup = null;

function escapeHtml(value) {
  return String(value == null ? "" : value).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

function renderExplorerSection() {
  const section = document.createElement("section");
  section.className = "explorer-section";
  section.id = "block-explorer";

  section.innerHTML = `
    <div class="explorer-header">
      <span class="explorer-badge">Interactive</span>
      <h2>Explore Your Block</h2>
      <p>Homestead Valley is organized into numbered blocks, each with a Block Contact who helps coordinate preparedness locally. Click a block to zoom to it and see its Block Contact, along with the roads, terrain and vegetation around it.</p>
    </div>
    <div class="explorer-map-wrap">
      <div id="explorer-map"></div>
      <div class="map-title map-title-static">Homestead Valley Block Map</div>
      <button type="button" id="explorer-fullscreen-btn" class="map-control-btn explorer-map-fullscreen" aria-label="Toggle fullscreen map" data-tip="Click for fullscreen map" data-tip-pos="left">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
      </button>
      <div class="explorer-map-controls">
        <div class="map-north-arrow" title="North" aria-hidden="true">
          <div class="map-north-rose" id="explorer-north-rose">
            <span class="map-north-label">N</span>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 2 20 22 12 17.4Z" fill="currentColor" />
              <path d="M12 2 20 22 12 17.4 4 22Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
            </svg>
          </div>
        </div>
        <button type="button" id="explorer-home-btn" class="map-control-btn" aria-label="Reset block view" data-tip="Click to return to the whole-valley view" data-tip-pos="left">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V9.5"/></svg>
        </button>
        <div class="map-control-zoom-group">
          <button type="button" id="explorer-zoom-in-btn" class="map-control-btn" aria-label="Zoom in" data-tip="Click to zoom in" data-tip-pos="left">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>
          </button>
          <button type="button" id="explorer-zoom-out-btn" class="map-control-btn" aria-label="Zoom out" data-tip="Click to zoom out" data-tip-pos="left">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>
          </button>
        </div>
      </div>
      <div class="explorer-legend" id="explorer-legend">
        <!-- Points LEFT, into the panel, which is the only direction with
             room. #explorer-legend is overflow: auto - it scrolls when the
             layer list is long - so the bubble cannot escape it in any
             direction, and this button is in its top-right corner: right
             clears the panel edge entirely (measured 190px of bubble
             against 8px of panel), above has 5px before the panel top,
             below runs off the right. Left ends ~50px inside the panel's
             left edge and simply overlays the layer list, which is what a
             tooltip is for. The story map's copy of this button is at the
             bottom-left of a panel that does not clip, and points above. -->
        <button type="button" class="legend-close" id="explorer-legend-close" aria-label="Hide map layers" data-tip="Click to hide the layer list" data-tip-pos="left">&times;</button>
        <p class="explorer-legend-hint" id="explorer-legend-hint">Pick a block to switch on its roads, terrain and vegetation</p>
        <div class="explorer-legend-sections" id="explorer-legend-sections"></div>
      </div>
      <button type="button" class="explorer-legend-reopen" id="explorer-legend-reopen" aria-label="Show map layers">Layers</button>
    </div>
  `;

  return section;
}

// GeoJSON polygon hole rings need to run the opposite winding direction
// from their outer ring to render correctly - reversing a ring's point
// order always flips its winding, regardless of what the source data used,
// so this doesn't need to know or care which convention blocks.geojson
// follows. Branches on geometry.type because blocks.geojson mixes 68
// Polygon features with one MultiPolygon (Block_No 1, two constituent
// shapes) - a MultiPolygon contributes one hole ring per constituent part.
function extractExteriorRings(geometry) {
  if (geometry.type === "Polygon") return [geometry.coordinates[0]];
  if (geometry.type === "MultiPolygon") return geometry.coordinates.map((poly) => poly[0]);
  return [];
}

// Builds a "spotlight" mask: a single Polygon feature whose first ring is a
// large fixed rectangle covering the whole map view, and whose remaining
// ring(s) are the selected block's own exterior ring(s), reversed (so they
// render as holes). Filled at high opacity, this darkens every block
// EXCEPT the selected one, without needing a turf.js/geometry-clipping
// dependency.
function buildExplorerMaskFeature(blockFeature, outerRing) {
  const holes = extractExteriorRings(blockFeature.geometry).map((ring) => ring.slice().reverse());
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "Polygon", coordinates: [outerRing, ...holes] }
  };
}

// Flips one legend row's map layer(s) AND that row's own switch state
// together, so the toggle pill can never drift out of sync with what's
// actually painted - whether the change came from a reader's click or from
// selectExplorerBlock() turning everything on at once.
function setExplorerLayerVisibility(map, layerKey, visible) {
  (EXPLORER_LAYER_IDS[layerKey] || []).forEach((id) => {
    if (map.getLayer(id)) {
      map.setLayoutProperty(id, "visibility", visible ? "visible" : "none");
    }
  });

  const box = document.querySelector(
    `#explorer-legend-sections .legend-section[data-layer="${layerKey}"]`
  );
  if (box) {
    box.classList.toggle("active", visible);
    box.setAttribute("aria-checked", String(visible));
  }
}

function setExplorerBlockLayers(map, visible) {
  EXPLORER_BLOCK_LAYER_KEYS.forEach((key) => setExplorerLayerVisibility(map, key, visible));
  const hint = document.getElementById("explorer-legend-hint");
  if (hint) hint.classList.toggle("hidden", visible);
  // With no block selected these rows have nothing to show, so they are
  // marked unavailable rather than left as switches that appear to do
  // nothing - the hint above them says what to do instead.
  EXPLORER_BLOCK_LAYER_KEYS.forEach((key) => {
    const box = document.querySelector(
      `#explorer-legend-sections .legend-section[data-layer="${key}"]`
    );
    if (!box) return;
    box.classList.toggle("legend-section-unavailable", !visible);
    box.setAttribute("aria-disabled", String(!visible));
  });
}

// The clipped layers hold one feature per (source feature x block) pair, each
// already trimmed to its block's outline, so confining a layer to one block is
// a plain equality test. Passing blockNo = null matches nothing, which is the
// correct state at the whole-valley overview where no block is framed. See
// block_clip_work/01_clip_layers_to_blocks.py for why the clip is baked into
// the data instead of done with MapLibre's `within` expression.
function setExplorerBlockFilter(map, blockNo) {
  const blockClause = ["==", ["get", "Block_No"], blockNo];
  Object.keys(EXPLORER_BASE_FILTERS).forEach((layerId) => {
    if (!map.getLayer(layerId)) return;
    const base = EXPLORER_BASE_FILTERS[layerId];
    map.setFilter(layerId, base ? ["all", blockClause, base] : blockClause);
  });
}

// Reuses the story legend's markup/CSS (.legend-section + its switch pill),
// but scoped inside the Explorer section instead of the fixed viewport
// legend, and reading the same data/chapters.json "legend" block so layer
// colors and class breaks are described identically in both places.
function renderExplorerLegend(map) {
  const host = document.getElementById("explorer-legend-sections");
  if (!host || !LEGEND_CONFIG) return;

  Object.keys(EXPLORER_LAYER_IDS).forEach((layerKey) => {
    const section = LEGEND_CONFIG[layerKey];
    if (!section) return;

    const box = createLegendSectionBox(layerKey, section, (el) => {
      if (el.classList.contains("legend-section-unavailable")) return;
      setExplorerLayerVisibility(map, layerKey, !el.classList.contains("active"));
    });
    host.appendChild(box);
  });

  const legend = document.getElementById("explorer-legend");
  const reopenBtn = document.getElementById("explorer-legend-reopen");
  document.getElementById("explorer-legend-close")?.addEventListener("click", () => {
    legend?.classList.add("legend-closed");
    reopenBtn?.classList.add("visible");
  });
  reopenBtn?.addEventListener("click", () => {
    legend?.classList.remove("legend-closed");
    reopenBtn.classList.remove("visible");
  });
}

function openExplorerPopup(map, props, lngLat) {
  const description =
    props.Description && props.Description.trim() ? props.Description : `Block ${props.Block_No}`;
  const captain =
    props.Block_Contact && props.Block_Contact.trim()
      ? props.Block_Contact
      : "Not yet assigned";

  if (!explorerPopup) {
    explorerPopup = new maplibregl.Popup({
      className: "explorer-popup",
      closeButton: true,
      // Dismissing the card is independent of the selection: closing it
      // leaves the block framed, spotlit and its layers on, so a reader can
      // clear the text out of the way and keep reading the map. Only the
      // home button returns to the whole-valley view.
      closeOnClick: false,
      maxWidth: "300px",
      offset: 14
    });
  }

  explorerPopup
    .setLngLat(lngLat)
    .setHTML(
      `
      <p class="explorer-popup-eyebrow">Block ${escapeHtml(props.Block_No)}</p>
      <h3>${escapeHtml(description)}</h3>
      <p class="explorer-popup-captain">
        <strong>Block Contact</strong>
        <span>${escapeHtml(captain)}</span>
      </p>
    `
    )
    .addTo(map);
}

function selectExplorerBlock(map, feature, lngLat) {
  if (explorerSelectedBlockId !== null) {
    map.setFeatureState({ source: "explorer-blocks", id: explorerSelectedBlockId }, { selected: false });
  }
  explorerSelectedBlockId = feature.id;
  map.setFeatureState({ source: "explorer-blocks", id: feature.id }, { selected: true });

  const maskSource = map.getSource("explorer-mask");
  if (maskSource && explorerMaskOuterRing) {
    maskSource.setData(buildExplorerMaskFeature(feature, explorerMaskOuterRing));
  }

  map.fitBounds(computeBBox({ features: [feature] }), { padding: 80, duration: 900 });

  // Narrow the thematic layers to this block BEFORE showing them, so no frame
  // is ever painted with the previous block's (or the whole valley's) extent.
  setExplorerBlockFilter(map, feature.properties.Block_No);

  // Every thematic layer comes on once a block is framed - at the whole-
  // valley overview they'd just stack into noise and bury the block
  // numbers, but at block scale they're the actual point of zooming in.
  // The legend then lets a reader switch off whichever ones they don't want.
  setExplorerBlockLayers(map, true);
  openExplorerPopup(map, feature.properties, lngLat);
}

function resetExplorer(map) {
  if (explorerSelectedBlockId !== null) {
    map.setFeatureState({ source: "explorer-blocks", id: explorerSelectedBlockId }, { selected: false });
    explorerSelectedBlockId = null;
  }
  const maskSource = map.getSource("explorer-mask");
  if (maskSource) maskSource.setData(EXPLORER_EMPTY_FC);
  if (explorerHomeBounds) {
    map.fitBounds(explorerHomeBounds, { padding: 40, duration: 900 });
  }
  setExplorerBlockLayers(map, false);
  setExplorerBlockFilter(map, null);
  if (explorerPopup) explorerPopup.remove();
}

function initExplorerMap() {
  if (explorerMapInitialized) return;
  explorerMapInitialized = true;

  const map = new maplibregl.Map({
    container: "explorer-map",
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: [-122.5472, 37.8956],
    zoom: 13.5,
    attributionControl: true,
    // Same reasoning as the main map (see initMap()) - this section sits
    // inline in the normal page flow, so uncaptured wheel input over the
    // map would fight page scroll. Custom zoom buttons cover zooming.
    scrollZoom: false
  });
  explorerMapInstance = map;

  initNorthArrow(map, "explorer-north-rose");

  document.getElementById("explorer-home-btn")?.addEventListener("click", () => resetExplorer(map));
  document.getElementById("explorer-zoom-in-btn")?.addEventListener("click", () => map.zoomIn());
  document.getElementById("explorer-zoom-out-btn")?.addEventListener("click", () => map.zoomOut());

  // The Explorer needs its OWN fullscreen button: the story map's button
  // lives inside the fixed #map element and can only ever expand that map,
  // so without this, clicking fullscreen anywhere on the page put the
  // narrative map on screen instead of the block map the reader was using.
  // Expands .explorer-map-wrap (not #explorer-map) so the legend and the
  // zoom/home controls, which are siblings of the canvas, come along.
  const explorerFullscreenBtn = document.getElementById("explorer-fullscreen-btn");
  const explorerWrap = document.querySelector(".explorer-map-wrap");
  if (explorerFullscreenBtn && explorerWrap) {
    explorerFullscreenBtn.addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        explorerWrap.requestFullscreen().catch(() => {});
      }
    });
    document.addEventListener("fullscreenchange", () => {
      if (document.fullscreenElement && document.fullscreenElement !== explorerWrap) return;
      window.setTimeout(() => map.resize(), 120);
    });
  }

  renderExplorerLegend(map);

  map.on("load", () => {
    addExplorerThematicLayers(map);
    fetch("data/blocks.geojson")
      .then((r) => r.json())
      .then((blocksGeojson) => {
        explorerHomeBounds = computeBBox(blocksGeojson);
        const [[minLng, minLat], [maxLng, maxLat]] = explorerHomeBounds;
        // Mask outer ring padded generously (3x the layer's own span) past
        // the blocks' real extent, so panning/zooming out never reveals its
        // edge as a visible seam.
        const padLng = (maxLng - minLng) * 3 || 0.2;
        const padLat = (maxLat - minLat) * 3 || 0.2;
        explorerMaskOuterRing = [
          [minLng - padLng, minLat - padLat],
          [maxLng + padLng, minLat - padLat],
          [maxLng + padLng, maxLat + padLat],
          [minLng - padLng, maxLat + padLat],
          [minLng - padLng, minLat - padLat]
        ];

        map.addSource("explorer-blocks", {
          type: "geojson",
          data: blocksGeojson,
          // Lets setFeatureState()/feature-state expressions key off each
          // block's real OBJECTID instead of an internal-only geometry
          // index, so the selected-block highlight survives re-renders.
          promoteId: "OBJECTID"
        });

        map.addLayer({
          id: "explorer-blocks-fill",
          type: "fill",
          source: "explorer-blocks",
          paint: {
            "fill-color": "#7f9cc4",
            // The SELECTED block goes fully transparent, not highlighted:
            // selecting it also switches on the vegetation/elevation/
            // contour/street layers underneath, and a tinted fill would
            // wash out exactly the detail the reader zoomed in to read.
            // The thick orange outline (below) plus the darkened surround
            // (explorer-mask-fill) already mark which block is active.
            "fill-opacity": [
              "case",
              ["boolean", ["feature-state", "selected"], false], 0,
              0.35
            ]
          }
        });

        map.addLayer({
          id: "explorer-blocks-line",
          type: "line",
          source: "explorer-blocks",
          paint: {
            "line-color": explorerBlockLineColor(),
            "line-width": [
              "case",
              ["boolean", ["feature-state", "selected"], false], 3,
              1
            ]
          }
        });

        // Spotlight mask - starts empty (no block selected yet), populated
        // by selectExplorerBlock()/cleared by resetExplorer(). Sits above
        // the fill/line layers but below the labels, so number labels stay
        // legible (via their white halo) even on dimmed, unselected blocks.
        map.addSource("explorer-mask", { type: "geojson", data: EXPLORER_EMPTY_FC });
        map.addLayer({
          id: "explorer-mask-fill",
          type: "fill",
          source: "explorer-mask",
          paint: { "fill-color": "#101418", "fill-opacity": 0.55 }
        });

        // Boundary LINE added after the mask so the CSA 14 outline stays
        // readable across the dimmed surround, and after every thematic
        // layer so nothing paints over it. Line only, no fill, per the
        // Explorer's brief.
        map.addSource("explorer-homestead", { type: "geojson", data: "data/homestead.geojson" });
        map.addLayer({
          id: "explorer-homestead-line",
          type: "line",
          source: "explorer-homestead",
          layout: { visibility: "none" },
          paint: { "line-color": "#000000", "line-width": 2 }
        });

        map.addLayer({
          id: "explorer-blocks-label",
          type: "symbol",
          source: "explorer-blocks",
          layout: {
            "text-field": ["get", "Block_No"],
            "text-font": ["Montserrat Regular", "Open Sans Regular", "Noto Sans Regular"],
            "text-size": 11,
            "text-allow-overlap": true,
            "text-ignore-placement": true
          },
          paint: {
            "text-color": themeColor("dark", "#0d1917"),
            "text-halo-color": "#ffffff",
            "text-halo-width": 1.2
          }
        });

        map.on("click", "explorer-blocks-fill", (e) => {
          if (!e.features || !e.features.length) return;
          selectExplorerBlock(map, e.features[0], e.lngLat);
        });

        // The CSA 14 boundary is the one layer on at the overview scale -
        // switched on here rather than via its layer's own `visibility` so
        // the legend row's switch state is set from the same call.
        setExplorerLayerVisibility(map, "homesteadHighlight", true);
        // Puts the four per-block rows into their "no block picked yet" state.
        setExplorerBlockLayers(map, false);

        map.fitBounds(explorerHomeBounds, { padding: 40, duration: 0 });
      });
  });
}

// The four context layers the Explorer stacks under the blocks - same
// symbology as the story map's equivalents (see initMap()), re-added here
// because this is a separate MapLibre instance with its own style object.
//
// They read the block_*.geojson files, not the valley-wide homestead_*
// originals: those are the same data pre-clipped to block outlines, one
// feature per (source feature x block) pair, so a Block_No filter confines
// each layer to the selected block exactly. All start hidden and match
// nothing; selectExplorerBlock() sets the filter and switches them on.
function addExplorerThematicLayers(map) {

  map.addSource("explorer-elevation", { type: "geojson", data: "data/block_elevation.geojson" });
  map.addLayer({
    id: "explorer-elevation-fill",
    type: "fill",
    source: "explorer-elevation",
    layout: { visibility: "none" },
    paint: {
      "fill-color": [
        "match",
        ["get", "elev_class"],
          1, "#F0F0F0",
          2, "#D9D9D9", 
          3, "#BDBDBD", 
          4, "#969696",
          5, "#737373", 
          6, "#525252", 
          7, "#353535", 
          8, "#1A1A1A",
        "#cccccc"
      ],
      "fill-opacity": 1
    }
  });

  map.addSource("explorer-vegetation", {
    type: "geojson",
    data: "data/block_vegetation.geojson"
  });
  map.addLayer({
    id: "explorer-vegetation-fill",
    type: "fill",
    source: "explorer-vegetation",
    layout: { visibility: "none" },
    paint: {
      "fill-color": [
        "match",
        ["get", "ndvi_class"],
        1, "#d9f0a3",
        2, "#78c679",
        3, "#31a354",
        4, "#006837",
        "#cccccc"
      ],
      "fill-opacity": 0.7
    }
  });

  map.addSource("explorer-contours", { type: "geojson", data: "data/block_contours.geojson" });
  map.addLayer({
    id: "explorer-contours-line-casing",
    type: "line",
    source: "explorer-contours",
    layout: { visibility: "none" },
    paint: {
      "line-color": LINE_HALO_COLOR,
      "line-width": CONTOUR_LINE_WIDTH + 2 * LINE_HALO_PAD,
      "line-opacity": LINE_HALO_OPACITY
    }
  });
  map.addLayer({
    id: "explorer-contours-line",
    type: "line",
    source: "explorer-contours",
    layout: { visibility: "none" },
    paint: {
      "line-color": "#8a6d3b",
      "line-width": CONTOUR_LINE_WIDTH,
      "line-opacity": 0.85
    }
  });
  map.addLayer({
    id: "explorer-contours-label",
    type: "symbol",
    source: "explorer-contours",
    layout: {
      visibility: "none",
      "symbol-placement": "line",
      "symbol-spacing": 220,
      "text-field": ["get", "label"],
      "text-font": ["Montserrat Regular", "Open Sans Regular", "Noto Sans Regular"],
      "text-size": 10,
      "text-keep-upright": true
    },
    paint: {
      "text-color": "#5c4826",
      "text-halo-color": themeColor("light", "#e9f1ee"),
      "text-halo-width": 1.4
    }
  });

  // Same symbology as the story map's road layers (see addRoadLayers) - the
  // per-layer filters set here are immediately re-composed with a Block_No
  // clause by the setExplorerBlockFilter() call below.
  map.addSource("explorer-streets", { type: "geojson", data: "data/block_streets.geojson" });
  addRoadLayers(map, {
    source: "explorer-streets",
    haloMainId: "explorer-streets-halo-main",
    haloTrailId: "explorer-streets-halo-trail",
    mainId: "explorer-streets-main",
    trailId: "explorer-streets-trail",
    mainFilter: ROAD_MAIN_FILTER,
    trailFilter: ROAD_TRAIL_FILTER
  });

  // Applies every layer's base filter from EXPLORER_BASE_FILTERS with a
  // Block_No clause that matches nothing, which is the right starting state:
  // no block is framed yet. Doing it here keeps the base filters declared in
  // exactly one place.
  setExplorerBlockFilter(map, null);
}

// Two observers on the same section, with different jobs and thresholds.
//
// 1. Lazily creates the Explorer's map instance the first time the section
//    scrolls anywhere near view, instead of paying for a second full
//    MapLibre instance + five GeoJSON fetches on every page load regardless
//    of whether the reader ever reaches it.
//
// 2. Lights up the Explorer's nav pill while the section owns the viewport.
//    It is a plain in-flow section, not a .chapter, so setupScrollTriggers()'
//    observer never fires for it and updateToolbar() never reaches it.
//
//
// The docked media panel used to be hidden from here too. It is now one of
// the regions in setupMediaRegions(), which owns no media and so hides the
// panel once the Explorer - rather than the chapter above it - is the
// bigger thing on screen.
function initExplorerObserver() {
  const section = document.getElementById("block-explorer");
  if (!section) return;

  const initObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          initExplorerMap();
          initObserver.disconnect();
        }
      });
    },
    { rootMargin: "200px", threshold: 0 }
  );
  initObserver.observe(section);

  const activeObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        // The nav pill only has to be claimed on the way in: scrolling back
        // out hands control straight back, because the next chapter to
        // cross the main observer's threshold calls updateToolbar(), which
        // re-marks its own section pill.
        if (entry.isIntersecting) showToolbarSection(EXPLORER_NAV_ID);
      });
    },
    { threshold: 0.35 }
  );
  activeObserver.observe(section);
}

// --- Map controls -------------------------------------------------------
// Re-aims a north arrow's rose at true north. Both maps keep MapLibre's
// drag-rotate (only scrollZoom is off), so the camera's bearing is not
// guaranteed to stay at the 0 every chapter is authored with - a rose
// painted at a fixed angle would quietly start lying the first time a
// reader right-drags the map.
function initNorthArrow(map, roseId) {
  const rose = document.getElementById(roseId);
  if (!rose) return;

  const aim = () => {
    rose.style.transform = `rotate(${-map.getBearing()}deg)`;
  };
  map.on("rotate", aim);
  aim();
}

// Custom-styled overlay controls (fullscreen top-right; home/zoom stacked
// bottom-right) in place of MapLibre's default NavigationControl, so we can
// match the client's reference design instead of the library's stock look.
function initMapControls(map, chapters, layerBounds) {
  const mapEl = document.getElementById("map");
  const fullscreenBtn = document.getElementById("map-fullscreen-btn");
  const homeBtn = document.getElementById("map-home-btn");
  const zoomInBtn = document.getElementById("map-zoom-in-btn");
  const zoomOutBtn = document.getElementById("map-zoom-out-btn");

  initNorthArrow(map, "map-north-rose");

  if (zoomInBtn) zoomInBtn.addEventListener("click", () => map.zoomIn());
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => map.zoomOut());

  if (homeBtn) {
    homeBtn.addEventListener("click", () => {
      const chapter =
        chapters.find((c) => c.id === currentChapterId) || chapters[0];
      flyToChapter(map, chapter, layerBounds);
    });
  }

  if (fullscreenBtn && mapEl) {
    // Snapshot of which chapter the reader was on when they hit fullscreen.
    // currentChapterId is read back on fullscreenchange, and belt-and-braces
    // against anything nudging it in between - this is the chapter the
    // reader actually asked to see full screen.
    let chapterAtFullscreen = null;

    fullscreenBtn.addEventListener("click", () => {
      if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        chapterAtFullscreen = currentChapterId;
        mapEl.requestFullscreen().catch(() => {});
      }
    });

    document.addEventListener("fullscreenchange", () => {
      // Only react to OUR map entering/leaving fullscreen - the Explorer
      // runs a second map with its own fullscreen button, and this handler
      // is on `document`, so it hears that one's events too.
      if (document.fullscreenElement && document.fullscreenElement !== mapEl) return;

      // map.resize() alone just stretches the existing camera: the docked
      // map is a 58%-wide panel, so its center/zoom belong to that viewport,
      // and carrying them into a full-screen canvas leaves the reader
      // looking at a differently-framed (stale-looking) view. Re-run the
      // ACTIVE chapter's fitBounds against the new canvas size instead, with
      // duration 0 so it's already correct the moment fullscreen paints.
      const wantedId = chapterAtFullscreen || currentChapterId;
      window.setTimeout(() => {
        map.resize();
        const chapter = chapters.find((c) => c.id === wantedId) || chapters[0];
        currentChapterId = chapter.id;
        flyToChapter(map, chapter, layerBounds, 0);
        // Fullscreen is the biggest single change the map panel ever makes
        // - a phone goes from a ~340px panel to the whole screen - so it is
        // the one moment the wind arrows are most likely to want a
        // different count in each direction.
        syncWindArrows(map, layerBounds.homestead);
      }, 120);
    });
  }
}

// --- Map --------------------------------------------------------------
function initMap(chapters, layerBounds) {
  // Park the map in the first map chapter's stage before MapLibre measures
  // the container. #map is absolutely positioned and takes its size from
  // whichever stage it is in, so anywhere else it is a zero-height box -
  // MapLibre would size its canvas to nothing and need a resize() to
  // recover.
  const firstMapChapter = chapters.find(
    (c) => c.mapPosition === "left" || c.mapPosition === "right"
  );
  if (firstMapChapter) {
    dockMapInStage(document.getElementById("map"), firstMapChapter.id);
  }

  const map = new maplibregl.Map({
    container: "map",
    // Free, no-API-key vector basemap (CARTO Positron). Swap for any other
    // open style (e.g. OpenFreeMap, MapLibre demo tiles) as needed.
    style: "https://basemaps.cartocdn.com/gl/positron-gl-style/style.json",
    center: chapters[0].location.center,
    zoom: chapters[0].location.zoom,
    pitch: chapters[0].location.pitch,
    bearing: chapters[0].location.bearing,
    attributionControl: true,
    // Scroll-wheel input drives the STORY (page scroll), not map zoom -
    // without this, scrolling over the map (which covers the whole
    // viewport) zooms the map instead of advancing chapters.
    scrollZoom: false
  });

  mapInstance = map;

  initMapControls(map, chapters, layerBounds);

  // Wired up here rather than inside map.on("load") below. Docking, the
  // legend and the toolbar are driven by scroll, not by the map, and "load"
  // only fires after MapLibre has rendered a frame - so anything that stops
  // that frame (no WebGL, a blocked tile CDN, a tab that never gets a
  // rAF callback) used to cost the reader all 46 chapters, not just the map:
  // body never got a map-pos-* class, so #map stayed at opacity 0 and the
  // media sidecar never docked. Every layer-touching call downstream is
  // already gated on mapLayersReady, so running early is safe.
  setupScrollTriggers(map, chapters, layerBounds);

  map.on("load", () => {
    // Marin County boundary (macro scale) - real County GIS data, converted
    // from shapefile (EPSG:2872) to WGS84. Outline only, no fill - it's just
    // context for where Homestead Valley sits within the county.
    map.addSource("marin-county", {
      type: "geojson",
      data: "data/marin_county.geojson"
    });
    map.addLayer({
      id: "marin-line",
      type: "line",
      source: "marin-county",
      layout: { visibility: "none" },
      paint: { "line-color": "#4a4a4a", "line-width": 1.5 }
    });

    // Homestead Valley / CSA 14 boundary (micro scale) - real Marin County
    // GIS data (469-acre service area), reprojected to WGS84. One paint
    // treatment only (the bold red highlight) - a second, duplicate black
    // dashed outline used to be layered on top of the same shape and was
    // removed per client feedback ("2 boundaries for CSA14, use only 1").
    //
    // Symbology now switches per chapter (see updateHomesteadBoundaryStyle):
    // bold red only on the chapter that also shows the Marin County outline
    // (so the CSA14 boundary reads clearly against the county context);
    // a subtle black outline + near-transparent black fill on chapters with
    // 0-1 other thematic layers; and a fully transparent fill (line only)
    // on chapters stacking 2+ thematic layers, so the boundary never washes
    // out or gets buried under vegetation/elevation/contours/streets color.
    // Only the FILL layer is added here - the LINE layer is added at the
    // very end of this block (after every thematic layer below) so it's
    // guaranteed to paint on top of all of them, never visually buried.
    map.addSource("homestead", {
      type: "geojson",
      data: "data/homestead.geojson"
    });
    map.addLayer({
      id: "homestead-highlight-fill",
      type: "fill",
      source: "homestead",
      layout: { visibility: "none" },
      paint: { "fill-color": "#000000", "fill-opacity": 0.08 }
    });

    // Terrain / elevation - real USGS 3DEP 1m LIDAR DEM (see topo_work/),
    // GDAL-polygonized (rasterio.features.shapes) into 8 hypsometric-tint
    // classes. Same colormap and class breaks as the reference cartographic
    // PNG (topo_work/homestead_topo_map.png / 09_render_map.py's "hyps"
    // colormap), so the vector map and the static graphic read as one
    // consistent symbology.
    map.addSource("elevation", {
      type: "geojson",
      data: "data/homestead_elevation.geojson"
    });
    map.addLayer({
      id: "elevation-fill",
      type: "fill",
      source: "elevation",
      layout: { visibility: "none" },
      paint: {
        "fill-color": [
          "match",
          ["get", "elev_class"],
            1, "#F0F0F0",
            2, "#D9D9D9", 
            3, "#BDBDBD", 
            4, "#969696",
            5, "#737373", 
            6, "#525252", 
            7, "#353535", 
            8, "#1A1A1A",
          "#cccccc"
        ],
        "fill-opacity": 1
      }
    });

    // Vegetation density (NDVI) - real Sentinel-2-derived classification for
    // this AOI (see ndvi_work/06_ndvi.py), not sample/dummy data. Four
    // classes on a light-to-dark green ramp, used as a visual proxy for fuel
    // load density across the wildland-urban interface.
    map.addSource("vegetation", {
      type: "geojson",
      data: "data/homestead_ndvi_vegetation.geojson"
    });
    map.addLayer({
      id: "vegetation-fill",
      type: "fill",
      source: "vegetation",
      layout: { visibility: "none" },
      paint: {
        "fill-color": [
          "match",
          ["get", "ndvi_class"],
          1, "#d9f0a3",
          2, "#78c679",
          3, "#31a354",
          4, "#006837",
          "#cccccc"
        ],
        "fill-opacity": 0.7
      }
    });

    // Smooth raster rendering of that same NDVI classification, drawn directly
    // over the vector fill. Only one of the two is ever visible at a time -
    // resolveVegetationLayerIds() decides which, after this block. See the
    // VEGETATION_* block for why both exist.
    addImageOverlayLayer(map, vegetationMeta, {
      layerId: VEGETATION_LAYER_ID,
      sourceId: VEGETATION_SOURCE_ID,
      paint: {
        // nearest, not the default linear. This is a CLASSIFIED image: linear
        // magnification would interpolate between two class colours and paint
        // a band of a fifth colour that appears in no legend. Blocking at the
        // overlay's own ~1.25 m/px is the honest failure mode, and it is eight
        // times finer than the 10 m staircase this layer exists to remove.
        "raster-resampling": "nearest"
      }
    });

    // Bivariate fuel x elevation - the joint classification behind the
    // "Where Do We Have the Greatest Ability to Intervene?" chapter. Built by
    // bivariate_work/ (01 derives the elevation breaks, 02 the palette, 03
    // does the joint classification + polygonize, 04 QAs the result cold).
    //
    // This is a separate PRE-BUILT layer rather than a restyling of the
    // vegetation and elevation layers because a bivariate map needs a single
    // joint classification on a common grid: the two source layers are
    // polygonized on different grids (Sentinel-2 10 m NDVI vs. a 1 m LIDAR
    // DEM) into different class counts (4 vs. 8), so there is no client-side
    // expression that could pair them up per-polygon.
    //
    // Extent is vegetated ground only (NDVI >= 0.41, under the same 200 m2
    // minimum mapping unit as the vegetation layer - 04's check 9 holds the
    // two footprints to 0.0001%), so the low column means "sparse fuel", not
    // "no fuel". Added here, after elevation and before contours/streets, so
    // roads and contour labels still draw over it and the boundary line added
    // at the end of this block still sits on top.
    map.addSource("bivariate", {
      type: "geojson",
      data: "data/homestead_bivariate.geojson"
    });
    map.addLayer({
      id: "bivariate-fill",
      type: "fill",
      source: "bivariate",
      layout: { visibility: "none" },
      paint: {
        "fill-color": BIVARIATE_FILL_COLOR,
        "fill-opacity": BIVARIATE_FILL_OPACITY
      }
    });

    // Terrain shade, added AFTER every thematic fill so it composites on top of
    // them - that layer order is the entire Multiply trick, see the HILLSHADE_*
    // block. Added BEFORE the contours, roads and boundary line that follow, so
    // those stay crisp: they are annotation, not terrain, and multiplying a
    // white road halo down to grey would cost legibility for no gain.
    addImageOverlayLayer(map, hillshadeMeta, {
      layerId: HILLSHADE_LAYER_ID,
      sourceId: HILLSHADE_SOURCE_ID
      // No raster-contrast / -brightness / -saturation here, deliberately.
      // They transform RGB and never alpha, so on an alpha-encoded operator
      // they cannot change its strength - only corrupt its black/white sign
      // channel. raster-opacity is the strength dial and defaults to 1 above.
    });

    // Elevation contour lines - real USGS 3DEP-derived contours (see
    // data/homestead_contours.geojson), shown alongside the elevation fill
    // above as the "topo" treatment on chapters that want it. A second
    // label layer calls out contours every CONTOUR_LABEL_INTERVAL_FT along
    // the line itself (text pre-formatted into the "label" property, e.g.
    // "100 ft"), so a reader can read actual elevation off the map instead
    // of just seeing undifferentiated lines. A white casing runs underneath
    // the brown line so both stay legible over the elevation choropleth.
    map.addSource("contours", {
      type: "geojson",
      data: "data/homestead_contours.geojson"
    });
    map.addLayer({
      id: "contours-line-casing",
      type: "line",
      source: "contours",
      layout: { visibility: "none" },
      paint: {
        "line-color": LINE_HALO_COLOR,
        "line-width": CONTOUR_LINE_WIDTH + 2 * LINE_HALO_PAD,
        "line-opacity": LINE_HALO_OPACITY
      }
    });
    map.addLayer({
      id: "contours-line",
      type: "line",
      source: "contours",
      layout: { visibility: "none" },
      paint: {
        "line-color": "#8a6d3b",
        "line-width": CONTOUR_LINE_WIDTH,
        "line-opacity": 0.85
      }
    });
    map.addLayer({
      id: "contours-label",
      type: "symbol",
      source: "contours",
      filter: CONTOUR_LABEL_FILTER,
      layout: {
        visibility: "none",
        "symbol-placement": "line",
        "symbol-spacing": 220,
        "text-field": ["get", "label"],
        "text-font": ["Montserrat Regular", "Open Sans Regular", "Noto Sans Regular"],
        "text-size": 10,
        "text-keep-upright": true
      },
      paint: {
        "text-color": "#5c4826",
        "text-halo-color": themeColor("light", "#e9f1ee"),
        "text-halo-width": 1.4
      }
    });

    // Road network - real OpenStreetMap extract (see
    // data/homestead_streets.geojson). Split into two layers: through-streets
    // (tertiary/residential) drawn solid, and service drives/footpaths/trails
    // drawn dotted. Same color and same width for both - the dot pattern is
    // the only difference, with a white halo under each so they stay readable
    // over vegetation/elevation fills and where they cross each other.
    map.addSource("streets", {
      type: "geojson",
      data: "data/homestead_streets.geojson"
    });
    addRoadLayers(map, {
      source: "streets",
      haloMainId: "streets-halo-main",
      haloTrailId: "streets-halo-trail",
      mainId: "streets-line-main",
      trailId: "streets-line-trail",
      mainFilter: ROAD_MAIN_FILTER,
      trailFilter: ROAD_TRAIL_FILTER
    });

    // Boundary LINE, added last (see the fill layer added earlier in this
    // block) so it renders on top of every thematic layer above - vegetation,
    // elevation, contours and streets can never visually bury the CSA14
    // outline, whatever combination of them a chapter turns on.
    map.addLayer({
      id: "homestead-highlight-line",
      type: "line",
      source: "homestead",
      layout: { visibility: "none" },
      paint: { "line-color": "#000000", "line-width": 2 }
    });

    try { buildWindArrows(map, layerBounds.homestead); }
    catch (e) { window.__windErr = String(e && e.stack || e); }
    window.__windBuilt = windArrowElements.length;

    // The arrows are a fixed pixel size on a map panel that is not, so the
    // number that fits changes with the window.
    //
    // Deliberately the map's own resize event, not the window's. The guard
    // asks cameraForBounds how the panel will be framed, and that reads the
    // CANVAS size - which MapLibre updates from its internal ResizeObserver,
    // after the window event has already been and gone. Listening on the
    // window measures the old canvas and concludes nothing has changed.
    //
    // syncWindArrows() no-ops unless the verdict actually changed, so this
    // stays cheap while a window edge is being dragged.
    map.on("resize", () => {
      syncWindArrows(map, layerBounds.homestead);
    });

    // Community Center, added after everything else (including the boundary
    // line and the wind arrows) so the landmark is never buried.
    //
    // The pin carries a white casing because these maps range from near-white
    // (sparse vegetation) to near-black (the top elevation class and the dark
    // corner of the bivariate surface), and a single-stroke mark legible on
    // one disappears on the other.
    ensureCommunityCenterIcon(map);

    map.addSource("community-center-point", {
      type: "geojson",
      data: COMMUNITY_CENTER_POINT_URL
    });
    map.addLayer({
      id: "community-center-point",
      type: "symbol",
      source: "community-center-point",
      layout: {
        visibility: "none",
        "icon-image": COMMUNITY_CENTER_ICON_ID,
        // Anchored at the tip, which is where the coordinate actually is.
        "icon-anchor": "bottom",
        // This is a single landmark on a map that already has contour
        // labels and street casings competing for space - it must never be
        // the thing that gets dropped from the collision pass.
        "icon-allow-overlap": true,
        "icon-ignore-placement": true
      }
    });

    // Both after the addLayer calls above, because both inspect what actually
    // got added, and both before mapLayersReady flips - applyChapterToMap()
    // below reads layer state off LEGEND_LAYER_IDS.
    resolveVegetationLayerIds(map);
    checkVegetationRampAgrees(extractRampColors(VEGETATION_RAMP_NORMAL));

    mapLayersReady = true;

    // Scroll triggers have been live since before the style finished, so the
    // chapter the reader is on already set its layer state once - against a
    // map that had no layers yet, where every call was a no-op. Replay it.
    const current = chapters.find((c) => c.id === currentChapterId) || chapters[0];
    applyChapterToMap(map, current);
    flyToChapter(map, current, layerBounds, 0);
  });

  return map;
}

// Moves the single shared MapLibre instance into one chapter's map stage.
//
// Ten chapters each show a full-width map band, but there is still only one
// WebGL context, so the element has to travel between their stages. That is
// invisible only because of the layout invariant in style.css: every
// .chapter-stage-text reserves at least 100vh beneath its stage, so two
// stages are never on screen at the same time and the stage being left has
// always scrolled past before the next one is reached.
//
// Moving a <canvas> between parents does not disturb its WebGL context, so
// this needs no re-initialisation - just a resize(), since the stage it
// lands in may be a different height than the one it left (it is not, at a
// fixed viewport, but it is after a rotate/resize).
function dockMapInStage(container, chapterId) {
  const section = document.getElementById(chapterId);
  const stage = section && section.querySelector(".chapter-map-stage");
  if (!stage || stage === container.parentElement) return;

  stage.appendChild(container);
}

// Shows or hides the map for the active chapter, and makes sure it is
// sitting in that chapter's stage before it is shown.
function placeMapForChapter(map, chapter) {
  const position = chapter.mapPosition || "none";

  document.body.classList.remove("map-pos-left", "map-pos-right", "map-pos-none");
  document.body.classList.add(`map-pos-${position}`);

  // Left where it is on a chapter with no map of its own: it is invisible
  // (body.map-pos-none) and parked in a stage far off screen, so moving it
  // would only cost a needless resize on the way past.
  if (position !== "none") dockMapInStage(map.getContainer(), chapter.id);

  map.resize();
}

// Chapter-scroll is the "authoritative" layer state - it always wins over
// whatever a reader manually toggled in the legend while they were on the
// previous chapter, so the narrative never gets stuck showing or hiding a
// layer the new chapter didn't ask for.
function applyChapterToMap(map, chapter) {
  Object.keys(LEGEND_LAYER_IDS).forEach((key) => {
    setMapLayerVisibility(key, Boolean(chapter.layers[key]));
  });
  updateHomesteadBoundaryStyle(map, chapter);
  updateThematicLayerStyle(map, chapter);
  updateWindIndicator(chapter);
}

function setupScrollTriggers(map, chapters, layerBounds) {
  // The docked media panel is deliberately NOT driven from here. A map
  // chapter has to claim the map the instant its band touches the bottom of
  // the viewport, or the reader watches an empty stage scroll past - but
  // that moment comes a whole screen before they have finished the section
  // above, so it is far too early to take that section's photograph away.
  // The panel follows the regions in setupMediaRegions() instead.
  const activate = (chapter) => {
    currentChapterId = chapter.id;
    placeMapForChapter(map, chapter);
    flyToChapter(map, chapter, layerBounds);
    applyChapterToMap(map, chapter);
    updateMapTitle(chapter);
    updateLegend(chapter.layers);
    updateToolbar(chapter.id, chapters);
  };

  // Going fullscreen hides the browser's own chrome, so the viewport gets
  // taller and every chapter's intersection ratio is recomputed - which
  // pushes a NEIGHBOURING chapter past its threshold and silently
  // re-activates it. That was the "fullscreen shows the previous map" bug:
  // the camera flew to the wrong chapter and its layers (wind arrows and
  // their key included) were switched off, all while the reader was
  // staring at the expanded map.
  //
  // Nothing is scrolling while a map is fullscreen, so there is no
  // legitimate chapter change to process - freeze until we exit.
  const onIntersect = (resolve) => (entries) => {
    if (document.fullscreenElement) return;
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      const chapter = resolve(entry.target);
      if (chapter) activate(chapter);
    });
  };

  const byId = (id) => chapters.find((c) => c.id === id);

  // A map chapter is driven by its stage, not by the section. The section
  // runs ~190vh (map band + a full screen of narrative), so it only reaches
  // a 0.5 ratio once the stage has climbed most of the way up the screen -
  // the reader would have watched an empty stage scroll past first. The
  // stage itself crossing the bottom edge of the viewport is the moment the
  // map has to be in place, which is exactly threshold 0 with no margin.
  //
  // That timing is also what keeps dockMapInStage()'s move off screen: with
  // 100vh of text between stages, a stage touching the bottom edge means
  // the previous one cleared the top edge a moment ago.
  const stageObserver = new IntersectionObserver(
    onIntersect((el) => {
      const section = el.closest(".chapter");
      return section && byId(section.id);
    }),
    { threshold: 0 }
  );
  document
    .querySelectorAll(".chapter-map-stage")
    .forEach((el) => stageObserver.observe(el));

  // Everything else is roughly a screen tall and has no stage to key off,
  // so it stays on the original "half of it is showing" rule. Stacked
  // chapters are excluded rather than observed by both: a section fires on
  // the way DOWN through 0.5 as well as up, which would let a chapter the
  // reader had already left re-claim the map from the one they were
  // entering.
  const observer = new IntersectionObserver(
    onIntersect((el) => byId(el.id)),
    { threshold: 0.5 }
  );
  document
    .querySelectorAll(".chapter:not(.chapter-stacked)")
    .forEach((el) => observer.observe(el));

  setupFooterRelease();
  setupMediaRegions(chapters);
}

// --- Media regions --------------------------------------------------------
// Which stretch of the page each chapter's photographs belong to. The
// docked panel shows the media of whichever region covers most of the
// screen, so a photograph appears as the reader scrolls into its region and
// stays put until the next region takes over.
//
// Two kinds of region, laid end to end down the story:
//
//   * a chapter's own stretch - the whole section for a plain chapter, but
//     only the narrative BELOW the band for a map chapter;
//   * a stretch that owns no media and therefore hides the panel: a map
//     band, and the Block Explorer (not a chapter at all, so nothing else
//     would ever release the panel over it).
//
// The band has to be its own region because the two big visuals live in
// different coordinate systems - the map is a full-width band IN the page,
// the panel is pinned to the VIEWPORT - so on a chapter with both, the
// panel would sit over the right-hand 58% of the map. Hiding it behind the
// map is not an option either: .chapter-map-stage is deliberately
// transparent so the page shows through the --map-frame-pad inset that
// makes the map read as a framed exhibit, and the panel would show through
// that gap as a band of photograph running around the frame. So the panel
// yields while the band owns the screen, which also gives the reader the
// two things in sequence - here is the ground, now here is the photograph
// of it - instead of making them compete for one screen.
//
// The panel used to be driven by chapter activation plus a guard that
// fired on a map stage merely touching the viewport's bottom edge. A
// section between two maps is taller than the screen, so the next band
// reached that edge while the reader was only halfway down the text - and
// the photograph both swapped away and faded out a full screen early.
let mediaRegions = [];
let currentMediaOwnerId;

function buildMediaRegions(chapters) {
  const regions = [];

  // One query so the regions come out in document order, which is what
  // makes a map chapter's band and narrative land in the right sequence.
  document.querySelectorAll("#story .chapter, #story #block-explorer").forEach((el) => {
    if (el.id === "block-explorer") {
      regions.push({ el, chapter: null });
      return;
    }

    const chapter = chapters.find((c) => c.id === el.id) || null;
    const stage = el.querySelector(".chapter-map-stage");
    const text = el.querySelector(".chapter-stage-text");

    if (stage && text) {
      regions.push({ el: stage, chapter: null });
      regions.push({ el: text, chapter });
    } else {
      regions.push({ el, chapter });
    }
  });

  return regions;
}

// Measured live rather than from cached document offsets: chapters move as
// web fonts land, as the carousel's images decode and as the sticky
// toolbar wraps, and a cache that misses any of those hands the panel to a
// region the reader is not in. These are all reads with no writes between
// them, so they are served from one layout pass.
//
// The panel starts below the fixed header + toolbar, so that strip is not
// part of the screen the regions are competing for.
function resolveMediaOwner() {
  const top =
    parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--nav-offset")
    ) || 0;
  const bottom = window.innerHeight;

  let owner = null;
  let ownerVisible = 0;

  mediaRegions.forEach((region) => {
    const rect = region.el.getBoundingClientRect();
    const visible = Math.min(rect.bottom, bottom) - Math.max(rect.top, top);
    if (visible > ownerVisible) {
      ownerVisible = visible;
      owner = region;
    }
  });

  return owner;
}

function updateMediaForScroll() {
  // Nothing legitimately scrolls while a map is fullscreen, but going
  // fullscreen does change the window height - and the resize that follows
  // would hand the panel to a region the reader never scrolled to. The
  // chapter they asked to see full screen is the one to stay on.
  if (document.fullscreenElement) return;

  const owner = resolveMediaOwner();
  const chapter = owner ? owner.chapter : null;
  const ownerId = chapter ? chapter.id : null;

  if (ownerId === currentMediaOwnerId) return;
  currentMediaOwnerId = ownerId;
  placeMediaForChapter(chapter);
}

function setupMediaRegions(chapters) {
  mediaRegions = buildMediaRegions(chapters);
  if (!mediaRegions.length) return;

  updateMediaForScroll();

  // resize covers leaving fullscreen and a rotate/window drag, both of
  // which can change which region owns the screen without a scroll.
  window.addEventListener("scroll", updateMediaForScroll, { passive: true });
  window.addEventListener("resize", updateMediaForScroll);
}

// --- Footer release -------------------------------------------------------
// #media-sidecar is position:fixed so it stays pinned to the viewport while
// the reader scrolls through chapters - that's the whole point of the
// docked-panel effect. But it means that once the reader scrolls past the
// last chapter, the panel would stay glued to the viewport and the footer
// would have to slide up *over* it to become visible (a "curtain" effect),
// rather than the footer simply appearing after it like normal content.
//
// Instead, right as the footer is about to enter the viewport, "release"
// the panel: switch it from fixed to absolute, anchored at the exact
// document position that puts its bottom edge flush against the footer's
// top edge. It keeps whatever it was showing (nothing gets hidden/removed)
// but becomes a normal document-flow element that scrolls away with the
// rest of the page instead of staying pinned - so the footer just follows
// directly beneath it, like any two stacked blocks. Scrolling back up above
// the footer re-pins it to fixed so the normal chapter-driven docking
// resumes.
//
// #map needs none of this: it lives inside its chapter's stage and already
// scrolls away with the page.
function setupFooterRelease() {
  const footer = document.getElementById("footer");
  const panel = document.getElementById("media-sidecar");
  if (!footer || !panel) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const footerTop = entry.boundingClientRect.top + window.scrollY;
          const height = panel.getBoundingClientRect().height;
          panel.style.position = "absolute";
          panel.style.top = `${footerTop - height}px`;
        } else {
          panel.style.position = "";
          panel.style.top = "";
        }
      });
    },
    { threshold: 0 }
  );

  observer.observe(footer);
}

// --- Nav offset ---------------------------------------------------------
// #header (fixed) and #toolbar (sticky, locks under it) together occupy the
// top of the viewport once the reader scrolls past the hero. Every chapter
// needs enough top clearance that its content doesn't scroll to a stop
// underneath that chrome, and scroll-margin has to match it so a nav jump
// lands in the right place. Both read one CSS custom property, kept in sync
// here so it never has to be hand-tuned to match the nav's actual rendered
// height - which still varies with the font size, the theme and how many
// section tabs wrap onto a second line.
function setupNavOffset(headerEl, toolbarEl) {
  if (!headerEl || !toolbarEl) return;

  const update = () => {
    const offset = headerEl.offsetHeight + toolbarEl.offsetHeight;
    document.documentElement.style.setProperty("--nav-offset", `${offset}px`);
    toolbarEl.style.top = `${headerEl.offsetHeight}px`;
  };

  update();

  if (window.ResizeObserver) {
    const resizeObserver = new ResizeObserver(update);
    resizeObserver.observe(headerEl);
    resizeObserver.observe(toolbarEl);
  } else {
    window.addEventListener("resize", update);
  }
}

// --- Bootstrap --------------------------------------------------------
async function bootstrap() {
  const [config, layerBounds, hillshade, vegetation] = await Promise.all([
    fetch("data/chapters.json").then((r) => r.json()),
    loadLayerBounds(),
    loadHillshadeMeta(),
    loadVegetationMeta()
  ]);

  // initMap() reads these straight off the module scope rather than taking them
  // as arguments, so they only have to be assigned before initMap() runs
  // (below) - not before renderChapters().
  hillshadeMeta = hillshade;
  vegetationMeta = vegetation;
  checkOverlayGridsAgree();

  applySettings(config.settings);
  // "themes" + "activeTheme" is the current shape; a lone legacy "theme" block
  // still works so an older chapters.json keeps rendering.
  THEMES = config.themes || (config.theme ? { custom: config.theme } : {});
  activeThemeName = resolveThemeName({ themes: THEMES, activeTheme: config.activeTheme });
  applyTheme(THEMES[activeThemeName], activeThemeName);
  LEGEND_CONFIG = config.legend;

  renderChapters(config.chapters);

  // Toolbar lives right after the hero section (not as a permanently fixed
  // header) so it scrolls normally under the intro and only sticks once the
  // reader scrolls past it - see "position: sticky" on #toolbar in CSS.
  const toolbar = renderToolbar(config.chapters);
  const heroSection = document.querySelector(".chapter.hero");
  const story = document.getElementById("story");
  if (heroSection) {
    heroSection.insertAdjacentElement("afterend", toolbar);
  } else {
    story.prepend(toolbar);
  }

  setupNavOffset(document.getElementById("header"), toolbar);

  renderLegendShell(config.legend);
  // The Community Center swatches are themed, so they are painted from the
  // live theme here rather than from chapters.json - same reason the
  // homesteadHighlight swatch is painted in updateHomesteadBoundaryStyle().
  updateCommunityCenterLegendSwatches();
  renderFooter(config.footer);
  initMap(config.chapters, layerBounds);
  setupVideoPauseOnScrollOut();
  initExplorerObserver();
}

bootstrap();
