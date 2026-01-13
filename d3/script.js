// script.js (updated for folder structure with multiple index CSVs)
// Adapted to use data/*.csv files listed in your project root: data/{planets,moons,large_asteroids,...}.csv
// Preserves the ported math from the Python script (MIN10/MAX10, get_r_theta, get_size, radial log mapping).

// ---------- Configuration & constants (ported math) ----------
const MIN10 = Math.log10 ? Math.log10(2.7e7) : Math.log(2.7e7) / Math.LN10;
const MAX10 = Math.log10 ? Math.log10(1.496e10) : Math.log(1.496e10) / Math.LN10;
const RADIAL_DOMAIN_MAX = MAX10 - MIN10;

const PADDING = 40;
const SVG_SIZE = Math.min(window.innerWidth, window.innerHeight) * 0.86;
const WIDTH = SVG_SIZE;
const HEIGHT = SVG_SIZE;
const CENTER = { x: WIDTH / 2, y: HEIGHT / 2 };

// size mapping params (tweak as needed)
const SIZE_SCALE = 0.85;
const MIN_RADIUS_PX = 1;
const MAX_RADIUS_PX = 40;

// Paths: index files present in your repo (from the tree you provided)
const INDEX_FILES = [
  "data/planets.csv",
  "data/moons.csv",
  "data/large_asteroids.csv",
  "data/large_comets.csv",
  "data/small_asteroids.csv",
  "data/any_inner_asteroids.csv",
  "data/any_outer_asteroids.csv",
  "data/all_asteroids.csv",
  "data/all_asteroids_wrangled.csv",
  "data/all_comets.csv",
  "data/all_comets_wrangled.csv"
];

// try two likely color files: plotting_functions/colors.csv used by Python, or fallback to data/colors.csv
const COLORS_CANDIDATES = [
  "data/plotting_functions/colors.csv",
  "data/colors.csv"
];

// ---------- Helpers ----------
function log10(x) { return Math.log10 ? Math.log10(x) : Math.log(x) / Math.LN10; }

function hypotenuse(x0, y0, x1, y1) {
  const dx = x1 - x0, dy = y1 - y0;
  return Math.hypot ? Math.hypot(dx, dy) : Math.sqrt(dx*dx + dy*dy);
}

// getRTheta: mimic Python get_r_theta (rs = log10(r) - MIN10, theta in radians from atan2)
function getRTheta(xs, ys) {
  const rs = [];
  const thetas = [];
  for (let i = 0; i < xs.length; i++) {
    const x = +xs[i], y = +ys[i];
    const r = hypotenuse(0, 0, x, y);
    const rlog = log10(Math.max(r, 1e-30)) - MIN10;
    rs.push(rlog);
    thetas.push(Math.atan2(y, x));
  }
  return { rs, thetas };
}

// get_size: area = (log10(diameter))^2 (same as Python)
function getMatplotlibArea(diameter) {
  if (!isFinite(diameter) || diameter <= 0) return NaN;
  const v = log10(diameter);
  return Math.pow(v, 2);
}
function areaToRadiusPx(area) {
  if (!isFinite(area) || area <= 0) return MIN_RADIUS_PX;
  const r = Math.sqrt(area) * SIZE_SCALE;
  return Math.max(MIN_RADIUS_PX, Math.min(MAX_RADIUS_PX, r));
}

// ---------- SVG & scales ----------
const rScale = d3.scaleLinear()
  .domain([0, RADIAL_DOMAIN_MAX])
  .range([0, Math.min(WIDTH, HEIGHT) / 2 - PADDING]);

const svg = d3.select("#viz-wrap")
  .append("svg")
  .attr("width", WIDTH)
  .attr("height", HEIGHT)
  .attr("viewBox", `0 0 ${WIDTH} ${HEIGHT}`)
  .attr("role", "img")
  .attr("aria-label", "Orbital map");

svg.append("rect")
  .attr("width", WIDTH)
  .attr("height", HEIGHT)
  .attr("fill", "transparent");

const gMain = svg.append("g")
  .attr("transform", `translate(${CENTER.x},${CENTER.y})`);

const layers = {
  orbits: gMain.append("g").attr("id", "layer-orbits"),
  bodies: gMain.append("g").attr("id", "layer-bodies"),
  labels: gMain.append("g").attr("id", "layer-labels"),
  axis: gMain.append("g").attr("id", "layer-axis")
};

// tooltip
const tooltip = d3.select("body").append("div")
  .attr("class", "tooltip")
  .style("display", "none");

// ---------- Axis ticks (same logic as earlier) ----------
function drawAxis() {
  const lmin = Math.floor(MIN10);
  const lmax = Math.floor(MAX10);
  const axisG = layers.axis;
  axisG.selectAll("*").remove();

  for (let t = lmin; t <= lmax; t++) {
    const rpx = rScale(t - MIN10);
    axisG.append("circle")
      .attr("r", rpx)
      .attr("cx", 0).attr("cy", 0)
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.06)")
      .attr("stroke-width", 0.6);
  }

  [0, 90, 180, 270].forEach(deg => {
    const rad = deg * Math.PI / 180;
    const x = Math.cos(rad) * rScale(RADIAL_DOMAIN_MAX);
    const y = Math.sin(rad) * rScale(RADIAL_DOMAIN_MAX);
    axisG.append("line")
      .attr("x1", 0).attr("y1", 0)
      .attr("x2", x).attr("y2", y)
      .attr("stroke", "rgba(255,255,255,0.06)")
      .attr("stroke-width", 0.6);
  });
}
drawAxis();

// ---------- Data loading utilities ----------
// try to fetch colors CSV from candidate paths in order
async function loadColors() {
  for (const p of COLORS_CANDIDATES) {
    try {
      const rows = await d3.csv(p);
      if (rows && rows.length > 0) return rows;
    } catch (e) {
      // try next
    }
  }
  console.warn("colors.csv not found in plotting_functions or data; continuing with default colors.");
  return []; // empty color map -> default colors will be used
}

// load all index CSVs and tag each row with the source (basename without extension)
async function loadAllIndexes() {
  const allRows = [];
  for (const idxPath of INDEX_FILES) {
    try {
      const rows = await d3.csv(idxPath);
      const basename = idxPath.split('/').pop().replace(/\.csv$/i, "");
      rows.forEach(r => {
        r._sourceIndex = basename; // track which file it came from
        allRows.push(r);
      });
    } catch (e) {
      // If a specific index file is missing, log and continue
      console.warn(`Index file ${idxPath} could not be loaded (ignored):`, e);
    }
  }
  return allRows;
}

// try a sequence of candidate folders to locate per-object trajectories
async function findTrajectoryForHorizon(horizonValue, sourceIndexName) {
  // sanitise horizon string
  const horizon = (horizonValue === undefined || horizonValue === null) ? "" : String(horizonValue).trim();
  if (!horizon) return null;

  // candidate folders in probable order (prefer folder matching source index)
  const candidates = [];

  // add folder derived from the source index (e.g., planets -> data/planets/<horizon>.csv)
  if (sourceIndexName) candidates.push(`data/${sourceIndexName}`);

  // add some common folders used in the original Python pipeline
  const common = [
    'data/planets',
    'data/moons',
    'data/large_asteroids',
    'data/large_comets',
    'data/small_asteroids',
    'data/any_inner_asteroids',
    'data/any_outer_asteroids',
    'data/objects',
    'data'
  ];
  common.forEach(c => {
    if (!candidates.includes(c)) candidates.push(c);
  });

  for (const folder of candidates) {
    const path = `${folder}/${horizon}.csv`;
    try {
      const t = await d3.csv(path);
      // success: return trajectory rows (could be empty but treat empty as failure)
      if (t && t.length > 0) return { traj: t, filename: path };
    } catch (err) {
      // ignore and continue to next candidate
    }
  }

  // nothing found
  return null;
}

// ---------- Main initialization (async) ----------
async function init() {
  // 1) load colors
  const colorsRows = await loadColors();
  const colorMap = new Map();
  colorsRows.forEach(r => {
    colorMap.set(r.class, { color: r.color, zorder: parseInt(r.zorder || 0), label: r.label || r.class });
  });

  // 2) load all index CSVs into one combined array (tagged with _sourceIndex)
  const indexRows = await loadAllIndexes();

  // 3) sort by zorder (use colorMap; default zorder 0)
  indexRows.sort((a, b) => {
    const za = colorMap.get(a.class) ? colorMap.get(a.class).zorder : 0;
    const zb = colorMap.get(b.class) ? colorMap.get(b.class).zorder : 0;
    return za - zb;
  });

  // 4) for each index row, try to load its trajectory (sequentially or in parallel)
  // We'll assemble a list of promises to fetch trajectories (with fallback behaviour)
  const trajPromises = indexRows.map(async (row) => {
    // horizons field used in original Python; fallback candidates 'horizons', 'horizon', 'spkid', 'id'
    const horizonCandidates = [
      row.horizons, row.horizon, row.horizons_id, row.horizonsId, row.spkid, row.id, row.pdes, row.name
    ].filter(Boolean).map(String);

    for (const h of horizonCandidates) {
      const found = await findTrajectoryForHorizon(h, row._sourceIndex);
      if (found) {
        return { meta: row, traj: found.traj, filename: found.filename };
      }
    }

    // if none of those matched, return meta with null traj (so later fallback to q will be used)
    return { meta: row, traj: null, filename: null };
  });

  // wait for all fetches
  const objects = await Promise.all(trajPromises);

  // render
  renderObjects(objects, colorMap);
}

// ---------- renderObjects: draws orbits, bodies, labels ----------
function renderObjects(objects, colorMap) {
  const orbitLayer = layers.orbits;
  const bodyLayer = layers.bodies;
  const labelLayer = layers.labels;

  // clear layers (useful if re-rendering)
  orbitLayer.selectAll("*").remove();
  bodyLayer.selectAll("*").remove();
  labelLayer.selectAll("*").remove();

  objects.forEach(obj => {
    const meta = obj.meta || {};
    const source = meta._sourceIndex || "unknown";
    const classInfo = colorMap.get(meta.class) || { color: "#bfc6ff", zorder: 0, label: meta.class || "unknown" };
    const color = classInfo.color || "#bfc6ff";

    const id = meta.id || meta.spkid || meta.horizons || (meta.name ? meta.name.replace(/\s+/g,'_') : Math.random().toString(36).slice(2,8));
    const diameter = parseFloat(meta.diameter);
    const q = parseFloat(meta.q);

    // Build xs, ys from trajectory if available
    let xs = [], ys = [];
    if (obj.traj && obj.traj.length > 0) {
      obj.traj.forEach(r => {
        // Expect per-object CSV to have columns "X" and "Y" (as in the Python pipeline)
        if (r.X !== undefined && r.Y !== undefined) {
          xs.push(+r.X);
          ys.push(+r.Y);
        } else if (r.x !== undefined && r.y !== undefined) {
          xs.push(+r.x);
          ys.push(+r.y);
        }
      });
    }

    // fallback to q if no trajectory
    let rsArr = [], thetaArr = [];
    if (xs.length > 0) {
      const rt = getRTheta(xs, ys);
      rsArr = rt.rs;
      thetaArr = rt.thetas;
    } else if (!isNaN(q)) {
      rsArr = [log10(q) - MIN10];
      thetaArr = [0];
    } else {
      // nothing to plot - skip
      return;
    }

    // convert polar arrays to xy points in px (centered at 0,0)
    const points = rsArr.map((rVal, i) => {
      const rpx = rScale(rVal);
      const theta = thetaArr[i];
      return [rpx * Math.cos(theta), rpx * Math.sin(theta)];
    });

    // build path
    const lineGen = d3.line().x(d => d[0]).y(d => d[1]).curve(d3.curveLinear);

    const orbitId = `orbit-${id}`;
    const bodyId = `body-${id}`;
    const labelId = `label-${id}`;

    // Draw orbit path
    orbitLayer.append("path")
      .attr("d", lineGen(points))
      .attr("id", orbitId)
      .attr("class", "orbit")
      .attr("stroke", color)
      .attr("fill", "none")
      .style("opacity", 0.8)
      .on("pointerenter", (e) => _onPointerEnter(e, { id, meta }))
      .on("pointerleave", (e) => _onPointerLeave(e, { id, meta }));

    // draw last point as circle
    const last = points[points.length - 1];
    const area = getMatplotlibArea(diameter);
    const r_px = areaToRadiusPx(area);
    const px = last[0], py = last[1];

    // group so keyboard focus and events attach to group
    const g = bodyLayer.append("g")
      .attr("class", "object-g")
      .attr("transform", `translate(${px},${py})`)
      .attr("data-id", id)
      .attr("tabindex", 0)
      .attr("role", "button")
      .attr("aria-label", `${meta.name || meta.full_name || ""} (diameter: ${meta.diameter || "unknown"} km, class: ${meta.class || ""})`)
      .on("pointerenter", (e) => _onPointerEnter(e, { id, meta }))
      .on("pointerleave", (e) => _onPointerLeave(e, { id, meta }))
      .on("focus", (e) => _onPointerEnter(e, { id, meta }))
      .on("blur", (e) => _onPointerLeave(e, { id, meta }));

    g.append("circle")
      .attr("id", bodyId)
      .attr("class", "body")
      .attr("r", r_px)
      .attr("cx", 0).attr("cy", 0)
      .attr("fill", color)
      .style("opacity", 0.8);

    // label (in the label layer so we can hide/show without interfering with events)
    const labelOffsetX = 6;
    const labelOffsetY = 0;
    labelLayer.append("text")
      .attr("id", labelId)
      .attr("class", "label")
      .attr("x", px + labelOffsetX)
      .attr("y", py + labelOffsetY)
      .text(meta.name || meta.full_name || "")
      .style("opacity", 0)
      .attr("data-for", id);
  });

  // put labels above bodies
  labelLayer.raise();
}

// ---------- hover/focus behaviour (same semantics) ----------
function _onPointerEnter(e, d) {
  const id = d.id;
  const orb = d3.select(`#orbit-${id}`);
  const body = d3.select(`#body-${id}`);
  const label = d3.select(`#label-${id}`);

  orb.raise();
  body.raise();

  orb.transition().duration(180).style("opacity", 1);
  body.transition().duration(180)
    .style("opacity", 1)
    .attr("r", function() {
      const current = +d3.select(this).attr("r");
      return Math.min(MAX_RADIUS_PX, current * 1.25);
    });

  if (!label.empty()) {
    label.raise();
    label.style("display", null).transition().duration(150).style("opacity", 1);
  }

  if (d.meta) {
    const tHtml = `<strong>${d.meta.name || d.meta.full_name || ""}</strong><br/>class: ${d.meta.class || ""} · diameter: ${d.meta.diameter || "?"} km`;
    tooltip.html(tHtml)
      .style("left", (e.pageX + 12) + "px")
      .style("top", (e.pageY + 12) + "px")
      .style("display", "block")
      .style("opacity", 0)
      .transition().duration(120).style("opacity", 1);
  }
}

function _onPointerLeave(e, d) {
  const id = d.id;
  const orb = d3.select(`#orbit-${id}`);
  const body = d3.select(`#body-${id}`);
  const label = d3.select(`#label-${id}`);

  orb.transition().duration(180).style("opacity", 0.8);
  body.transition().duration(180)
    .style("opacity", 0.8)
    .attr("r", function() {
      const current = +d3.select(this).attr("r");
      return Math.max(MIN_RADIUS_PX, current / 1.25);
    });

  if (!label.empty()) {
    label.transition().duration(120).style("opacity", 0)
      .on("end", function() { d3.select(this).style("display", "none"); });
  }

  tooltip.transition().duration(80).style("opacity", 0).on("end", () => tooltip.style("display", "none"));
}

// ---------- Zoom & pan ----------
const zoom = d3.zoom()
  .scaleExtent([0.4, 12])
  .on("zoom", (event) => {
    gMain.attr("transform", `translate(${event.transform.x + CENTER.x},${event.transform.y + CENTER.y}) scale(${event.transform.k})`);
  });

svg.call(zoom);
d3.select("#resetZoom").on("click", () => {
  svg.transition().duration(350).call(zoom.transform, d3.zoomIdentity);
});

// ---------- Start ----------
init().catch(err => console.error("Init error:", err));
