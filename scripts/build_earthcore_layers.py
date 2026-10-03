"""Build the static map layers used by the EARTH CORE tab.

Writes, under data/earthcore/:
  plates.json     - plate boundaries, Peter Bird PB2002 "steps" (per-segment boundary class)
  faults.json     - GEM Global Active Faults Database (harmonized)
  borders.json    - Natural Earth coastlines, country borders, state/province lines
  volcanoes.json  - Smithsonian Global Volcanism Program, Holocene volcanoes

Every coordinate comes from the source named in the file's "source" block;
nothing is typed in by hand. Geometry is only *reduced* for phone use
(coordinates rounded to 0.01 deg ~ 1 km, lines simplified with
Douglas-Peucker at the tolerance recorded in the file). No points are added.

If a source cannot be downloaded, its existing file is left untouched and the
failure is printed; if there is no existing file, none is written and the app
shows "DATA SOURCE NOT CONNECTED" for that layer.

Run by .github/workflows/earthcore-layers.yml (monthly and on demand).
For offline builds, set EC_LOCAL_DIR to a folder holding local copies named as
in LOCAL_NAMES below.
"""
import json
import os
import sys
import time
import urllib.request
from datetime import datetime, timezone

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "earthcore")
UA = "StormTrackerKC/1.0 (github.com/lezkt1811-maker/Storm-Tracker-KC)"
NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
LOCAL = os.environ.get("EC_LOCAL_DIR")

RAW = "https://raw.githubusercontent.com"
URLS = {
    "plates": f"{RAW}/fraxen/tectonicplates/master/GeoJSON/PB2002_steps.json",
    "faults": f"{RAW}/GEMScienceTools/gem-global-active-faults/master/geojson/gem_active_faults_harmonized.geojson",
    "coast": f"{RAW}/nvkelso/natural-earth-vector/master/geojson/ne_50m_coastline.geojson",
    "countries": f"{RAW}/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_0_boundary_lines_land.geojson",
    "states": f"{RAW}/nvkelso/natural-earth-vector/master/geojson/ne_50m_admin_1_states_provinces_lines.geojson",
    "volcanoes": ("https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows?service=WFS&version=2.0.0"
                  "&request=GetFeature&typeName=GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes"
                  "&outputFormat=application%2Fjson"),
}
LOCAL_NAMES = {
    "plates": "PB2002_steps.json",
    "faults": "gem_active_faults_harmonized.geojson",
    "coast": "ne_50m_coastline.geojson",
    "countries": "ne_50m_admin_0_boundary_lines_land.geojson",
    "states": "ne_50m_admin_1_states_provinces_lines.geojson",
    "volcanoes": "volcanoes.geojson",
}


def load(key, timeout=180):
    if LOCAL:
        path = os.path.join(LOCAL, LOCAL_NAMES[key])
        if os.path.exists(path):
            with open(path, "rb") as f:
                return json.load(f)
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(URLS[key], headers={"User-Agent": UA, "Accept": "application/json, */*"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read())
        except Exception as e:  # noqa: BLE001 - report and retry
            last = e
            time.sleep(4 * (attempt + 1))
    raise RuntimeError(f"{key}: {last}")


# ---------- geometry reduction ----------
def rdp(pts, tol):
    """Douglas-Peucker on [(lon,lat),...] in degrees. Keeps endpoints."""
    if len(pts) < 3 or tol <= 0:
        return pts
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = pts[a]
        bx, by = pts[b]
        dx, dy = bx - ax, by - ay
        L2 = dx * dx + dy * dy
        best, idx = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i]
            if L2 == 0:
                d = (px - ax) ** 2 + (py - ay) ** 2
            else:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L2))
                d = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2
            if d > best:
                best, idx = d, i
        if idx >= 0 and best > tol * tol:
            keep[idx] = True
            stack.append((a, idx))
            stack.append((idx, b))
    return [p for p, k in zip(pts, keep) if k]


def flat(pts, tol):
    """Simplify, round to 0.01 deg, drop repeated points, return flat [lon,lat,lon,lat...]."""
    out, prev = [], None
    for lon, lat in rdp([(float(p[0]), float(p[1])) for p in pts], tol):
        q = (round(lon, 2), round(lat, 2))
        if q != prev:
            out.extend(q)
            prev = q
    return out if len(out) >= 4 else None


def lines_of(geom):
    if not geom:
        return []
    if geom["type"] == "LineString":
        return [geom["coordinates"]]
    if geom["type"] == "MultiLineString":
        return geom["coordinates"]
    return []


def write(name, obj):
    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, name)
    with open(path, "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    print(f"wrote {name}: {os.path.getsize(path) / 1024:.0f} KB")


# ---------- plates ----------
PLATE_CLASSES = {
    "SUB": ["Subduction zone", "convergent"],
    "OCB": ["Oceanic convergent boundary", "convergent"],
    "CCB": ["Continental convergent boundary", "convergent"],
    "OSR": ["Oceanic spreading ridge", "divergent"],
    "CRB": ["Continental rift boundary", "divergent"],
    "OTF": ["Oceanic transform fault", "transform"],
    "CTF": ["Continental transform fault", "transform"],
}


def build_plates():
    src = load("plates")
    tol = 0.02
    runs = []  # merge consecutive steps of the same boundary + class into one polyline
    for f in sorted(src["features"], key=lambda f: f["properties"].get("SEQNUM", 0)):
        p = f["properties"]
        cls, bnd = p.get("STEPCLASS"), p.get("PLATEBOUND")
        coords = f["geometry"]["coordinates"]
        vel = p.get("VELOCITYLE")
        cur = runs[-1] if runs else None
        if (cur and cur["c"] == cls and cur["b"] == bnd
                and abs(cur["pts"][-1][0] - coords[0][0]) < 1e-3 and abs(cur["pts"][-1][1] - coords[0][1]) < 1e-3):
            cur["pts"].extend(coords[1:])
            if vel is not None:
                cur["v"].append(vel)
        else:
            runs.append({"c": cls, "b": bnd, "pts": list(coords), "v": [vel] if vel is not None else []})
    lines = []
    for r in runs:
        p = flat(r["pts"], tol)
        if p:
            v = round(sum(r["v"]) / len(r["v"]), 1) if r["v"] else None
            lines.append({"c": r["c"], "b": r["b"], "v": v, "p": p})
    write("plates.json", {
        "source": {
            "name": "PB2002 plate boundary model (Bird, 2003), via fraxen/tectonicplates",
            "url": "https://github.com/fraxen/tectonicplates",
            "citation": "Bird, P. (2003), An updated digital model of plate boundaries, G-cubed 4(3), 1027, doi:10.1029/2001GC000252",
            "license": "ODC Attribution License (ODC-By 1.0)",
            "retrieved_utc": NOW,
            "processing": f"Consecutive PB2002 steps with the same boundary and class merged; Douglas-Peucker {tol} deg; rounded to 0.01 deg. 'v' = mean relative plate velocity of the merged steps, mm/yr, from PB2002.",
        },
        "classes": PLATE_CLASSES,
        "count": len(lines),
        "lines": lines,
    })


# ---------- faults ----------
def first_num(s):
    """GEM stores values like '(1.55,0.8,2.22)' = (preferred,min,max)."""
    if s is None:
        return None
    try:
        v = str(s).strip("()").split(",")[0]
        return float(v) if v else None
    except ValueError:
        return None


def build_faults():
    src = load("faults")
    tol = 0.01
    out = []
    for f in src["features"]:
        p = f["properties"]
        for ln in lines_of(f.get("geometry")):
            pts = flat(ln, tol)
            if not pts:
                continue
            rec = {"p": pts}
            if p.get("name"):
                rec["n"] = p["name"]
            if p.get("slip_type"):
                rec["t"] = p["slip_type"]
            if p.get("catalog_name"):
                rec["k"] = p["catalog_name"]
            sr = first_num(p.get("net_slip_rate"))
            if sr is not None:
                rec["r"] = sr
            out.append(rec)
    write("faults.json", {
        "source": {
            "name": "GEM Global Active Faults Database (harmonized)",
            "url": "https://github.com/GEMScienceTools/gem-global-active-faults",
            "citation": "Styron, R. & Pagani, M. (2020), The GEM Global Active Faults Database, Earthquake Spectra 36(1_suppl), doi:10.1177/8755293020944182",
            "license": "CC BY-SA 4.0",
            "retrieved_utc": NOW,
            "processing": f"Douglas-Peucker {tol} deg; rounded to 0.01 deg. n=name, t=slip type, k=source catalog, r=preferred net slip rate (mm/yr) as given by GEM.",
        },
        "count": len(out),
        "faults": out,
    })


# ---------- borders ----------
def build_borders():
    parts = {}
    for key, tol in (("coast", 0.04), ("countries", 0.03), ("states", 0.03)):
        src = load(key)
        lines = []
        for f in src["features"]:
            for ln in lines_of(f.get("geometry")):
                p = flat(ln, tol)
                if p:
                    lines.append(p)
        parts[key] = lines
    write("borders.json", {
        "source": {
            "name": "Natural Earth 1:50m (coastline, admin-0 land boundaries, admin-1 lines)",
            "url": "https://www.naturalearthdata.com/ (via github.com/nvkelso/natural-earth-vector)",
            "license": "Public domain",
            "retrieved_utc": NOW,
            "processing": "Douglas-Peucker 0.03-0.04 deg; rounded to 0.01 deg. Borders are reference lines only.",
        },
        "coast": parts["coast"],
        "countries": parts["countries"],
        "states": parts["states"],
    })


# ---------- volcanoes ----------
def pick(props, *names):
    low = {k.lower(): v for k, v in props.items()}
    for n in names:
        v = low.get(n.lower())
        if v not in (None, ""):
            return v
    return None


def build_volcanoes():
    src = load("volcanoes")
    out = []
    for f in src.get("features", []):
        g = f.get("geometry") or {}
        if g.get("type") != "Point":
            continue
        lon, lat = g["coordinates"][:2]
        p = f.get("properties") or {}
        out.append({
            "lon": round(float(lon), 3), "lat": round(float(lat), 3),
            "id": pick(p, "Volcano_Number", "VolcanoNumber", "vnum"),
            "n": pick(p, "Volcano_Name", "VolcanoName", "name"),
            "c": pick(p, "Country", "country"),
            "t": pick(p, "Primary_Volcano_Type", "PrimaryVolcanoType", "volcano_type"),
            "e": pick(p, "Last_Eruption_Year", "LastEruptionYear", "last_eruption"),
            "z": pick(p, "Elevation", "elevation"),
            "s": pick(p, "Tectonic_Setting", "TectonicSetting"),
        })
    if len(out) < 100:
        raise RuntimeError(f"volcanoes: only {len(out)} point features parsed - refusing to write")
    write("volcanoes.json", {
        "source": {
            "name": "Smithsonian Institution Global Volcanism Program - Volcanoes of the World (Holocene)",
            "url": "https://volcano.si.edu/",
            "citation": "Global Volcanism Program, Volcanoes of the World (VOTW) database, Smithsonian Institution",
            "license": "Smithsonian GVP terms of use - cite the Global Volcanism Program",
            "retrieved_utc": NOW,
            "processing": "Point locations rounded to 0.001 deg. Fields as published: n=name, c=country, t=primary type, e=last known eruption, z=elevation (m), s=tectonic setting.",
        },
        "count": len(out),
        "volcanoes": out,
    })


if __name__ == "__main__":
    only = set(sys.argv[1:])
    failures = []
    for name, fn in (("plates", build_plates), ("faults", build_faults),
                     ("borders", build_borders), ("volcanoes", build_volcanoes)):
        if only and name not in only:
            continue
        try:
            fn()
        except Exception as e:  # noqa: BLE001 - keep other layers building
            failures.append(f"{name}: {e}")
            print(f"FAILED {name}: {e} (existing file left unchanged)")
    if failures and len(failures) == (len(only) or 4):
        sys.exit(1)
