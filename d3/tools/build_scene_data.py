#!/usr/bin/env python3
"""
build_scene_data.py

Scans orbital_trajectories/data/* for .csv position files, parses them,
attempts to extract diameters from the diameters/tno-centaur_diam-albedo-density
table, resamples/interpolates positions to a common time grid, and writes
a single JSON file to ../data/scene.json for the D3 viewer to consume.

Heuristics are used for robustness:
 - Each CSV is parsed by extracting the first floating number as JDTDB and
   the last three floating numbers on the line as X,Y,Z (works for typical
   JPL-like ascii tables).
 - The diameters table (tno_centaur_diam_alb_dens.tab) is parsed with a
   heuristic: find lines that start with an integer id, then the name (tokens
   up to the provisional designation token like '1977 UB'), then search for
   plausible diameter tokens in the remainder of the line (0.1 km - 50000 km).
 - If diameter is not found, we attempt to set a diameter using the
   (very approximate) formula from absolute magnitude H if available:
       D(km) = 1329 * 10^{-H/5} / sqrt(albedo)
   (we may not always have albedo; default albedo used).
 - All positions are assumed to be in kilometers. If your data are in AU or
   another unit, convert before running this script.

Output:
 - ../data/scene.json

Usage:
    cd orbital_trajectories/d3/tools
    python3 build_scene_data.py
"""

import os
import re
import json
from collections import defaultdict, OrderedDict
import math

# optional: uses numpy & pandas if available for faster interpolation; fallback to pure python
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

float_re = re.compile(r'[+-]?\d+\.\d+(?:[Ee][+-]?\d+)?|[+-]?\d+(?:[Ee][+-]?\d+)?')

def parse_position_csv(path):
    """
    Robust parser:
    - skip header lines that don't contain a floating JDTDB
    - for each data line, find all floats, take first float as JDTDB and last 3 floats as X,Y,Z
    """
    times = []
    xs = []
    ys = []
    zs = []
    with open(path, 'r', encoding='utf-8', errors='ignore') as fh:
        for ln in fh:
            ln = ln.strip()
            if not ln:
                continue
            floats = float_re.findall(ln)
            if len(floats) < 4:
                # probably header or unexpected format
                continue
            # first float -> time
            jdt = float(floats[0])
            # last three floats -> X Y Z
            x = float(floats[-3])
            y = float(floats[-2])
            z = float(floats[-1])
            times.append(jdt)
            xs.append(x)
            ys.append(y)
            zs.append(z)
    if not times:
        return None
    return {"times": times, "x": xs, "y": ys, "z": zs}

def discover_objects(data_dir):
    """
    Walk the data directory looking for subdirectories with .csv files.
    Return list of (class_name, file_path, object_id)
    """
    objects = []
    for sub in os.listdir(data_dir):
        subp = os.path.join(data_dir, sub)
        if not os.path.isdir(subp):
            continue
        # skip diameters and plotting_functions (they are not position sets)
        if sub.lower() in ("diameters", "plotting_functions", "d3"):
            continue
        # gather csv files
        for entry in sorted(os.listdir(subp)):
            if entry.lower().endswith(".csv"):
                path = os.path.join(subp, entry)
                # object id use filename w/o extension
                objid = os.path.splitext(entry)[0]
                objects.append({"class": sub, "path": path, "id": objid, "filename": entry})
    return objects

# def parse_diameters_tab(tab_path):
#     """
#     Heuristic parser for tno_centaur_diam_alb_dens.tab
#     Returns dict name_lower -> diameter_km (float) when successful.
#     """
#     diams = {}
#     if not os.path.exists(tab_path):
#         return diams
#     with open(tab_path, 'r', encoding='utf-8', errors='ignore') as fh:
#         for ln in fh:
#             ln = ln.strip()
#             if not ln:
#                 continue
#             # Some lines are comments; skip if starts with non-digit id
#             if not re.match(r'^\d+', ln):
#                 continue
#             toks = ln.split()
#             # first token numeric id; find a token that looks like a provisional designation like '1977'
#             prov_idx = None
#             for i, t in enumerate(toks):
#                 if re.match(r'^\d{4}$', t):
#                     prov_idx = i
#                     break
#             if prov_idx is None or prov_idx < 2:
#                 # fallback: second token as name
#                 name_tokens = [toks[1]]
#             else:
#                 name_tokens = toks[1:prov_idx]
#             name = " ".join(name_tokens).strip()
#             # After provisional and a handful of columns, search for a token that looks like diameter
#             # heuristic: find numeric tokens between 0.1 and 50000 with a decimal point
#             candidate = None
#             for t in toks[prov_idx+1:]:
#                 if re.match(r'^[+-]?\d+\.\d+(?:[Ee][+-]?\d+)?$', t):
#                     try:
#                         v = float(t)
#                     except:
#                         continue
#                     if 0.05 <= v <= 50000:
#                         candidate = v
#                         break
#             if candidate is not None:
#                 diams[name.lower()] = candidate
#     return diams


def parse_diameters_tab(tab_path):
    """
    Heuristic parser for tno_centaur_diam_alb_dens.tab
    Returns dict name_lower -> diameter_km (float) when successful.

    Robustness improvements:
     - Handles cases where the provisional-designation (4-digit) token is missing.
     - Uses a safe search_start index and guards against short token lists.
     - Skips malformed lines without throwing.
    """
    diams = {}
    if not os.path.exists(tab_path):
        return diams
    with open(tab_path, 'r', encoding='utf-8', errors='ignore') as fh:
        for ln in fh:
            ln = ln.strip()
            if not ln:
                continue
            # Some lines are comments; skip if starts with non-digit id
            if not re.match(r'^\d+', ln):
                continue
            toks = ln.split()
            if len(toks) < 2:
                continue
            # first token numeric id; find a token that looks like a provisional designation like '1977'
            prov_idx = None
            for i, t in enumerate(toks):
                if re.match(r'^\d{4}$', t):
                    prov_idx = i
                    break
            # name tokens: prefer tokens between id (toks[0]) and prov_idx, else fallback to toks[1]
            if prov_idx is None or prov_idx < 2:
                name_tokens = [toks[1]] if len(toks) > 1 else []
                # choose a safe search start after the name and provisional guess
                search_start = 2
            else:
                name_tokens = toks[1:prov_idx]
                search_start = prov_idx + 1

            name = " ".join(name_tokens).strip()
            if not name:
                # if we failed to extract a name, skip
                continue

            # After provisional (or fallback), search for a token that looks like diameter
            candidate = None
            # Guard: ensure search_start is within bounds
            if search_start >= len(toks):
                # nothing else on line
                continue

            for t in toks[search_start:]:
                # look for explicit floats (with decimal or exponent)
                if re.match(r'^[+-]?\d+\.\d+(?:[Ee][+-]?\d+)?$', t):
                    try:
                        v = float(t)
                    except:
                        continue
                    # keep plausible diameter range in km
                    if 0.05 <= v <= 50000:
                        candidate = v
                        break
                else:
                    # sometimes integers exist for diameters (rare). try integer-like token
                    if re.match(r'^[+-]?\d+$', t):
                        try:
                            v = float(t)
                        except:
                            continue
                        if 0.05 <= v <= 50000:
                            candidate = v
                            break
            if candidate is not None:
                diams[name.lower()] = candidate
    return diams



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
    """
    Build a sorted unique time grid consisting of union of all times (may be large).
    If numpy is available we use numpy.unique, else use a Python set.
    """
    all_times = []
    for obj in objects_data:
        all_times.extend(obj["times"])
    if np is not None:
        times = np.unique(np.array(all_times, dtype=float))
        return times.tolist()
    else:
        times = sorted(set(all_times))
        return times

def interp_to_grid(times_grid, obj):
    """
    Given times_grid (sorted list) and obj with keys times,x,y,z arrays,
    return interpolated arrays xs,ys,zs aligned to times_grid.
    For times outside the obj's times we set None (or NaN).
    """
    t_obj = obj["times"]
    x_obj = obj["x"]
    y_obj = obj["y"]
    z_obj = obj["z"]
    if np is not None:
        t_obj = np.array(t_obj, dtype=float)
        x_obj = np.array(x_obj, dtype=float)
        y_obj = np.array(y_obj, dtype=float)
        z_obj = np.array(z_obj, dtype=float)
        tg = np.array(times_grid, dtype=float)
        # for interpolation we will place NaN where tg < min or tg > max
        x_interp = np.interp(tg, t_obj, x_obj, left=np.nan, right=np.nan)
        y_interp = np.interp(tg, t_obj, y_obj, left=np.nan, right=np.nan)
        z_interp = np.interp(tg, t_obj, z_obj, left=np.nan, right=np.nan)
        # convert to native python lists replacing np.nan with None
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
        # Pure-python linear interpolation (slow) with bisect
        import bisect
        def interp_list(tg, t_obj, val_obj):
            out = []
            for tt in tg:
                if tt < t_obj[0] or tt > t_obj[-1]:
                    out.append(None)
                    continue
                # find right place
                i = bisect.bisect_left(t_obj, tt)
                if i < len(t_obj) and abs(t_obj[i] - tt) < 1e-9:
                    out.append(val_obj[i])
                else:
                    # interpolate between i-1 and i
                    if i == 0:
                        out.append(None)
                    else:
                        t0, t1 = t_obj[i-1], t_obj[i]
                        v0, v1 = val_obj[i-1], val_obj[i]
                        frac = (tt - t0) / (t1 - t0)
                        out.append(v0 + frac * (v1 - v0))
            return out
        return interp_list(times_grid, t_obj, x_obj), interp_list(times_grid, t_obj, y_obj), interp_list(times_grid, t_obj, z_obj)

def main():
    print("Discovering objects in:", DATA_DIR)
    objs = discover_objects(DATA_DIR)
    print("Found {} object files.".format(len(objs)))
    objects_data = []
    for o in objs:
        parsed = parse_position_csv(o["path"])
        if parsed is None:
            print("Warning: no data parsed for", o["path"])
            continue
        entry = {
            "id": o["id"],
            "filename": o["filename"],
            "class": o["class"],
            "path": os.path.relpath(o["path"], os.path.join(os.path.dirname(__file__), "..")),  # relative for reference
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
    diams = parse_diameters_tab(DIAM_TAB)
    print("Found {} diameter entries via heuristics.".format(len(diams)))

    colors = parse_cat_colors(PLOT_COLORS)
    print("Parsed {} colors.".format(len(colors)))

    # Build unioned grid of times
    print("Building unified time grid ...")
    times_grid = unify_time_grid(objects_data)
    print("Unified grid length:", len(times_grid))

    # build scene objects with interpolated positions
    scene_objects = []
    for o in objects_data:
        xs, ys, zs = interp_to_grid(times_grid, o)
        # attempt to resolve diameter: check diams dictionary by matching ID or name
        diameter = None
        name_low = o["id"].lower()
        if name_low in diams:
            diameter = diams[name_low]
        else:
            # try matching only beginning, or replace underscores, dashes
            simple = name_low.replace("_", " ").replace("-", " ").split()[0]
            if simple in diams:
                diameter = diams[simple]
        # assign color from class if available
        color = colors.get(o["class"], "#CCCCCC")
        scene_objects.append({
            "id": o["id"],
            "class": o["class"],
            "filename": o["filename"],
            "diameter_km": diameter,
            "color": color,
            "x": xs,
            "y": ys,
            "z": zs
        })

    # Basic metadata and assumptions
    # assume positions are in kilometers. If not, the user should rescale externally.
    metadata = {
        "units": "km (assumed)",
        "notes": "Positions parsed from CSV files. Times are JDTDB (Julian Date, Barycentric Dynamical Time). " +
                 "Diameters were parsed heuristically from the diameters table; many bodies may lack diameter entries.",
        "time_count": len(times_grid)
    }

    # Write scene.json
    scene = {
        "metadata": metadata,
        "times_jd": times_grid,
        "objects": scene_objects
    }
    print("Writing scene to", OUT_FILE)
    with open(OUT_FILE, 'w', encoding='utf-8') as fh:
        json.dump(scene, fh, indent=2)
    print("Done. Output file:", OUT_FILE)
    print("Next: run a local HTTP server in orbital_trajectories/d3/ and open index.html in a browser.")
    print("Example:")
    print("  cd orbital_trajectories/d3")
    print("  python3 -m http.server 8000")
    print("  open http://localhost:8000 (or navigate to that URL)")
if __name__ == "__main__":
    main()

