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
| Precipitation radar | [RainViewer](https://www.rainviewer.com/api.html) | Free public tile API |
| NWS radar loop (KEAX) | [radar.weather.gov](https://radar.weather.gov) | Static animated GIF, lazy-loaded |
| Wind/temperature overlay | [Windy.com](https://www.windy.com) embed | Lazy-loaded iframe, free embed |
| Aircraft positions | [OpenSky Network](https://opensky-network.org) anonymous REST API | See limitations below |
| Infrastructure reference points | Public FAA/NWS station locations (hardcoded, documented) | Not a live feed — see below |
| Map tiles | [CARTO](https://carto.com/attributions) / [OpenStreetMap](https://www.openstreetmap.org/copyright) | Free dark basemap |
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
- Animated precipitation radar (RainViewer) + KEAX static loop
- Windy overlay
- Sky Observation Logger, Master Timeline, Evidence Vault, Hypothesis Lab
- Local Baseline/Anomaly/Correlation engines (once you've accumulated snapshots)
- System Status panel

**Best-effort, may show "NOT CONNECTED"** depending on network conditions, browser,
or OpenSky's rate limits:
- Live aircraft positions (OpenSky Network)

**Architecturally prepared but not built in this pass** (see Known Limitations):
- True background/server-side Sentinel collection
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
