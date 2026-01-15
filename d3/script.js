// script.js
// D3 viewer for orbital_trajectories/d3/data/scene.json
// Top-down view (X,Y) with time slider, play/pause, and sizing by diameter.

const svg = d3.select("#viz");
const width = +svg.attr("width") || 1000;
const height = +svg.attr("height") || 700;
const center = { x: 0.5 * width, y: 0.5 * height };

// parameters for visual scaling
const visual = {
  // spatial scaling: we compute extents of X/Y and fit them into the canvas with margins
  margin: 40,
  sun_radius_visual: 12 // visual radius for the Sun (we will scale worlds relative to it)
};

let scene = null;
let playing = true;
let speed = 1.0;
let tIndex = 0;
let timer = null;

// UI elements
const playPauseBtn = document.getElementById("playPause");
const speedEl = document.getElementById("speed");
const timeSlider = document.getElementById("timeSlider");
const timeLabel = document.getElementById("timeLabel");

playPauseBtn.onclick = () => {
  playing = !playing;
  playPauseBtn.textContent = playing ? "Pause" : "Play";
};

speedEl.oninput = (e) => {
  speed = +e.target.value;
};

timeSlider.oninput = (e) => {
  tIndex = +e.target.value;
  updateScene(tIndex);
  playing = false;
  playPauseBtn.textContent = "Play";
};

// load scene.json
d3.json("data/scene.json").then(s => {
  scene = s;
  setupScene();
  // start automatic play
  start();
}).catch(err => {
  console.error("Failed to load scene.json — run the build script first to produce data/scene.json.", err);
  svg.append("text").attr("x",20).attr("y",40).text("Error loading data/scene.json. See console.");
});

function setupScene(){
  const times = scene.times_jd;
  // slider
  timeSlider.min = 0;
  timeSlider.max = Math.max(0, times.length - 1);
  timeSlider.value = 0;

  // compute extents for X and Y to build scales
  let xs = [], ys = [];
  scene.objects.forEach(obj => {
    obj.x.forEach(x => { if (x !== null) xs.push(x); });
    obj.y.forEach(y => { if (y !== null) ys.push(y); });
  });
  const xmin = d3.min(xs), xmax = d3.max(xs);
  const ymin = d3.min(ys), ymax = d3.max(ys);

  // build scales: world (km) -> screen
  const spanX = xmax - xmin;
  const spanY = ymax - ymin;
  const span = Math.max(spanX, spanY);
  // center around origin (sun) if origin near 0; otherwise center on mean
  const xmid = (xmax + xmin) / 2;
  const ymid = (ymax + ymin) / 2;

  const scale = d3.scaleLinear()
    .domain([xmid - span/2, xmid + span/2])
    .range([visual.margin, Math.min(width, height) - visual.margin]);

  // we will use same scale for x and y (square)
  svg.attr("viewBox", `0 0 ${width} ${height}`);

  // draw Sun at origin (0,0) - convert its coordinates via scale:
  const sunX = scale(0);
  const sunY = scale(0); // center projection
  const sunGroup = svg.append("g").attr("id","sunGroup");
  // visual radius for sun: we'll compute a visible size: use real solar radius = 695700 km, but scale to canvas
  const SOLAR_RADIUS_KM = 695700; // assumed
  // compute visual radius for Sun using linear mapping of kilometers to pixels:
  // pixel_per_km ~ (range width in px) / span (km)
  const px_per_km = (Math.min(width, height) - 2*visual.margin) / span;
  // small role: clamp the visual Sun radius so it's visible
  const sun_radius_pixels = Math.max(6, Math.min(40, px_per_km * SOLAR_RADIUS_KM * 0.00005)); // scaled down
  sunGroup.append("circle")
    .attr("class","sun")
    .attr("cx", sunX)
    .attr("cy", sunY)
    .attr("r", sun_radius_pixels)
    .attr("fill", "url(#sunGradient)")
    .attr("stroke", "orange")
    .attr("stroke-width", 1.5);

  // add defs for glow
  const defs = svg.append("defs");
  const grad = defs.append("radialGradient").attr("id","sunGradient");
  grad.append("stop").attr("offset","0%").attr("stop-color","#fff7d6").attr("stop-opacity",1);
  grad.append("stop").attr("offset","30%").attr("stop-color","#ffefb5").attr("stop-opacity",1);
  grad.append("stop").attr("offset","100%").attr("stop-color","#ffbf6b").attr("stop-opacity",0.8);

  // prepare a group for bodies
  const bodiesG = svg.append("g").attr("id","bodies");

  // compute a diameter scaling function: map diameters (km) to pixel radii
  // use the distribution of known diameters; if diameter missing, set a small default
  const diams = scene.objects.map(o => o.diameter_km).filter(d => d !== null);
  const dmin = diams.length ? d3.min(diams) : 0.5;
  const dmax = diams.length ? d3.max(diams) : 10000;
  const radiusScale = d3.scaleSqrt().domain([dmin, Math.max(dmin, dmax)]).range([1.5, 24]);

  // Build screen positions method
  function worldToScreenX(x) { return scale(x); }
  function worldToScreenY(y) { return scale(y); }

  // create a node for each object with initial positions
  scene.objects.forEach((obj, idx) => {
    // initial position at times[0]
    const x0 = obj.x[0] === null ? 0 : obj.x[0];
    const y0 = obj.y[0] === null ? 0 : obj.y[0];
    const px = worldToScreenX(x0);
    const py = worldToScreenY(y0);
    const r = (obj.diameter_km !== null) ? radiusScale(obj.diameter_km) : 2.0;
    const g = bodiesG.append("g").attr("class", "body-group").attr("data-id", obj.id);
    g.append("circle")
      .attr("class","node")
      .attr("cx", px)
      .attr("cy", py)
      .attr("r", r)
      .attr("fill", obj.color || "#ccc")
      .attr("opacity", 0.9)
      .on("mouseover", (e) => {
        const t = d3.select(e.target.parentNode).datum();
      });
    // a text label (hidden by default)
    g.append("text").attr("x", px + r + 3).attr("y", py + 3).text(obj.id).attr("font-size","9px").attr("fill","#fff").attr("opacity",0.8).style("pointer-events","none");
    // store reference to element for updates
    obj.__el = g.select("circle");
    obj.__label = g.select("text");
  });

  // legend
  const legendDiv = d3.select("#legend");
  legendDiv.html("");
  // show sample of classes & colors (up to 10)
  const classGroups = d3.rollup(scene.objects, v => v.length, d=>d.class);
  const items = Array.from(classGroups.entries()).slice(0, 20);
  const legendHtml = items.map(([cls, cnt]) => {
    const color = scene.objects.find(o => o.class === cls).color || "#ccc";
    return `<span style="display:inline-block;margin-right:8px;"><svg width="18" height="12"><rect width="18" height="12" fill="${color}"></rect></svg> ${cls} (${cnt})</span>`;
  }).join(" ");
  legendDiv.html(legendHtml);

  // expose update function closure
  window.__internal = { scene, times: scene.times_jd, radiusScale, scale, worldToScreenX, worldToScreenY, sun: {x:sunX, y:sunY, r:sun_radius_pixels} };

  // set initial time label
  updateScene(0);
}

function updateScene(index) {
  if (!scene) return;
  const times = scene.times_jd;
  index = Math.max(0, Math.min(times.length - 1, index));
  tIndex = index;
  timeSlider.value = index;
  // convert JD to human-date: show JD value in label
  const jd = times[index];
  timeLabel.textContent = `JD: ${jd.toFixed(5)} (index ${index}/${times.length-1})`;

  // update each object's position
  scene.objects.forEach(obj => {
    const x = obj.x[index];
    const y = obj.y[index];
    if (x === null || y === null) {
      // hide
      obj.__el.attr("opacity", 0.0);
      obj.__label.attr("opacity", 0.0);
    } else {
      const px = window.__internal.worldToScreenX(x);
      const py = window.__internal.worldToScreenY(y);
      obj.__el
        .attr("cx", px)
        .attr("cy", py)
        .attr("opacity", 1.0);
      obj.__label
        .attr("x", px + (+obj.__el.attr("r") + 3))
        .attr("y", py + 3)
        .attr("opacity", 0.9);
    }
  });
}

function start(){
  if(timer) timer.stop();
  timer = d3.timer((elapsed) => {
    if (!playing) return;
    // step timeIndex by a function of elapsed * speed
    // we'll increment by fractional steps; but slider is integer-indexed so we map accordingly.
    const step = 0.02 * speed; // tune baseline step
    let next = tIndex + step;
    if (next >= scene.times_jd.length) {
      next = 0;
    }
    const intNext = Math.floor(next);
    // update only when integer index changed to keep slider discrete
    if (intNext !== tIndex) {
      updateScene(intNext);
    }
    tIndex = next;
  });
}

