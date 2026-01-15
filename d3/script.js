// script.js — upgraded viewer with class-checkboxes, subsampling, trails, log radial scale,
// Kepler propagator + cross-validation.
// Requires scene.json built by build_scene_data.py

// User-tunable defaults (change here if you like)
const DEFAULTS = {
  MAX_VISIBLE_BODIES: 800,   // safety cap for rendering at any moment
  TRAIL_LENGTH: 120,         // number of past points to show in trail
  TRAIL_POINT_STEP: 2,       // skip points for trail sampling (fewer = faster)
  SUBSAMPLE_CATEGORIES: [],  // example: ["moons"]
  SUBSAMPLE_AMOUNT: 0.2,     // default fraction used if category selected for subsample in UI
  LOG_RADIAL_EPS: 1e-3,      // offset to avoid log(0)
  START_PLAYING: true,       // viewer starts paused
};

// DOM elements
const svg = d3.select("#viz");
const width = +svg.node().clientWidth || 1000;
const height = +svg.node().clientHeight || 1000;
const center = { x: width/2, y: height/2 };

const playPauseBtn = document.getElementById("playPause");
const speedEl = document.getElementById("speed");
const timeSlider = document.getElementById("timeSlider");
const timeLabel = document.getElementById("timeLabel");
const legendDiv = d3.select("#legend");

// tooltip
const tooltip = d3.select("body")
  .append("div")
  .attr("id", "tooltip")
  .style("position", "absolute")
  .style("pointer-events", "none")
  .style("background", "#222")
  .style("color", "#fff")
  .style("padding", "6px 8px")
  .style("border-radius", "4px")
  .style("font-size", "12px")
  .style("display", "none")
  .style("z-index", 1000);

let scene = null;
let tIndex = 0;
let playing = DEFAULTS.START_PLAYING;
let speed = +speedEl.value;
let timer = null;

// UI toggles
playPauseBtn.onclick = () => {
  playing = !playing;
  playPauseBtn.textContent = playing ? "Pause" : "Play";
};
speedEl.oninput = (e) => { speed = +e.target.value; };

// load data
d3.json("data/scene.json").then(s => {
  scene = s;
  initUI();
  resetView();
  // updateTimeLabel(0);
  if (DEFAULTS.START_PLAYING) startTimer();
}).catch(err => {
  console.error("Failed to load data/scene.json", err);
  svg.append("text").attr("x",20).attr("y",40).attr("fill","#fff").text("Error: could not load data/scene.json");
});

// -----------------------------
// UI: class checkboxes + subsample controls
// -----------------------------
let classes = [];
let objectsByClass = {};
let activeObjects = new Set(); // ids currently selected for drawing
function initUI(){
  // group objects by class
  objectsByClass = {};
  scene.objects.forEach(o => {
    if (!objectsByClass[o.class]) objectsByClass[o.class] = [];
    objectsByClass[o.class].push(o);
  });
  classes = Object.keys(objectsByClass).sort();

  // draw checkboxes
  const controlArea = d3.select("#controls");
  // create a container for class checkboxes
  const boxWrap = controlArea.append("div").attr("id","classCheckboxes").style("display","inline-block");
  boxWrap.append("span").text("Classes: ").style("color","#fff").style("margin-right","8px");

  classes.forEach(cls => {
    const id = `chk_${cls}`;
    const label = boxWrap.append("label").style("margin-right","6px").style("color","#fff");
    label.append("input")
      .attr("type","checkbox")
      .attr("id", id)
      .on("change", (e) => { onClassToggle(cls, e.target.checked); });
    label.append("span").text(` ${cls} (${objectsByClass[cls].length})`);
    // per-class subsample fraction input
    boxWrap.append("input")
      .attr("type","number")
      .attr("min", 0.0).attr("max", 1.0).attr("step", 0.05)
      .attr("value", DEFAULTS.SUBSAMPLE_CATEGORIES.includes(cls) ? DEFAULTS.SUBSAMPLE_AMOUNT : 1.0)
      .style("width","64px")
      .style("margin-left","4px")
      .on("change", function(){
        // update subsample fraction for this class
        const val = +this.value;
        clsSubsampleFrac[cls] = Math.max(0, Math.min(1, isNaN(val) ? 1 : val));
      });
  });

  // add a button to clear all
  boxWrap.append("button").text("Clear All").style("margin-left","10px").on("click", () => {
    classes.forEach(cls => {
      document.getElementById(`chk_${cls}`).checked = false;
      onClassToggle(cls, false);
    });
  });

  // Initialize class subsample fractions map
  classes.forEach(c => { clsSubsampleFrac[c] = 1.0; });
}

// map of class->fraction to subsample at drawing time
const clsSubsampleFrac = {};

// called whenever a class checkbox is toggled
function onClassToggle(cls, checked){
  if(!checked){
    // remove all objects of that class from activeObjects
    objectsByClass[cls].forEach(o => activeObjects.delete(o.id));
  } else {
    // pick a subsample fraction
    const frac = clsSubsampleFrac[cls] !== undefined ? clsSubsampleFrac[cls] : 1.0;
    const arr = objectsByClass[cls].slice();
    // deterministic-ish subsample: shuffle with seeded RNG? Use Math.random for simplicity
    shuffleArray(arr);
    const nKeep = Math.max(1, Math.floor(arr.length * frac));
    arr.slice(0, nKeep).forEach(o => activeObjects.add(o.id));
  }
  redrawBodies(); // re-render
}

// small fisher-yates
function shuffleArray(a){
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()* (i+1));
    [a[i],a[j]] = [a[j],a[i]];
  }
}

// -----------------------------
// view transforms (log radial mapping)
// -----------------------------
function worldToScreenLog(x, y, maxRadiusPixels= Math.min(width,height)/2 - 20) {
  // radial distance
  const r = Math.sqrt(x*x + y*y);
  // convert to km if needed — scene metadata says 'km (assumed)'
  // apply log transform: map [min_r, max_r] to [0, maxRadiusPixels]
  // We'll compute a dynamic mapping based on data extents stored when resetView runs
  const eps = DEFAULTS.LOG_RADIAL_EPS;
  const logr = Math.log10(r + eps);
  const s = (logr - view.min_logr) / (view.max_logr - view.min_logr + 1e-12);
  const radial_px = s * maxRadiusPixels;
  const theta = Math.atan2(y, x);
  const px = center.x + radial_px * Math.cos(theta);
  const py = center.y + radial_px * Math.sin(theta);
  return [px, py];
}

// view metadata filled in resetView()
const view = {
  min_r: null,
  max_r: null,
  min_logr: null,
  max_logr: null
};

// compute extents & initialize svg
function resetView(){
  // background color
  svg.style("background-color", "#222");

  // compute radial extents across all available points (sample a subset for speed)
  let minr = Infinity, maxr = 0;
  const sampleN = Math.min(200000, scene.metadata.time_count * scene.objects.length);//200000
  // simple approach: iterate objects and find their max radius across their valid points
  scene.objects.forEach(o => {
    for (let i=0;i<o.x.length;i+=Math.max(1, Math.floor(o.x.length/500))){
      const xx = o.x[i], yy = o.y[i];
      if (xx !== null && yy !== null){
        const r = Math.sqrt(xx*xx + yy*yy);
        minr = Math.min(minr, r);
        maxr = Math.max(maxr, r);
      }
    }
  });
  if (!isFinite(minr)) { minr = 0; maxr = 1; }
  // clamp minr slightly >0 to avoid log(0)
  minr = Math.max(minr, 1e-6);
  view.min_r = minr;
  view.max_r = Math.max(maxr, minr * 1.0001);
  view.min_logr = Math.log10(view.min_r + DEFAULTS.LOG_RADIAL_EPS);
  view.max_logr = Math.log10(view.max_r + DEFAULTS.LOG_RADIAL_EPS);

  // prepare groups
  svg.selectAll("*").remove();
  svg.append("g").attr("id","trails");
  svg.append("g").attr("id","bodies");
}

// -----------------------------
// rendering & state
// -----------------------------
function redrawBodies(){
  // we draw bodies that are in activeObjects set, but cap to MAX_VISIBLE_BODIES for performance
  const bodiesGroup = svg.select("#bodies");
  const trailsGroup = svg.select("#trails");
  bodiesGroup.selectAll("*").remove();
  trailsGroup.selectAll("*").remove();

  // collect objects to display
  const objs = scene.objects.filter(o => activeObjects.has(o.id));
  if(objs.length > DEFAULTS.MAX_VISIBLE_BODIES){
    console.warn(`Requested to draw ${objs.length} bodies, but MAX_VISIBLE_BODIES=${DEFAULTS.MAX_VISIBLE_BODIES}; drawing first ${DEFAULTS.MAX_VISIBLE_BODIES}.`);
  }
  const drawObjs = objs.slice(0, DEFAULTS.MAX_VISIBLE_BODIES);

  // compute a pixel radius scale: map diameter_km to pixels
  const diams = drawObjs.map(o => o.diameter_km).filter(d => d != null);
  const minD = diams.length ? Math.max(0.1, d3.min(diams)) : 1;
  const maxD = diams.length ? d3.max(diams) : 1000;
  const radiusScale = d3.scaleSqrt().domain([minD, maxD]).range([1.5, 10]);

  // draw trails
  drawObjs.forEach(o => {
    const color = o.color || "#cccccc";
    // gather trail points up to current index, step TRIAL_POINT_STEP, limited to TRAIL_LENGTH
    const pts = [];
    for (let k = Math.max(0, tIndex - DEFAULTS.TRAIL_LENGTH*DEFAULTS.TRAIL_POINT_STEP); k <= tIndex; k += DEFAULTS.TRAIL_POINT_STEP){
      const idx = Math.floor(k);
      if (idx < 0 || idx >= o.x.length) continue;
      const xx = o.x[idx], yy = o.y[idx];
      if (xx === null || yy === null) continue;
      const [px, py] = worldToScreenLog(xx, yy);
      pts.push({px, py});
    }
    if (pts.length < 2) return;
    // create many small segments with gradient opacity (tail fade)
    const total = pts.length;
    for (let s = 0; s < total - 1; s++){
      const p0 = pts[s], p1 = pts[s+1];
      const alpha = (s+1) / total; // older points small alpha; we want older smaller -> invert:
      const invAlpha = Math.pow(alpha, 2) * 0.75; // curve
      trailsGroup.append("line")
        .attr("x1", p0.px).attr("y1", p0.py)
        .attr("x2", p1.px).attr("y2", p1.py)
        .attr("stroke", color)
        .attr("stroke-width", 1)
        .attr("stroke-opacity", invAlpha * 0.9)
        .attr("vector-effect", "non-scaling-stroke");
    }
  });

  // draw bodies (circles)
  const bg = bodiesGroup.selectAll("g.body").data(drawObjs, d => d.id);
  const entering = bg.enter().append("g").attr("class", "body").attr("data-id", d => d.id);
  entering.append("circle")
    .attr("r", d => d.diameter_km ? radiusScale(d.diameter_km) : 2.0)
    .attr("fill", d => d.color || "#ddd")
    .attr("stroke", "rgba(0,0,0,0.3)")
    .attr("stroke-width", 0.6)
    .on("mouseover", function(event, d){
      // show tooltip
      tooltip.style("display", "block").html(`<strong>${d.id}</strong><br/>class: ${d.class}`);
      d3.select(this).attr("stroke-width", 1.6);
    })
    .on("mousemove", function(event, d){
      tooltip.style("left", (event.pageX + 12) + "px").style("top", (event.pageY + 6) + "px");
    })
    .on("mouseout", function(event, d){
      tooltip.style("display", "none");
      d3.select(this).attr("stroke-width", 0.6);
    });

  // position update
  updateScene(tIndex);
}

// updateScene: place bodies and update trails (called every frame)
function updateScene(index){
  if (!scene) return;
  tIndex = Math.floor(Math.max(0, Math.min(index, scene.times_jd.length - 1)));
  timeSlider.value = tIndex;
  //updateTimeLabel(tIndex);

  // update trails & bodies positions using current tIndex
  const bodiesGroup = svg.select("#bodies");
  const trailsGroup = svg.select("#trails");
  // compute which bodies currently are drawn
  const drawn = scene.objects.filter(o => activeObjects.has(o.id)).slice(0, DEFAULTS.MAX_VISIBLE_BODIES);

  // update circles
  bodiesGroup.selectAll("g.body").each(function(d){
    // if data-bound, reposition
    const circle = d3.select(this).select("circle");
    const x = d.x[tIndex], y = d.y[tIndex];
    if (x === null || y === null){
      circle.attr("display", "none");
      return;
    }
    const [px, py] = worldToScreenLog(x, y);
    circle.attr("cx", px).attr("cy", py).attr("display", null);
  });

  // redraw trails cheaply: just call redrawBodies to rebuild trails & bodies (simpler / robust)
  // but to keep animation smooth, we selectively update rather than fully re-create:
  // we'll simply call redrawBodies at moderate intervals (every N frames). For simplicity here, call once:
  // Note: previous redrawBodies already draws trails up to tIndex. Avoid duplicate heavy operations per tick.
}

// time label
function updateTimeLabel(idx){
  const jd = scene.times_jd[idx];
  timeLabel.textContent = `JD ${jd.toFixed(5)} (${idx}/${scene.times_jd.length-1})`;
}

// timer
function startTimer(){
  if (timer) timer.stop();
  timer = d3.timer((elapsed) => {
    if (!playing) return;
    // advance by speed * small step
    const step = 0.5 * speed; // frames per tick
    tIndex += step;
    if (tIndex >= scene.times_jd.length) tIndex = 0;
    // update periodically and redraw trails/bodies
    updateScene(tIndex);
    // recompute trails occasionally
    redrawBodies();
  });
}
function stopTimer(){
  if (timer) { timer.stop(); timer = null; }
}

// connect slider
timeSlider.oninput = function(e){
  playing = false;
  playPauseBtn.textContent = "Play";
  tIndex = +this.value;
  updateScene(tIndex);
  redrawBodies();
};

// start/stop via UI button
playPauseBtn.onclick = function(){
  playing = !playing;
  playPauseBtn.textContent = playing ? "Pause" : "Play";
  if (playing) startTimer(); else stopTimer();
};

// -----------------------------
// Kepler orbital-element propagator (JS) and cross-validation
// -----------------------------
// We'll implement generic Kepler solver: given orbital elements a (AU), e, i (deg),
// and assumed additional angles Omega, omega, M0 (not usually in our quick diam table),
// compute heliocentric position in same units as a (AU) -> convert to km for comparison if needed.
// Many objects won't have all elements; cross-validation only runs when we have enough elements.

const AU_KM = 149597870.7;
const MU_SUN = 1.32712440018e11; // km^3 / s^2

function solveKepler(M, e, tol=1e-9, maxiter=80){
  // Solve for eccentric anomaly E given mean anomaly M and eccentricity e
  // M in radians; returns E (radians)
  M = ((M % (2*Math.PI)) + 2*Math.PI) % (2*Math.PI);
  let E = e < 0.8 ? M : Math.PI;
  for (let i=0;i<maxiter;i++){
    const f = E - e*Math.sin(E) - M;
    const fp = 1 - e*Math.cos(E);
    const dE = -f / fp;
    E += dE;
    if (Math.abs(dE) < tol) break;
  }
  return E;
}

function elementsToPosition(a_AU, e, i_deg, Omega_deg=0, omega_deg=0, M_deg=0, epochJD=2451545.0, targetJD=null){
  // returns position in km (x,y,z heliocentric ecliptic)
  // If targetJD is provided, propagate mean anomaly linearly from epochJD assuming M_deg at epochJD.
  // a_AU -> convert to km
  const a_km = a_AU * AU_KM;
  const i = i_deg * Math.PI/180;
  const Omega = Omega_deg * Math.PI/180;
  const omega = omega_deg * Math.PI/180;
  // mean motion n (rad/s)
  const n = Math.sqrt(MU_SUN / (a_km*a_km*a_km));
  // M in radians at target
  const M0 = M_deg * Math.PI/180;
  let M = M0;
  if (targetJD !== null){
    // time difference in seconds
    const dt = (targetJD - epochJD) * 86400.0;
    M = M0 + n * dt;
  }
  const E = solveKepler(M, e);
  // true anomaly
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const sqrt1e2 = Math.sqrt(1 - e*e);
  const nu = Math.atan2(sqrt1e2 * sinE, cosE - e);
  const r = a_km * (1 - e * cosE);
  // position in perifocal frame
  const x_pf = r * Math.cos(nu);
  const y_pf = r * Math.sin(nu);
  const z_pf = 0;
  // rotate from perifocal to ecliptic/inertial using Rz(-Omega) Rx(-i) Rz(-omega)
  // combined rotation matrix:
  const cosO = Math.cos(Omega), sinO = Math.sin(Omega);
  const cosi = Math.cos(i), sini = Math.sin(i);
  const cosw = Math.cos(omega), sinw = Math.sin(omega);
  // matrix elements
  const r11 = cosO*cosw - sinO*sinw*cosi;
  const r12 = -cosO*sinw - sinO*cosw*cosi;
  const r13 = sinO*sini;
  const r21 = sinO*cosw + cosO*sinw*cosi;
  const r22 = -sinO*sinw + cosO*cosw*cosi;
  const r23 = -cosO*sini;
  const r31 = sinw*sini;
  const r32 = cosw*sini;
  const r33 = cosi;
  const x = r11*x_pf + r12*y_pf + r13*z_pf;
  const y = r21*x_pf + r22*y_pf + r23*z_pf;
  const z = r31*x_pf + r32*y_pf + r33*z_pf;
  return [x, y, z];
}

// Cross-validate function: for objects that include elements, compute positions at several JD samples and compute RMS resid (km)
function crossValidateElements(obj, numSamples=10){
  if (!obj.elements || !obj.elements.a_AU || obj.elements.e === undefined || obj.elements.i_deg === undefined){
    return null;
  }
  const times = scene.times_jd;
  // sample up to numSamples times equally spaced over valid indices where obj.x != null
  const validIdx = [];
  for (let i=0;i<times.length;i++){
    if (obj.x[i] !== null && obj.y[i] !== null) validIdx.push(i);
  }
  if (validIdx.length < 3) return null;
  const samples = [];
  const step = Math.max(1, Math.floor(validIdx.length / numSamples));
  for (let j=0;j<validIdx.length && samples.length < numSamples; j += step){
    samples.push(validIdx[j]);
  }
  let sqsum = 0;
  let count = 0;
  for (const idx of samples){
    const jd = times[idx];
    // compute propagated pos (x,y,z) in km using elements (a in AU)
    const [px, py, pz] = elementsToPosition(obj.elements.a_AU, obj.elements.e, obj.elements.i_deg, 0, 0, 0, 2451545.0, jd);
    // compare to CSV positions (which we assume are km)
    const dx = (obj.x[idx] || 0) - px;
    const dy = (obj.y[idx] || 0) - py;
    const dz = (obj.z[idx] || 0) - pz;
    sqsum += dx*dx + dy*dy + dz*dz;
    count += 1;
  }
  if (count === 0) return null;
  const rms = Math.sqrt(sqsum / count);
  return {rms_km: rms, samples: count};
}

// Optionally compute cross-validate summary for objects that have elements (run on demand)
function crossValidateAll(limit=200){
  const results = [];
  let examined = 0;
  for (const obj of scene.objects){
    if (!obj.elements) continue;
    const res = crossValidateElements(obj, 6);
    if (res) {
      results.push({id: obj.id, class: obj.class, rms_km: res.rms_km, samples: res.samples});
      examined++;
    }
    if (examined >= limit) break;
  }
  console.log("Cross-validation results (first", results.length, "objects):", results.slice(0,20));
  // summary stats:
  const rmsvals = results.map(r => r.rms_km);
  if (rmsvals.length){
    const mean = d3.mean(rmsvals), med = d3.median(rmsvals);
    console.log(`Cross-validate summary: count=${rmsvals.length}, mean RMS=${mean.toFixed(3)} km, median=${med.toFixed(3)} km`);
  } else {
    console.log("No objects with usable elements found for cross-validation.");
  }
}

// expose cross-validate button in UI
(function addCrossValidateButton(){
  const ctrl = d3.select("#controls");
  ctrl.append("button").text("Cross-validate elements").style("margin-left","10px").on("click", ()=>{
    if (!scene) return;
    crossValidateAll(200);
  });
})();

// -----------------------------
// end file
// -----------------------------
