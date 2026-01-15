# Orbital Trajectories — D3 visualization

## Overview

This folder contains:

- `tools/build_scene_data.py`: a script that reads the original CSV files in `../data/` and writes a single `data/scene.json` used by the D3 viewer.
- `data/scene.json`: (generated) unified dataset of times and per-object positions (X, Y, Z) on a common time grid.
- `index.html`, `script.js`, `style.css`: the D3 viewer that animates the orbits with a time slider.

### Quick usage

1. Ensure you have Python 3 (optionally `numpy` for speed).
2. From the repo root:
   ```bash
   cd orbital_trajectories/d3/tools
   python3 build_scene_data.py

This creates `orbital_trajectories/d3/data/scene.json`.

3. Serve the `d3/` directory via a local HTTP server (browsers block `fetch` from `file://`):

   ```bash
   cd orbital_trajectories/d3
   python3 -m http.server 8000
   ```

   Open `http://localhost:8000` in your browser and the viewer will load.

---

## Data assumptions & units

* The CSV position files are parsed assuming they contain lines where the first floating-point number is the Julian Date (JDTDB) and the last three floating numbers are the Cartesian coordinates X, Y, Z. Example line:

  ```
  2447213.500092593  A.D. 1988-Feb-22 00:00:08.0000   5.758001980323024E+08  4.625209696018425E+08  -1.83E+07
  ```
* I assume X,Y,Z are in **kilometers** (typical for many JPL Cartesian outputs). If your files are in AU, meters, or other units, convert them to km before building the scene.
* Times are Julian Dates (JDTDB). The viewer displays the JD value. You can convert JD to calendar dates as desired.

---

## How orbits are shown

* The build script creates a unified time grid (union of all timestamps across objects) and interpolates each object's X,Y,Z onto that grid. This makes time-indexed animation simple: at each time index, every object has a (possibly `null`) position.
* The D3 viewer plots top-down projection (X,Y); Z is kept in the JSON for future 3D or perspective projections.

---

## Orbital mechanics — short technical primer

This viewer uses measured/recorded Cartesian state vectors (positions) to animate objects. If you wanted to **compute** positions from **orbital elements** instead, the standard two-body (Keplerian) approach is:

### Keplerian elements

The classical orbital elements are:

* (a) — semi-major axis
* (e) — eccentricity
* (i) — inclination
* (\Omega) — longitude of ascending node
* (\omega) — argument of periapsis
* (M) — mean anomaly at epoch (or (n), the mean motion)

Mean motion:
[
n = \sqrt{\dfrac{\mu}{a^3}}
]
where (\mu = G(M_\text{Sun} + m_\text{body}) \approx GM_\text{Sun}) for small bodies.

Kepler's equation:
[
M = E - e \sin E
]
Solve numerically (Newton iteration) for the eccentric anomaly (E), given mean anomaly (M).

Then true anomaly ( \nu ):
[
\tan\frac{\nu}{2} = \sqrt{\frac{1+e}{1-e}} \tan\frac{E}{2}
]

Radius in orbital plane:
[
r = a(1 - e \cos E)
]

Position in orbital plane (perifocal coordinates):
[
\mathbf{r}_{PQW} = r \begin{bmatrix} \cos\nu \ \sin\nu \ 0 \end{bmatrix}
]

Transform to ECI/ecliptic coordinates with rotation matrix:
[
\mathbf{r}*{ECI} = R_z(-\Omega), R_x(-i), R_z(-\omega), \mathbf{r}*{PQW}
]
where (R_x, R_z) are rotation matrices.

Full derivations are in standard texts and e.g. the Wikipedia page on orbital mechanics.

### Converting orbital elements → position & velocity (summary)

1. Compute mean motion (n).
2. For a given time (t), compute (M(t) = M_0 + n (t - t_0)).
3. Solve Kepler's equation for eccentric anomaly (E).
4. Compute (r), (\nu), get (\mathbf{r}*{PQW}) and (\mathbf{v}*{PQW}).
5. Rotate to inertial frame using the 3-rotation matrix.

(Implementation snippets can be provided if you want a on-the-fly element-based propagator.)

---

## Why I resample to a unified time grid

Browsers can animate easily when the dataset is an array of discrete time steps (index-based). Your CSV files likely have the same cadence, but even if they differ, resampling/unifying avoids mismatched frame rates and simplifies syncing everything to a single slider.

If you prefer not to resample, an alternative viewer approach would load each object's CSV on demand and compute positions for any requested JD by interpolating on-the-fly. That increases browser work and network traffic but avoids precomputations.

---

## Improving diameters & sizes

I used a simple heuristic parser to extract diameters from `tno_centaur_diam_alb_dens.tab`. This works for many well-formatted lines (see sample), but it is heuristic and may miss entries or parse wrong tokens. If you have a clean CSV mapping `name -> diameter_km`, place it into `data/diameters/diameter_lookup.csv` and modify the build script to prefer that exact mapping.

If diameter is missing, the D3 viewer assigns a small default visual radius. You can also compute diameters from absolute magnitude H and albedo with
[
D = \frac{1329}{\sqrt{p}} \times 10^{-H/5}
]
where (D) is kilometers and (p) is geometric albedo.

---

## Next steps & enhancements

* Use a log radial scale or split panels to visualize inner vs outer solar system items so small semi-major axis differences don't get visually crushed.
* Implement on-the-fly Kepler propagation from orbital elements (if you can supply orbital elements).
* Add 3D projection (rotate by inclination and perspective).
* Add orbital trail traces (prior positions) and selectable filtering of classes (planets vs asteroids vs comets).
* Improve diameter parsing or provide a dedicated CSV `object_diameters.csv` with exact name matching.

---

## Troubleshooting

* If `index.html` reports an error about `scene.json`, ensure `d3/tools/build_scene_data.py` ran without errors and wrote `d3/data/scene.json`.
* The viewer expects to be served via HTTP — do not open it with `file://` protocol.

```

---

# Assumptions

- **Position units:** I assumed the CSV positions are in **kilometres**. If they are in AU,  multiply by 1.495978707e8 to convert AU->km (or modify the build script).
- **Time sampling:** the script unions all times and interpolates.to use only the intersection/time base of a single source, modify `unify_time_grid()` accordingly.
- **Diameters:** I used a heuristic to parse the `.tab` file; it is not bulletproof. a reliable `name -> diameter_km` CSV, the accuracy will improve.
