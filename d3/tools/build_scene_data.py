#!/usr/bin/env python3
"""
build_scene_data.py (updated)

- Robust parsing of object CSV positions
- Heuristic parsing of diameters table and extraction of orbital elements (a,e,i when present)
- Optional per-class subsampling (SUBSAMPLE_CATEGORIES / SUBSAMPLE_AMOUNTS)
- Pruning of objects with very few samples
- Writes d3/data/scene.json with:
    { metadata, times_jd, objects: [ {id, class, diameter_km, color, x[], y[], z[], elements? }, ... ] }

Usage:
    cd orbital_trajectories/d3/tools
    python3 build_scene_data.py
"""

import os, re, json, math, random
from collections import defaultdict
try:
    import numpy as np
except Exception:
    np = None

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA_DIR = os.path.join(ROOT, "data")
OUT_DIR = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(OUT_DIR, exist_ok=True)
OUT_FILE = os.path.join(OUT_DIR, "scene.json")

DIAM_TAB = os.path.join(DATA_DIR, "diameters", "tno-centaur_diam-albedo-density", "data", "tno_centaur_diam_alb_dens.tab")
PLOT_COLORS = os.path.join(DATA_DIR, "plotting_functions", "cat colors.csv")

# ---------------------------
# USER-CONFIGURABLE PARAMETERS
# ---------------------------

# Subsampling at build time:
# specify classes (folder names inside data/) that should be subsampled,
# and the associated fraction(s) to keep (0..<1]).
# Example: SUBSAMPLE_CATEGORIES = ("moons","small_asteroids")
#          SUBSAMPLE_AMOUNTS = (0.1, 0.05)
SUBSAMPLE_CATEGORIES = ("any_inner_asteroids","any_outer_asteroids","large_asteroids","small_asteroids.csv",)   # example: subsample moons
SUBSAMPLE_AMOUNTS = (0.01,0.01,0.01,0.01)          # keep 1% 

# If SUBSAMPLE_CATEGORIES includes a class, a fraction from SUBSAMPLE_AMOUNTS is applied.
# If lengths mismatch, the last amount is reused.
RANDOM_SEED = 42

# limit on unioned times (to avoid huge JSON)
MAX_TIME_POINTS = 1000

# prune objects with fewer valid samples than this
MIN_SAMPLES = 4

# ---------------------------
# internal
# ---------------------------

float_re = re.compile(r'[+-]?\d+\.\d+(?:[Ee][+-]?\d+)?|[+-]?\d+(?:[Ee][+-]?\d+)?')

def parse_position_csv(path):
    times, xs, ys, zs = [], [], [], []
    with open(path, 'r', encoding='utf-8', errors='ignore') as fh:
        for ln in fh:
            ln = ln.strip()
            if not ln:
                continue
            floats = float_re.findall(ln)
            if len(floats) < 4:
                continue
            try:
                jdt = float(floats[0])
                x = float(floats[-3])
                y = float(floats[-2])
                z = float(floats[-1])
            except Exception:
                continue
            times.append(jdt)
            xs.append(x)
            ys.append(y)
            zs.append(z)
    if not times:
        return None
    return {"times": times, "x": xs, "y": ys, "z": zs}

def discover_objects(data_dir):
    objects = []
    for sub in sorted(os.listdir(data_dir)):
        subp = os.path.join(data_dir, sub)
        if not os.path.isdir(subp):
            continue
        if sub.lower() in ("diameters", "plotting_functions", "d3"):
            continue
        for entry in sorted(os.listdir(subp)):
            if entry.lower().endswith(".csv"):
                path = os.path.join(subp, entry)
                objid = os.path.splitext(entry)[0]
                objects.append({"class": sub, "path": path, "id": objid, "filename": entry})
    return objects

def parse_diameters_tab(tab_path):
    """
    Parse diameters table and attempt to extract:
      - diameter_km
      - semimajor axis 'a' (AU)
      - eccentricity 'e'
      - inclination 'i' (deg)
    Returns dict name_lower -> dict(e.g. {"diameter_km":..., "a":..., "e":..., "i":...})
    """
    info = {}
    if not os.path.exists(tab_path):
        return info
    with open(tab_path, 'r', encoding='utf-8', errors='ignore') as fh:
        for ln in fh:
            ln = ln.strip()
            if not ln:
                continue
            if not re.match(r'^\d+', ln):
                continue
            toks = ln.split()
            if len(toks) < 2:
                continue
            # find provisional year token (4-digit) if present
            prov_idx = None
            for i, t in enumerate(toks):
                if re.match(r'^\d{4}$', t):
                    prov_idx = i
                    break
            if prov_idx is None or prov_idx < 2:
                name_tokens = [toks[1]] if len(toks) > 1 else []
                search_start = 2
            else:
                name_tokens = toks[1:prov_idx]
                search_start = prov_idx + 1
            name = " ".join(name_tokens).strip()
            if not name:
                continue

            # attempt to extract a,e,i from first three numeric tokens after search_start
            a = e = inc = None
            numeric_after = []
            for t in toks[search_start:search_start+10]:
                if re.match(r'^[+-]?\d+(\.\d+)?([Ee][+-]?\d+)?$', t):
                    try:
                        numeric_after.append(float(t))
                    except:
                        pass
            if len(numeric_after) >= 3:
                a, e, inc = numeric_after[0], numeric_after[1], numeric_after[2]
            # attempt to find diameter (float) anywhere after search_start
            diam = None
            for t in toks[search_start:]:
                if re.match(r'^[+-]?\d+\.\d+(?:[Ee][+-]?\d+)?$', t):
                    try:
                        v = float(t)
                    except:
                        continue
                    if 0.05 <= v <= 50000:
                        diam = v
                        break
                elif re.match(r'^[+-]?\d+$', t):
                    try:
                        v = float(t)
                    except:
                        continue
                    if 0.05 <= v <= 50000:
                        diam = v
                        break
            entry = {}
            if diam is not None:
                entry['diameter_km'] = diam
            if a is not None:
                entry['a_AU'] = a
            if e is not None:
                entry['e'] = e
            if inc is not None:
                entry['i_deg'] = inc
            if entry:
                info[name.lower()] = entry
    return info

def parse_cat_colors(csv_path):
    cmap = {}
    if not os.path.exists(csv_path):
        return cmap
    with open(csv_path, 'r', encoding='utf-8', errors='ignore') as fh:
        hdr = fh.readline()
        for ln in fh:
            ln = ln.strip()
            if not ln:
                continue
            parts = [p.strip() for p in ln.split(",")]
            if len(parts) < 2:
                continue
            cls = parts[0]
            color = parts[1]
            cmap[cls] = color
    return cmap

def unify_time_grid(objects_data):
    all_times = []
    for obj in objects_data:
        all_times.extend(obj["times"])
    if np is not None:
        times = np.unique(np.array(all_times, dtype=float))
        return times.tolist()
    else:
        return sorted(set(all_times))

def interp_to_grid(times_grid, obj):
    if np is not None:
        t_obj = np.array(obj["times"], dtype=float)
        x_obj = np.array(obj["x"], dtype=float)
        y_obj = np.array(obj["y"], dtype=float)
        z_obj = np.array(obj["z"], dtype=float)
        tg = np.array(times_grid, dtype=float)
        x_interp = np.interp(tg, t_obj, x_obj, left=np.nan, right=np.nan)
        y_interp = np.interp(tg, t_obj, y_obj, left=np.nan, right=np.nan)
        z_interp = np.interp(tg, t_obj, z_obj, left=np.nan, right=np.nan)
        def clean(a):
            out = []
            for v in a:
                if np.isnan(v):
                    out.append(None)
                else:
                    out.append(float(v))
            return out
        return clean(x_interp), clean(y_interp), clean(z_interp)
    else:
        import bisect
        def interp_list(tg, t_obj, val_obj):
            out = []
            for tt in tg:
                if tt < t_obj[0] or tt > t_obj[-1]:
                    out.append(None)
                    continue
                i = bisect.bisect_left(t_obj, tt)
                if i < len(t_obj) and abs(t_obj[i] - tt) < 1e-9:
                    out.append(val_obj[i])
                else:
                    if i == 0:
                        out.append(None)
                    else:
                        t0, t1 = t_obj[i-1], t_obj[i]
                        v0, v1 = val_obj[i-1], val_obj[i]
                        frac = (tt - t0) / (t1 - t0)
                        out.append(v0 + frac * (v1 - v0))
            return out
        return interp_list(times_grid, obj["times"], obj["x"]), interp_list(times_grid, obj["times"], obj["y"]), interp_list(times_grid, obj["times"], obj["z"])

def main():
    random.seed(RANDOM_SEED)
    print("Discovering objects in:", DATA_DIR)
    objs = discover_objects(DATA_DIR)
    print("Found {} object files.".format(len(objs)))
    objects_data = []
    for o in objs:
        parsed = parse_position_csv(o["path"])
        if parsed is None:
            continue
        entry = {
            "id": o["id"],
            "filename": o["filename"],
            "class": o["class"],
            "path": os.path.relpath(o["path"], os.path.join(os.path.dirname(__file__), "..")),
            "times": parsed["times"],
            "x": parsed["x"],
            "y": parsed["y"],
            "z": parsed["z"],
        }
        objects_data.append(entry)
    if not objects_data:
        print("No objects parsed. Exiting.")
        return

    print("Parsing diameters table (heuristic) ...")
    try:
        diaminfos = parse_diameters_tab(DIAM_TAB)
        print("Found {} diameter/element entries via heuristics.".format(len(diaminfos)))
    except Exception as e:
        print("Warning: diameter parsing failed:", e)
        diaminfos = {}

    colors = parse_cat_colors(PLOT_COLORS)
    print("Parsed {} colors.".format(len(colors)))

    print("Building unified time grid ...")
    times_grid = unify_time_grid(objects_data)
    print("Unified grid length:", len(times_grid))

    if len(times_grid) > MAX_TIME_POINTS:
        print(f"Unified time grid ({len(times_grid)}) exceeds {MAX_TIME_POINTS}. Downsampling uniformly.")
        if np is not None:
            idx = np.linspace(0, len(times_grid) - 1, MAX_TIME_POINTS).astype(int)
            times_grid = [times_grid[i] for i in idx]
        else:
            step = (len(times_grid) - 1) / float(MAX_TIME_POINTS - 1)
            new_times = []
            for k in range(MAX_TIME_POINTS):
                i = int(round(k * step))
                new_times.append(times_grid[max(0, min(i, len(times_grid)-1))])
            times_grid = sorted(set(new_times), key=new_times.index)
        print("Downsampled time grid length:", len(times_grid))

    scene_objects = []
    # assemble objects with interpolation
    for o in objects_data:
        xs, ys, zs = interp_to_grid(times_grid, o)
        diameter = None
        elems = None
        name_low = o["id"].lower()
        if name_low in diaminfos:
            info = diaminfos[name_low]
            diameter = info.get("diameter_km")
            # collect elements if available
            if "a_AU" in info or "e" in info or "i_deg" in info:
                elems = {}
                if "a_AU" in info:
                    elems["a_AU"] = info["a_AU"]
                if "e" in info:
                    elems["e"] = info["e"]
                if "i_deg" in info:
                    elems["i_deg"] = info["i_deg"]
        color = colors.get(o["class"], "#cccccc")
        scene_objects.append({
            "id": o["id"],
            "class": o["class"],
            "filename": o["filename"],
            "diameter_km": diameter,
            "color": color,
            "x": xs,
            "y": ys,
            "z": zs,
            "elements": elems
        })

    # prune objects with too few samples
    kept = []
    for obj in scene_objects:
        valid = sum(1 for v in obj["x"] if v is not None)
        if valid >= MIN_SAMPLES:
            kept.append(obj)
    print(f"Pruned objects with <{MIN_SAMPLES} valid samples. Kept {len(kept)}/{len(scene_objects)} objects.")
    scene_objects = kept

    # apply per-class subsampling (random)
    if SUBSAMPLE_CATEGORIES:
        subs = list(SUBSAMPLE_CATEGORIES)
        amounts = list(SUBSAMPLE_AMOUNTS)
        # pad amounts if needed
        if len(amounts) < len(subs):
            amounts = amounts + [amounts[-1]] * (len(subs) - len(amounts))
        byclass = defaultdict(list)
        for obj in scene_objects:
            byclass[obj["class"]].append(obj)
        new_scene_objects = []
        for cls, arr in byclass.items():
            if cls in subs:
                frac = amounts[subs.index(cls)]
                n_keep = max(1, int(math.floor(len(arr) * float(frac))))
                print(f"Subsampling class '{cls}': keeping {n_keep}/{len(arr)} ({frac:.3f})")
                shuffled = arr[:]
                random.shuffle(shuffled)
                new_scene_objects.extend(shuffled[:n_keep])
            else:
                new_scene_objects.extend(arr)
        scene_objects = new_scene_objects

    metadata = {
        "units": "km (assumed)",
        "notes": "Positions parsed from CSV files. Times are JDTDB (Julian Date, TDB). Elements extracted heuristically when available.",
        "time_count": len(times_grid)
    }

    scene = {
        "metadata": metadata,
        "times_jd": times_grid,
        "objects": scene_objects
    }

    print("Writing scene to", OUT_FILE)
    with open(OUT_FILE, 'w', encoding='utf-8') as fh:
        json.dump(scene, fh, indent=2)
    print("Done. Wrote", OUT_FILE)
    print("Serve d3/ directory via a static server and open index.html.")

if __name__ == "__main__":
    main()
