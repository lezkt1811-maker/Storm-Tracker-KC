# Storm Tracker KC

An evidence-based weather + aircraft + sky-observation investigation platform for the
Kansas City metro area. It is not a weather app — it is a tool for asking *"is this
actually unusual?"* and separating **observation → correlation → hypothesis → evidence
→ conclusion**, without ever converting correlation into a claim of causation.

Runs entirely as a single static `index.html` file. No build step, no server, no
account, no billing information, ever.

## What Storm Tracker KC does

- Shows live NWS forecasts, active alerts, and animated precipitation radar over a
  dark, mobile-first "storm command center" map.
- Shows an **Extended Forecast Timeline** (Now/6h/12h/24h/48h/72h/5-day/7-day) built
  from the real NWS forecast grid, with a cumulative rainfall chart and a first look
  at conditions in nearby cities — always labeled as forecast/model guidance, never
  as a guaranteed prediction, and honest when the grid doesn't yet cover a horizon.
- Tracks nearby aircraft (when reachable) via the free OpenSky Network API and shows
  honestly when that data source isn't available — it never invents aircraft.
- Lets you log sky/aircraft/weather observations from your phone (with optional GPS),
  tagged as **USER OBSERVATION** so they're never confused with measured data.
- Merges alerts, observations, and detected anomalies into one filterable **Master
  Timeline**.
- Runs a local **Baseline & Anomaly Engine**: it only calls something "unusual" after
  comparing it against a statistical baseline built from your own accumulated data —
  never against a guess.
- Runs a local **Correlation Engine** that flags events from independent categories
  occurring close together in time, explicitly labeled "temporal correlation" — never
  "causation."
- Provides a **Hypothesis Lab** for structured hypothesis and controversial-claim
  testing: claim → predictions → required data → supporting/contradicting evidence →
  status. It never auto-resolves a hypothesis to "proven."
- Stores everything in an **Evidence Vault** (browser-local IndexedDB) with JSON and
  human-readable HTML export/import.
- Shows a **System Status** panel so you can tell, from your phone, exactly what is
  and isn't currently connected.

## How to run it

Open `index.html` in any modern mobile or desktop browser, or serve the repo with
GitHub Pages (Settings → Pages → deploy from the default branch). There is nothing to
build or install.

## Data sources (all free, all public, no accounts)

| Layer | Source | Notes |
|---|---|---|
| Forecast & current conditions | [api.weather.gov](https://api.weather.gov) (NWS) | Free, keyless, official |
| Active alerts/warnings | api.weather.gov `/alerts/active` | Rendered as map polygons + timeline events |
| GOES-East satellite: infrared, water vapor | [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu) tile cache | Free, keyless, CORS-enabled; updates ~5 min |
| GOES-East satellite: GeoColor (true color) | [NASA GIBS](https://earthdata.nasa.gov/gibs) WMTS | Free, keyless, CORS-enabled |
| Radar image saved in Event Packets | Iowa Environmental Mesonet NEXRAD composite | Free, keyless |
| Upper-air wind (Atmosphere Above KC) | Open-Meteo pressure-level forecast, 850–200 hPa | Free, keyless |
| Aerosol optical depth, dust, PM2.5 | [Open-Meteo Air Quality](https://open-meteo.com/en/docs/air-quality-api) (Copernicus CAMS model) | Model estimate, not a satellite measurement |
| Upper-air temperature/humidity (Trail Check) | [Open-Meteo](https://open-meteo.com) pressure-level forecast (300/250/200 hPa) | Free, keyless |
| Precipitation radar | [RainViewer](https://www.rainviewer.com/api.html) | Free public tile API |
| NWS radar loop (KEAX) | [radar.weather.gov](https://radar.weather.gov) | Static animated GIF, lazy-loaded |
| Wind/temperature overlay | [Windy.com](https://www.windy.com) embed | Lazy-loaded iframe, free embed |
| Aircraft positions | [OpenSky Network](https://opensky-network.org) anonymous REST API | See limitations below |
| Infrastructure reference points | Public FAA/NWS station locations (hardcoded, documented) | Not a live feed — see below |
| Map tiles | [OpenStreetMap](https://www.openstreetmap.org/copyright) standard tiles | Dark look applied with a CSS filter — see note below |
| Baseline / anomaly / correlation analysis | Local, client-side statistics | No external AI API |

**OpenSky Network limitations:** OpenSky's public REST API does not send CORS
headers, so a direct request from a browser is blocked by the browser itself,
regardless of rate limits — confirmed by testing the live site. The app still tries
a direct fetch first (free, costs nothing to attempt), and if that's blocked, falls
back to `data/aircraft.json` — a same-origin file with no CORS restrictions,
produced by the free scheduled workflow `.github/workflows/aircraft-snapshot.yml`.
That workflow runs on GitHub's own servers every 30 minutes (free for public repos,
no secrets, no billing), fetches OpenSky states for the KC metro bounding box, and
commits the result into the repo, where GitHub Pages serves it statically. The app
always labels which path served the data — **"live"** for a direct fetch or
**"scheduled snapshot, updated \<time\>"** for the fallback — so it's never presented
as more current than it is. If the workflow hasn't run yet (e.g., right after first
deploy) or OpenSky itself is down, the app shows **"AIRCRAFT DATA SOURCE NOT
CONNECTED"** rather than guessing or simulating aircraft.

**Map tiles note:** CARTO's free dark basemap tiles started requiring an API key
(confirmed live — the map background showed "API KEY REQUIRED" placeholder tiles).
Switched to standard OpenStreetMap tiles, which remain genuinely free and keyless,
with a CSS filter applied only to the base map layer (not the radar or other
overlays) to keep the dark look.

**Infrastructure layer limitation:** no free, CORS-accessible, client-side API for
bulk FCC antenna/tower records (ULS/ASR) was found — those datasets require
server-side downloading and processing, which would violate the $0/static-hosting
constraint. The Infrastructure layer therefore only shows a small number of
publicly documented reference points (the KEAX radar site, MCI and MKC airports) and
is explicit that broader antenna/tower data is not connected. It never presents the
mere presence of infrastructure as evidence of anything.

## Which features are live vs. need a connection

**Live and working today**, no configuration needed:
- Forecast, current conditions, active alerts (NWS)
- Extended Forecast Timeline + rainfall accumulation chart (NWS forecast grid)
- Nearby-region forecast points (Topeka, Wichita, St. Joseph, Springfield MO, Columbia MO)
- Animated precipitation radar (RainViewer) + KEAX static loop
- Windy overlay
- Sky Observation Logger, Master Timeline, Evidence Vault, Hypothesis Lab
- Local Baseline/Anomaly/Correlation engines (once you've accumulated snapshots)
- System Status panel

**Best-effort, real data, may show "NOT CONNECTED"** if the data source itself is
unreachable — never simulated:
- Live aircraft positions (OpenSky Network, live fetch — falls back to a scheduled
  server-side snapshot committed to `data/aircraft.json` every 30 minutes when the
  live browser request is CORS-blocked, which is normal for this API)

**Not built yet** (see "Regional storm intelligence roadmap" below for the full
phased plan) or **architecturally prepared but not built in this pass**:
- Regional rainfall/Excessive Rainfall Outlook map layer, flood watch/warning
  explainer layer, tropical remnant tracking, moisture-flow arrows, auto-generated
  regional event card, multi-model confidence ranges, "What's Coming?" mode
- Lightning (GOES GLM): only published as raw NetCDF files, which would need a
  processing job; not built yet
- NEXRAD dual-polarization diagnostics (velocity, ZDR, CC): raw Level II only;
  not built yet
- Scrubbable replay of a whole event window (Event Packets capture single moments)
- True background/server-side Sentinel collection (beyond the aircraft snapshot)
- Historical Event Replay UI
- Cross-storm Pattern Discovery scoreboard
- Offline app-shell caching / installable PWA
- Investigation Card image export (the on-screen card is designed to be
  screenshot-friendly instead)

## How data is stored

Everything — observations, hypotheses, Sentinel snapshots, your saved location —
lives in this browser's **IndexedDB** (database `StormTrackerKC`), and nothing is
ever sent to a server. Clearing your browser's site data for this page deletes it.
Export regularly if you want a backup.

## How to export data

Vault tab → **Export Investigation (JSON)** downloads a complete machine-readable
dump. **Export Readable Report** downloads a self-contained HTML summary you can
open in any browser or share. **Import JSON** merges a previously exported file back
into the Vault (existing records are kept; imported records are added).

## Verifying data sources

Some development environments can't reach these services directly, so the repo
includes `.github/workflows/probe-sources.yml`. Run it from the Actions tab
(Probe data sources → Run workflow) and its log shows, for every endpoint the app
uses, the HTTP status, content type, size and CORS header as seen from GitHub's
servers. That's how the current sources were chosen — and how we confirmed that
OpenSky blocks browsers (hence the snapshot robot) and that RainViewer's free tiles
stop at zoom 7.

## Aircraft tracks and history

The aircraft robot (`.github/workflows/aircraft-snapshot.yml`) now takes five
OpenSky samples 60 seconds apart every 30 minutes. Aircraft seen in two or more
samples become ~4-minute track segments in `data/aircraft.json`, drawn on the map
as lines (magenta above 25,000 ft, cyan below). Each run also appends airborne,
above-25,000-ft and no-callsign counts to `data/aircraft-history.json` (7 days
rolling), which the Anomalies tab uses as a same-hour-of-day baseline that keeps
growing even when nobody has the app open. Positions only — no crew or owner
lookups.

## Investigate tab: Atmospheric Operations and Infrastructure

**Weather-modification records** (`data/weather-modification.json`, maintained by
hand) hold documents as first-class objects: statutes, regulations, bills,
operational plans, NOAA activity reports, operator statements and datasets, each
with its agency, URL, retrieval date and how it was verified. Records reference
documents by ID. Every state lists the sources searched and what each search found,
so "no record found" is always tied to specific sources.

Findings as of 2026-10-01 (verified against primary sources by
`.github/workflows/research-sources.yml`):

- **Kansas** regulates weather modification through licenses, annual permits,
  operational plans and reports (K.S.A. 82a-1401 et seq., K.A.R. 98-4). Two 2026
  bills to ban it (SB 449, HB 2439) died. One documented program: the Western Kansas
  Weather Modification Program (hail suppression and rain enhancement in southwest and
  west-central Kansas, based at Lakin, ~369 mi from KC). It has NOAA reports for 2002
  through 2016, and its operator says it's suspended for funding reasons. Status:
  HISTORICAL. License and permit numbers aren't online.
- **Missouri**: no weather-modification permit statute was found, and the NOAA-report
  dataset (2000–2025) has no Missouri reports. 2026 bills to ban it (SB 860, HB 2388,
  HB 2656) aren't shown as enacted. The app displays "NO VERIFIED RECORD FOUND IN
  SEARCHED PUBLIC SOURCES", which is not the same as "none exists". Missouri DNR
  systems still need a manual search.

To add a record, append a document and a record to the JSON with its source URL.

**Atmospheric infrastructure** (`data/atmospheric-sites.json`) is rebuilt monthly by
`.github/workflows/atmospheric-sites.yml` running `scripts/build_atmospheric_sites.py`.
That script pulls every site within 200 miles of KC from these feeds:
- radars from the NWS API
- weather-balloon sites and ASOS/AWOS stations from Iowa Environmental Mesonet
- air-quality monitors from EPA AirNow
- airports from OurAirports
- NWS offices from the NWS API (address only, since it gives no coordinates, so not
  mapped)

No coordinates are typed in by hand. Categories describe what a facility is (radar,
weather monitoring, upper air, NOAA/NWS, aviation, air quality), never involvement in
weather modification. Environmental-permit locations aren't connected yet, because
no free machine-readable feed was found.

## Investigate tab: Flight History

`data/aircraft-tracks.json` is a rolling 24-hour archive written by the same
30-minute aircraft workflow: every run's ~4-minute recording of airborne aircraft
(positions, altitude, heading, speed, vertical rate; values rounded to keep the file
small). Investigate → ✈️ Flight History draws every recorded path for the last
1/3/6/12/24 hours, filtered by height (above/below 25,000 ft), with:
- a data-completeness figure (recordings found vs. expected, plus a warning when
  the newest one is stale), since missing runs mean no data, not an empty sky;
- the heights flown, in 5,000 ft bands, to compare with Trail Check and the
  upper-air profile;
- aircraft seen in two or more separate recordings, with the usual ordinary reasons
  (scheduled routes, helicopters, training, approaches, survey flights).

The 30-minute gaps between recordings are never drawn or interpolated. Aircraft type
isn't shown, because OpenSky's state feed doesn't include it. There are no owner,
pilot or crew lookups.

## Investigate tab: Satellite Rewind

Shows GOES-East imagery over KC at any 10-minute time in roughly the past 3 months,
straight from NASA GIBS (WMTS with a TIME value). The probe workflow confirmed the
layers, tile levels and time ranges from GIBS's capabilities file:
- True color: `GOES-East_ABI_GeoColor`, Level 7
- Visible: `GOES-East_ABI_Band2_Red_Visible_1km`, Level 7
- Infrared: `GOES-East_ABI_Band13_Clean_Infrared`, Level 6
- Air mass: `GOES-East_ABI_Air_Mass`, Level 6
- Dust: `GOES-East_ABI_Dust`, Level 7, published only at some times

There are also optional overlays:
- past NEXRAD radar from Iowa Environmental Mesonet's archive
  (`ridge::USCOMP-N0Q-YYYYMMDDHHMM`, 5-minute steps)
- flight paths recorded within ±20 minutes, labeled CORRELATED (time only)

You can use a 24-hour slider, ±10 min / ±1 h steps, a date box, or a 2-hour playback.
The newest frames appear 40–70 minutes late. When a frame doesn't exist, the app
says NO IMAGE FOR THIS TIME and why (too new, older than the archive, or a gap). It
never fills one in. Nothing is stored in the repo; images load on demand.

## Event Packets

Vault → Capture Event Packet freezes everything at one moment: surface observation,
active alerts, radar frame time, the GOES infrared, water-vapor and NEXRAD image
tiles over KC (saved as images), the full upper-air profile, trail forecast,
aerosol values, aircraft list and tracks, recorded flight history from the hour
before, and your observations from ±2 hours.
Each packet has an ID (e.g. `KC-2026-10-01-114539Z`), per-source provenance
(product, URL, retrieval time, valid time, OK/unavailable) and a SHA-256 fingerprint
of its captured content. You can mark a status (UNRESOLVED / EXPLAINED /
INSUFFICIENT DATA) and assess a list of ordinary explanations; the app never fills
those in itself. Packets appear in the Timeline and are included in JSON and HTML
exports.

## How Trail Check works

Jet exhaust contains water vapor. In air colder than about −40 °C it freezes into
ice crystals (a contrail). If the air is saturated with respect to ice, the trail
lasts and spreads; if it's dry, it disappears within seconds to a minute. Trail
Check pulls Open-Meteo's forecast temperature and humidity at 300, 250 and 200 hPa
(roughly 30,000–39,000 ft), converts humidity over water to humidity over ice, and
applies a simplified Schmidt-Appleman check:

- warmer than −40 °C → no trails expected
- colder, ice-humidity below 95% → short-lived trails
- colder, ice-humidity 95% or more → long-lasting / spreading trails possible

When you log a "Trails" observation, what you saw is compared with the forecast at
that moment and stored as "matches the forecast" or "doesn't match the forecast."
Model humidity at cruise altitude has real error, and a trail may come from a plane
at a different level than the one forecast, so a single mismatch isn't meaningful —
the value is in the pattern across many logged observations. The app draws no
conclusion about what a mismatch means; that's yours to judge from your log.

The app doesn't identify pilots, crew, or individual aircraft owners, and won't.

## How the Anomaly Engine works

Every ~15 minutes (only while the app is open — see Sentinel Mode below), or on
demand via "Take Snapshot Now," the app records a snapshot of temperature, pressure,
wind speed, and nearby aircraft count. Once at least 5 snapshots exist, each new
metric is compared against the mean and standard deviation of your own accumulated
history using a z-score:

- `|z| < 1` → **NORMAL**
- `1 ≤ |z| < 2` → **WATCH**
- `2 ≤ |z| < 3` → **UNUSUAL**
- `|z| ≥ 3` → **STRONG ANOMALY**

With fewer than 5 snapshots, the engine reports **INSUFFICIENT DATA** rather than
guessing. The sample size and the exact numbers behind every classification are
always shown.

## How hypotheses are tested

A hypothesis is a claim plus predictions, required data, and known ordinary
alternative explanations. You link existing observations to it as **supporting** or
**contradicting** evidence. The Lab computes a status (`UNTESTED`, `SUPPORTED BY
CURRENT OBSERVATIONS`, `NOT SUPPORTED BY CURRENT OBSERVATIONS`, or `MIXED`) purely
from the counts of linked evidence — it is a running scoreboard, never a proof, and
the UI never states or implies causation.

## Regional storm intelligence roadmap

The Extended Forecast Timeline above is **Phase 1** of a larger plan to see weather
systems (including tropical moisture/remnants) approaching Kansas City before they
arrive, not just current local conditions:

- **Phase 1 (done):** Extended forecast timeline, rainfall accumulation chart,
  nearby-region forecast points — all from the NWS forecast grid.
- **Phase 2 (not built):** A dedicated flood/Excessive Rainfall Outlook layer with a
  plain-language legend for Flood Watch/Warning, Flash Flood Warning, and WPC's ERO
  categories.
- **Phase 3 (not built):** Automatic regional storm-event detection and a
  human-readable summary card.
- **Phase 4 (not built):** Tropical cyclone remnant/moisture tracking via NHC data,
  correctly relabeled once a system loses tropical classification.
- **Phase 5 (not built):** Atmospheric moisture-flow visualization — only if a real,
  verifiable free data source is confirmed; otherwise this stays undone rather than
  showing invented arrows.

Phases 2 and 4 depend on WPC/NHC GIS services this build hasn't verified a reliable,
CORS-accessible, free endpoint for yet (unlike `api.weather.gov`, which is proven
live in this app). They'll be built once that's confirmed, following the same
pattern as the aircraft layer: a real fetch attempt, and an honest "NOT CONNECTED"
rather than a guess if it can't be verified.

## Privacy

No account, no tracking, no analytics, no server component. Location is only
requested when you explicitly tap "Attach GPS" or "Use My GPS Location," and it is
stored only in your browser.

## Known limitations

- **Sentinel Mode (pressure/temperature/wind baseline snapshots) only runs while
  this tab is open in your browser** — it is client-side JavaScript, not a
  background service. The aircraft layer is the one exception: it now has a real
  free background job (see below), and the same pattern could be extended to the
  rest of Sentinel's metrics later if you want that — it's intentionally not done
  yet so no additional scheduled infrastructure gets added without your review.
- Aircraft data depends on OpenSky Network's free, unauthenticated tier, which is
  CORS-blocked from direct browser use — worked around with a scheduled GitHub
  Actions job (`.github/workflows/aircraft-snapshot.yml`, free for public repos)
  that writes `data/aircraft.json` every 30 minutes. It can still show "NOT
  CONNECTED" if OpenSky itself is down or before the workflow's first run.
- Correlation clustering is a simple time-window co-occurrence check — it is a
  starting point for investigation, not a validated statistical test.
- Historical Event Replay and cross-storm Pattern Discovery are not built yet; the
  data model (timestamped, geotagged records in IndexedDB) supports adding them
  later without a rewrite.
- No offline/PWA app-shell caching yet — the Evidence Vault itself persists offline
  since IndexedDB is local, but the app needs a network connection to first load its
  external libraries and iframes.

## Zero-cost architecture

Every data source above is free and keyless. There is no billing relationship with
any provider, no server to pay for (GitHub Pages hosting is free), and no paid AI
API is called by default — the Storm Intelligence / anomaly / correlation logic runs
entirely as client-side JavaScript. If a feature can't be done for free and honestly,
the app says **"DATA SOURCE NOT CONNECTED"** instead of faking it.
