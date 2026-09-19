/* Storm Tracker KC — pure logic extracted from index.html so it can be unit
   tested with Node/Vitest. Loaded in the browser as a plain classic script
   (window.Stats, window.AnomalyEngine, etc.), and via require()/import in
   tests. Behavior must stay identical to what was inline in index.html. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    Object.assign(root, factory());
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  const Stats = {
    mean(arr){ return arr.reduce((a,b)=>a+b,0) / arr.length; },
    stddev(arr, m){ m = (m===undefined)? this.mean(arr): m; const v = arr.reduce((a,b)=>a+Math.pow(b-m,2),0)/arr.length; return Math.sqrt(v); },
    zscore(value, mean, sd){ if(sd === 0 || !isFinite(sd)) return 0; return (value-mean)/sd; }
  };

  const MIN_BASELINE_SAMPLES = 5;
  const AnomalyEngine = {
    classifyMetric(key, label, units, latestValue, snapshots){
      const values = snapshots.map(s=>s[key]).filter(v=>typeof v === "number" && isFinite(v));
      if(latestValue == null || !isFinite(latestValue)) return null;
      if(values.length < MIN_BASELINE_SAMPLES){
        return { key, label, units, value: latestValue, status: "insufficient", sample: values.length,
          explanation: `Only ${values.length} historical snapshot(s) recorded — need at least ${MIN_BASELINE_SAMPLES} before "unusual" is meaningful.` };
      }
      const mean = Stats.mean(values);
      const sd = Stats.stddev(values, mean);
      const z = Stats.zscore(latestValue, mean, sd);
      const az = Math.abs(z);
      let status = "normal";
      if(az >= 3) status = "strong";
      else if(az >= 2) status = "unusual";
      else if(az >= 1) status = "watch";
      return {
        key, label, units, value: latestValue, mean, sd, z, sample: values.length, status,
        explanation: `${label} is ${latestValue}${units} vs. a baseline mean of ${mean.toFixed(2)}${units} across ${values.length} local snapshots (z=${z.toFixed(2)}).`
      };
    }
  };

  const CorrelationEngine = {
    findClusters(events, windowMinutes){
      windowMinutes = windowMinutes || 30;
      const sorted = events.slice().sort((a,b)=>a.timestamp-b.timestamp);
      const clusters = [];
      for(let i=0;i<sorted.length;i++){
        const windowEvents = [sorted[i]];
        for(let j=i+1;j<sorted.length;j++){
          if((sorted[j].timestamp - sorted[i].timestamp) <= windowMinutes*60000){
            windowEvents.push(sorted[j]);
          } else break;
        }
        const categories = new Set(windowEvents.map(e=>e.category));
        if(windowEvents.length >= 2 && categories.size >= 2){
          clusters.push({ start: sorted[i].timestamp, events: windowEvents, categories: [...categories] });
        }
      }
      const seen = new Set();
      return clusters.filter(c=>{
        const key = c.start + "|" + c.events.length;
        if(seen.has(key)) return false;
        seen.add(key); return true;
      }).slice(0, 20);
    }
  };

  function computeHypStatus(h){
    const s = h.supporting.length, c = h.contradicting.length;
    if(s===0 && c===0) return "UNTESTED";
    if(s>0 && c===0) return "SUPPORTED BY CURRENT OBSERVATIONS";
    if(c>0 && s===0) return "NOT SUPPORTED BY CURRENT OBSERVATIONS";
    return "MIXED";
  }

  function escapeHtml(s){ return (s||"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }

  function fmtTime(ts){ return new Date(ts).toLocaleString(undefined, { weekday:'short', hour:'numeric', minute:'2-digit', month:'short', day:'numeric' }); }

  function normalizeAircraftStates(rows, sourceLabel){
    return rows.filter(r=>r[5]!=null && r[6]!=null).map(r=>({
      source: sourceLabel,
      icao24: r[0], callsign: (r[1]||"").trim() || "unknown",
      lon: r[5], lat: r[6],
      altitude: r[7], onGround: r[8], velocity: r[9], heading: r[10]
    }));
  }

  function filterStatesInBox(states, lamin, lomin, lamax, lomax){
    return states.filter(s => s[6]>=lamin && s[6]<=lamax && s[5]>=lomin && s[5]<=lomax);
  }

  return {
    Stats, AnomalyEngine, CorrelationEngine, computeHypStatus, escapeHtml, fmtTime,
    normalizeAircraftStates, filterStatesInBox, MIN_BASELINE_SAMPLES
  };
});
