# Orbital Map — D3.js (converted from Matplotlib Python)

This repository contains a D3.js port of a Matplotlib polar/logarithmic orbital figure. It reproduces the major plotting math and layers from the Python script and adds interactive behavior:
- Default opacity of orbits and bodies = **0.8**.
- Hover or keyboard focus on a body/orbit → that object's orbit & body transition to **1.0 opacity** and the `name` label appears.
- Zoom & pan with mouse/touch gestures; `Reset zoom` button returns to default.
- Keyboard accessible: bodies are `tabindex=0` and respond to focus/blur.

---

## Files
- `index.html` — entry point.
- `style.css` — styling for the visualization and UI.
- `script.js` — D3 code. **This file ports these Python functions/consts exactly**:
  - `MIN10 = log10(2.7e7)`
  - `MAX10 = log10(1.496e10)`
  - Ported functions: `get_angle` -> `getAngle` (via `Math.atan2`), `hypotenuse` -> `hypotenuse`, `get_r_theta` -> `getRTheta`, `get_size` -> `getMatplotlibArea`.
  - Polar-log mapping: `rs = log10(r) - MIN10` (same as Python).
- `data/colors.csv` — color mapping used to style orbits/bodies.
- `data/sample_index.csv` — a small index file for demo (you should replace or add your own index CSVs).
- `data/objects/*.csv` — per-object trajectory CSVs (columns `X,Y`), representing time series of cartesian coordinates — used to compute orbits. The sample folder contains small demo files.

---

## How to run (important)
Because modern browsers block `file://` CSV access due to CORS, run a simple static server from the project directory:

```bash
# Python 3:
python -m http.server 8000
# then open:
http://localhost:8000
