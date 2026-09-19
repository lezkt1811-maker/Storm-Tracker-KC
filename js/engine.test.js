import { describe, it, expect } from "vitest";
import {
  Stats,
  AnomalyEngine,
  CorrelationEngine,
  computeHypStatus,
  escapeHtml,
  fmtTime,
  normalizeAircraftStates,
  filterStatesInBox,
  MIN_BASELINE_SAMPLES
} from "./engine.js";

describe("Stats", () => {
  it("computes the mean", () => {
    expect(Stats.mean([1, 2, 3, 4])).toBe(2.5);
  });

  it("computes standard deviation", () => {
    expect(Stats.stddev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2, 5);
  });

  it("returns 0 for zscore when stddev is 0", () => {
    expect(Stats.zscore(10, 5, 0)).toBe(0);
  });

  it("returns 0 for zscore when stddev is not finite", () => {
    expect(Stats.zscore(10, 5, NaN)).toBe(0);
    expect(Stats.zscore(10, 5, Infinity)).toBe(0);
  });

  it("computes zscore normally", () => {
    expect(Stats.zscore(10, 5, 5)).toBe(1);
  });
});

describe("AnomalyEngine.classifyMetric", () => {
  it("returns null when the latest value is missing", () => {
    expect(AnomalyEngine.classifyMetric("t", "Temp", "C", null, [])).toBeNull();
    expect(AnomalyEngine.classifyMetric("t", "Temp", "C", NaN, [])).toBeNull();
  });

  it("reports insufficient data below MIN_BASELINE_SAMPLES", () => {
    const snapshots = Array.from({ length: MIN_BASELINE_SAMPLES - 1 }, (_, i) => ({ t: i }));
    const result = AnomalyEngine.classifyMetric("t", "Temp", "C", 10, snapshots);
    expect(result.status).toBe("insufficient");
    expect(result.sample).toBe(MIN_BASELINE_SAMPLES - 1);
  });

  it("ignores non-numeric/non-finite history values when counting samples", () => {
    const snapshots = [
      { t: 1 }, { t: 2 }, { t: 3 }, { t: null }, { t: "x" }, { t: NaN }
    ];
    const result = AnomalyEngine.classifyMetric("t", "Temp", "C", 10, snapshots);
    expect(result.status).toBe("insufficient");
    expect(result.sample).toBe(3);
  });

  it("classifies as normal within 1 standard deviation", () => {
    const snapshots = [{ t: 10 }, { t: 10 }, { t: 10 }, { t: 10 }, { t: 10 }];
    const result = AnomalyEngine.classifyMetric("t", "Temp", "C", 10, snapshots);
    expect(result.status).toBe("normal");
  });

  it("classifies watch/unusual/strong once |z| clears 1/2/3", () => {
    const snapshots = [{ t: 9 }, { t: 11 }, { t: 9 }, { t: 11 }, { t: 10 }];
    const mean = Stats.mean(snapshots.map(s => s.t));
    const sd = Stats.stddev(snapshots.map(s => s.t), mean);

    // Offsets picked comfortably inside each bracket (not exactly on a
    // boundary) so floating-point rounding of sd can't flip the bucket.
    const watch = AnomalyEngine.classifyMetric("t", "Temp", "C", mean + sd * 1.5, snapshots);
    expect(watch.status).toBe("watch");

    const unusual = AnomalyEngine.classifyMetric("t", "Temp", "C", mean + sd * 2.5, snapshots);
    expect(unusual.status).toBe("unusual");

    const strong = AnomalyEngine.classifyMetric("t", "Temp", "C", mean + sd * 3.5, snapshots);
    expect(strong.status).toBe("strong");
  });
});

describe("CorrelationEngine.findClusters", () => {
  it("returns no clusters for an empty event list", () => {
    expect(CorrelationEngine.findClusters([], 30)).toEqual([]);
  });

  it("does not cluster events from a single category", () => {
    const events = [
      { timestamp: 0, category: "ALERT" },
      { timestamp: 60000, category: "ALERT" }
    ];
    expect(CorrelationEngine.findClusters(events, 30)).toEqual([]);
  });

  it("clusters events from 2+ categories within the time window", () => {
    const events = [
      { timestamp: 0, category: "ALERT" },
      { timestamp: 5 * 60000, category: "OBSERVATION" }
    ];
    const clusters = CorrelationEngine.findClusters(events, 30);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].categories.sort()).toEqual(["ALERT", "OBSERVATION"]);
  });

  it("does not cluster events outside the time window", () => {
    const events = [
      { timestamp: 0, category: "ALERT" },
      { timestamp: 31 * 60000, category: "OBSERVATION" }
    ];
    expect(CorrelationEngine.findClusters(events, 30)).toEqual([]);
  });

  it("de-duplicates clusters with the same start time and event count", () => {
    const events = [
      { timestamp: 0, category: "ALERT" },
      { timestamp: 60000, category: "OBSERVATION" },
      { timestamp: 120000, category: "ANOMALY" }
    ];
    const clusters = CorrelationEngine.findClusters(events, 30);
    const keys = clusters.map(c => `${c.start}|${c.events.length}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("computeHypStatus", () => {
  it("is UNTESTED with no evidence", () => {
    expect(computeHypStatus({ supporting: [], contradicting: [] })).toBe("UNTESTED");
  });

  it("is SUPPORTED with only supporting evidence", () => {
    expect(computeHypStatus({ supporting: [1], contradicting: [] })).toBe(
      "SUPPORTED BY CURRENT OBSERVATIONS"
    );
  });

  it("is NOT SUPPORTED with only contradicting evidence", () => {
    expect(computeHypStatus({ supporting: [], contradicting: [1] })).toBe(
      "NOT SUPPORTED BY CURRENT OBSERVATIONS"
    );
  });

  it("is MIXED with both", () => {
    expect(computeHypStatus({ supporting: [1], contradicting: [1] })).toBe("MIXED");
  });
});

describe("escapeHtml", () => {
  it("escapes the five HTML-significant characters", () => {
    expect(escapeHtml(`<script>&"'`)).toBe("&lt;script&gt;&amp;&quot;&#39;");
  });

  it("treats null/undefined as an empty string", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });

  it("neutralizes an XSS payload from an untrusted API/user field", () => {
    const payload = '<img src=x onerror="alert(1)">';
    expect(escapeHtml(payload)).not.toContain("<img");
  });
});

describe("fmtTime", () => {
  it("returns a non-empty string for a timestamp", () => {
    expect(typeof fmtTime(Date.now())).toBe("string");
    expect(fmtTime(Date.now()).length).toBeGreaterThan(0);
  });
});

describe("normalizeAircraftStates", () => {
  it("drops rows with missing lat/lon", () => {
    const rows = [
      ["abc123", "UAL123", null, null, null, -94.5, 39.1, 300, false, 200, 90]
    ];
    // lon (index 5) is set, lat (index 6) is set -> should be kept
    expect(normalizeAircraftStates(rows, "test")).toHaveLength(1);

    const missingLat = [["abc123", "UAL123", null, null, null, -94.5, null, 300, false, 200, 90]];
    expect(normalizeAircraftStates(missingLat, "test")).toHaveLength(0);
  });

  it("maps OpenSky's array fields to named fields", () => {
    const rows = [["abc123", " UAL123 ", null, null, null, -94.5, 39.1, 300, false, 200, 90]];
    const [plane] = normalizeAircraftStates(rows, "OpenSky Network (live)");
    expect(plane).toMatchObject({
      source: "OpenSky Network (live)",
      icao24: "abc123",
      callsign: "UAL123",
      lon: -94.5,
      lat: 39.1,
      altitude: 300,
      onGround: false,
      velocity: 200,
      heading: 90
    });
  });

  it("falls back to 'unknown' for a blank callsign", () => {
    const rows = [["abc123", "   ", null, null, null, -94.5, 39.1, 300, false, 200, 90]];
    expect(normalizeAircraftStates(rows, "test")[0].callsign).toBe("unknown");

    const rowsNullCallsign = [["abc123", null, null, null, null, -94.5, 39.1, 300, false, 200, 90]];
    expect(normalizeAircraftStates(rowsNullCallsign, "test")[0].callsign).toBe("unknown");
  });
});

describe("filterStatesInBox", () => {
  const KC_LAT = 39.0997, KC_LON = -94.5786;
  const states = [
    ["inside", null, null, null, null, KC_LON, KC_LAT, 300, false, 200, 90],
    ["far-away", null, null, null, null, 0, 0, 300, false, 200, 90]
  ];

  it("keeps rows inside the bounding box and drops rows outside it", () => {
    const result = filterStatesInBox(states, KC_LAT - 1, KC_LON - 1, KC_LAT + 1, KC_LON + 1);
    expect(result).toHaveLength(1);
    expect(result[0][0]).toBe("inside");
  });

  it("returns an empty array when nothing is in range", () => {
    const result = filterStatesInBox(states, 80, 80, 81, 81);
    expect(result).toEqual([]);
  });
});
