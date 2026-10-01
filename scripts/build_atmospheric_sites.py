"""Build data/atmospheric-sites.json from official/public site-metadata feeds.

Every site's coordinates come from the feed named in its `source`; nothing is
typed in by hand. Run by .github/workflows/atmospheric-sites.yml (monthly and
on demand). Sites within RADIUS_MI of Kansas City are kept.

Categories describe what a facility IS, not any involvement in weather
modification. Weather-modification records live separately in
data/weather-modification.json.
"""
import csv
import io
import json
import math
import time
import urllib.request
from datetime import datetime, timezone

KC = (39.0997, -94.5786)
RADIUS_MI = 200
UA = "StormTrackerKC/1.0 (github.com/lezkt1811-maker/Storm-Tracker-KC)"
NOW = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
STATES = ["KS", "MO", "NE", "IA", "OK", "AR"]


def get(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/geo+json, application/json, */*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def miles(lat, lon):
    r = 3958.8
    p1, p2 = math.radians(KC[0]), math.radians(lat)
    dp, dl = p2 - p1, math.radians(lon - KC[1])
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


sites, sources, errors = [], [], []


def add(**kw):
    kw["distanceMi"] = round(miles(kw["lat"], kw["lon"]), 1)
    if kw["distanceMi"] <= RADIUS_MI:
        kw.setdefault("documentation", "OFFICIAL METADATA")
        kw["retrievedAt"] = NOW
        sites.append(kw)


def source(name, url, note=""):
    sources.append({"name": name, "url": url, "retrievedAt": NOW, "note": note})


# --- Radar: NWS API radar stations (WSR-88D and TDWR) -------------------------
try:
    url = "https://api.weather.gov/radar/stations"
    d = json.loads(get(url))
    for f in d["features"]:
        p, (lon, lat) = f["properties"], f["geometry"]["coordinates"][:2]
        kind = p.get("stationType") or ""
        what = ("NEXRAD WSR-88D Doppler weather radar: measures precipitation, wind motion and, with dual polarization, "
                "target shape/size. Transmits and listens; it does not emit anything into the air besides radio energy.") \
            if kind == "WSR-88D" else \
            ("Terminal Doppler Weather Radar (FAA): detects wind shear and microbursts near a major airport."
             if kind == "TDWR" else f"Weather radar ({kind}).")
        add(id=p["id"], category="RADAR", name=f'{p["id"]} — {p.get("name", "")}', lat=lat, lon=lon,
            what=what, source="National Weather Service API (radar stations)", sourceUrl=f"https://api.weather.gov/radar/stations/{p['id']}")
    source("National Weather Service API — radar stations", url)
except Exception as e:
    errors.append(f"radar: {e}")

# --- Upper air: IEM RAOB network (NWS radiosonde launch sites) ---------------
try:
    url = "https://mesonet.agron.iastate.edu/geojson/network/RAOB.geojson"
    d = json.loads(get(url))
    for f in d["features"]:
        p = f["properties"]
        if not p.get("online") or p.get("archive_end"):
            continue
        lon, lat = f["geometry"]["coordinates"][:2]
        add(id="RAOB" + p["sid"], category="UPPER_AIR", name=p.get("sname", p["sid"]), lat=lat, lon=lon,
            what="Upper-air sounding site: launches weather balloons (radiosondes) twice daily to measure temperature, "
                 "humidity and wind up through the atmosphere.",
            source="Iowa Environmental Mesonet station metadata (RAOB network)",
            sourceUrl=f"https://mesonet.agron.iastate.edu/sites/site.php?station={p['sid']}&network=RAOB")
    source("Iowa Environmental Mesonet — RAOB (upper-air) network", url)
except Exception as e:
    errors.append(f"raob: {e}")

# --- Surface weather stations: IEM ASOS/AWOS networks -------------------------
seen_asos = set()
for st in STATES:
    try:
        url = f"https://mesonet.agron.iastate.edu/geojson/network/{st}_ASOS.geojson"
        d = json.loads(get(url))
        for f in d["features"]:
            p = f["properties"]
            if not p.get("online") or p.get("archive_end") or p["sid"] in seen_asos:
                continue
            seen_asos.add(p["sid"])
            lon, lat = f["geometry"]["coordinates"][:2]
            add(id=f"{st}_ASOS_{p['sid']}", category="WEATHER_MONITORING", name=f'{p["sid"]} — {p.get("sname", "")}',
                lat=lat, lon=lon,
                what="Automated surface weather station (ASOS/AWOS), usually at an airport: temperature, dew point, "
                     "wind, pressure, visibility, sky condition and precipitation.",
                source=f"Iowa Environmental Mesonet station metadata ({st}_ASOS network)",
                sourceUrl=f"https://mesonet.agron.iastate.edu/sites/site.php?station={p['sid']}&network={st}_ASOS")
        source(f"Iowa Environmental Mesonet — {st}_ASOS network", url)
        time.sleep(1)
    except Exception as e:
        errors.append(f"asos {st}: {e}")

# --- Air quality: AirNow monitoring site list ---------------------------------
try:
    url = "https://files.airnowtech.org/airnow/today/Monitoring_Site_Locations_V2.dat"
    raw = get(url, timeout=120).decode("utf-8", errors="ignore")
    rows = csv.DictReader(io.StringIO(raw), delimiter="|")
    merged = {}
    for r in rows:
        if r.get("Status") != "Active" or r.get("CountryFIPS") != "US":
            continue
        try:
            lat, lon = float(r["Latitude"]), float(r["Longitude"])
        except (TypeError, ValueError):
            continue
        if miles(lat, lon) > RADIUS_MI:
            continue
        key = r["AQSID"]
        m = merged.setdefault(key, {"lat": lat, "lon": lon, "name": r["SiteName"], "agency": r["AgencyName"], "params": set()})
        m["params"].add(r["Parameter"])
    for key, m in merged.items():
        add(id="AQ" + key, category="AIR_QUALITY", name=m["name"], lat=m["lat"], lon=m["lon"],
            what=f"Air-quality monitor operated by {m['agency']}. Measures: {', '.join(sorted(m['params']))}.",
            source="EPA AirNow monitoring site list", sourceUrl=url)
    source("EPA AirNow — monitoring site locations", url)
except Exception as e:
    errors.append(f"airnow: {e}")

# --- Aviation: public-use airports (OurAirports public-domain dataset) --------
try:
    url = "https://davidmegginson.github.io/ourairports-data/airports.csv"
    raw = get(url, timeout=120).decode("utf-8", errors="ignore")
    for r in csv.DictReader(io.StringIO(raw)):
        if r["iso_country"] != "US" or r["type"] not in ("large_airport", "medium_airport"):
            continue
        lat, lon = float(r["latitude_deg"]), float(r["longitude_deg"])
        add(id="APT" + r["ident"], category="AVIATION", name=f'{r["ident"]} — {r["name"]}', lat=lat, lon=lon,
            what="Airport. Aircraft seen nearby are mostly arriving/departing traffic and its approach/departure corridors.",
            source="OurAirports (public-domain community dataset)", sourceUrl=f"https://ourairports.com/airports/{r['ident']}/",
            documentation="PUBLIC DATASET")
    source("OurAirports — airports.csv (public domain)", url, "Community-maintained; FAA is the authoritative source.")
except Exception as e:
    errors.append(f"airports: {e}")

# --- NOAA / NWS offices: NWS API (addresses; no coordinates published) --------
offices = []
for oid in ["EAX", "TOP", "SGF", "OAX", "DMX", "LSX", "ICT", "CRH"]:
    try:
        url = f"https://api.weather.gov/offices/{oid}"
        d = json.loads(get(url))
        a = d.get("address", {})
        offices.append({"id": oid, "category": "SATELLITE_NOAA", "name": f"NWS {d.get('name', oid)}",
                        "address": ", ".join(x for x in [a.get("streetAddress"), a.get("addressLocality"), a.get("addressRegion")] if x),
                        "what": "National Weather Service office: issues forecasts and warnings, operates nearby radar and "
                                "observing equipment. Not a weather-modification facility.",
                        "source": "National Weather Service API (offices)", "sourceUrl": d.get("sameAs") or url,
                        "documentation": "OFFICIAL METADATA", "retrievedAt": NOW})
        time.sleep(1)
    except Exception as e:
        errors.append(f"office {oid}: {e}")
source("National Weather Service API — offices", "https://api.weather.gov/offices/{id}",
       "Offices are listed by address only; the API publishes no coordinates, so they are not placed on the map.")

# --- Place lookups for documented weather-modification records ----------------
places = {}
try:
    raw = get("https://davidmegginson.github.io/ourairports-data/airports.csv", timeout=120).decode("utf-8", errors="ignore")
    for r in csv.DictReader(io.StringIO(raw)):
        if r["iso_country"] == "US" and r["iso_region"] == "US-KS" and "Kearny County" in r["name"]:
            places["Kearny County Airport, Lakin, KS"] = {
                "lat": float(r["latitude_deg"]), "lon": float(r["longitude_deg"]), "ident": r["ident"],
                "distanceMi": round(miles(float(r["latitude_deg"]), float(r["longitude_deg"])), 1),
                "source": "OurAirports (public-domain community dataset)", "sourceUrl": f"https://ourairports.com/airports/{r['ident']}/"}
except Exception as e:
    errors.append(f"places: {e}")

sites.sort(key=lambda s: (s["category"], s["distanceMi"]))
counts = {}
for s in sites:
    counts[s["category"]] = counts.get(s["category"], 0) + 1
out = {
    "generatedAt": NOW, "center": {"lat": KC[0], "lon": KC[1], "label": "Kansas City, MO"}, "radiusMi": RADIUS_MI,
    "note": "Category indicates the type of facility or record, not involvement in weather modification.",
    "counts": counts, "sources": sources, "errors": errors, "sites": sites, "listOnly": offices, "places": places,
    "notConnected": [
        {"category": "ENV_PERMIT", "reason": "No free, machine-readable feed of Missouri DNR or Kansas KDHE air-permit "
                                             "locations was found. Search them directly: Missouri DNR permits and KDHE air permits."},
    ],
}
json.dump(out, open("data/atmospheric-sites.json", "w"), indent=1)
print("sites:", len(sites), counts, "offices:", len(offices), "places:", list(places), "errors:", errors)
