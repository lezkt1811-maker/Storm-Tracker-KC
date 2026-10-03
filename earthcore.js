/* =========================================================================
   STORM TRACKER KC — EARTH CORE
   3D Seismic + Tectonic Explorer

   Self-contained: renders its own 3D globe on a 2D <canvas> (no libraries),
   reads earthquakes live from the public USGS FDSN event API, and reads
   plate boundaries / faults / volcanoes / borders from data/earthcore/*.json
   (built from published sources by scripts/build_earthcore_layers.py).

   Rules this file follows:
   - Nothing is invented or simulated. If a source fails to load, its layer
     shows "DATA SOURCE NOT CONNECTED" and nothing is drawn in its place.
   - Every value shown carries its source. Distances worked out here are
     labeled CALCULATED; nearness is never presented as cause.
   ========================================================================= */
(function(){
"use strict";

const panel = document.getElementById('tab-earth');
if(!panel) return;

/* ---------------- constants ---------------- */
const KC = { lat: 39.0997, lon: -94.5786 };
const EARTH_R_KM = 6371;
const USGS_BASE = 'https://earthquake.usgs.gov/fdsnws/event/1/';
const USGS_MAX = 20000;
const DEG = Math.PI / 180;
const NOT_CONNECTED = 'DATA SOURCE NOT CONNECTED';

const DEPTH_BANDS = [
  { max: 20,       color: '#22D3EE', label: '0–20 km' },
  { max: 50,       color: '#2563FF', label: '20–50 km' },
  { max: 100,      color: '#6366F1', label: '50–100 km' },
  { max: 300,      color: '#A855F7', label: '100–300 km' },
  { max: Infinity, color: '#FF2ED1', label: '300–700+ km' },
];
const MAG_BANDS = [
  { max: 2.5,      color: '#AEB8D6', label: 'below M2.5' },
  { max: 4.5,      color: '#22D3EE', label: 'M2.5–4.5' },
  { max: 6,        color: '#FFD23F', label: 'M4.5–6' },
  { max: 7,        color: '#FF9F1C', label: 'M6–7' },
  { max: Infinity, color: '#FF4757', label: 'M7+' },
];
const PLATE_GROUPS = {
  convergent: { color: '#FF2EC4', label: 'Convergent (subduction / collision)' },
  divergent:  { color: '#39FF88', label: 'Divergent (spreading ridge / rift)' },
  transform:  { color: '#FFD23F', label: 'Transform (sliding past)' },
};
const PLATE_GROUP_KEYS = Object.keys(PLATE_GROUPS);
const REGIONS = {
  global: { label: '🌐 Global' },
  kc:     { label: '📍 Near KC (1,000 km)' },
  us:     { label: '🇺🇸 Lower 48 US' },
  view:   { label: '🎯 Around globe center (2,500 km)' },
};
const PRESETS = { '6h': 6, '12h': 12, '24h': 24, '7d': 168, '30d': 720 };

/* ---------------- state ---------------- */
const S = {
  inited: false,
  lon0: -97, lat0: 28, zoom: 1,
  xray: true, exag: 3, colorMode: 'depth', pins: true,
  layers: { quakes: true, plates: true, faults: false, volcanoes: true, borders: true },
  f: { preset: '7d', start: '', end: '', minMag: '2.5', maxMag: '', minDepth: '', maxDepth: '', region: 'global', nonQuake: false },
  quakes: [], qx: null, qy: null, qz: null,
  qMeta: null,         // { url, fetchedAt, count, total, capped, regionNote, error }
  tMin: 0, tMax: 0, cursor: 0,
  playing: false, speedSec: 20, trail: 'all',
  selected: null,      // { kind:'quake'|'volcano', i }
  data: { plates: null, faults: null, borders: null, volcanoes: null },
  dataErr: { plates: null, faults: null, borders: null, volcanoes: null },
  loading: { faults: false },
};

/* ---------------- tiny utils ---------------- */
const $ = id => document.getElementById(id);
function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c])); }
function fmtUTC(ms){ const d = new Date(ms); return d.toISOString().replace('T',' ').slice(0,19) + ' UTC'; }
function fmtUTCShort(ms){ const d = new Date(ms); return d.toISOString().replace('T',' ').slice(0,16) + ' UTC'; }
function fmtLocal(ms){ return new Date(ms).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' }); }
function num(n, d){ return (n == null || isNaN(n)) ? '—' : Number(n).toFixed(d); }
function bandFor(bands, v){ for(const b of bands){ if(v < b.max) return b; } return bands[bands.length-1]; }
function plateGroup(cls, classes){ const c = classes && classes[cls]; return c ? c[1] : 'transform'; }
function unit(lon, lat){ const cl = Math.cos(lat*DEG); return [cl*Math.cos(lon*DEG), cl*Math.sin(lon*DEG), Math.sin(lat*DEG)]; }

/* =========================================================================
   LINE LAYERS (surface lines on the unit sphere)
   ========================================================================= */
function buildLineLayer(flatLines, catOf){
  // flatLines: array of [lon,lat,lon,lat,...]; catOf(i) -> small int category
  let n = 0; for(const p of flatLines) n += p.length/2;
  const xyz = new Float32Array(n*3);
  const starts = [], cats = [], src = [];
  let k = 0;
  flatLines.forEach((p, li)=>{
    const cat = catOf ? catOf(li) : 0;
    let px=0, py=0, pz=0, first = true;
    for(let j=0; j<p.length; j+=2){
      const u = unit(p[j], p[j+1]);
      // Break the line where consecutive points are >20 deg apart (e.g. antimeridian jumps)
      if(first || (u[0]*px + u[1]*py + u[2]*pz) < 0.94){ starts.push(k); cats.push(cat); src.push(li); first = false; }
      xyz[k*3]=u[0]; xyz[k*3+1]=u[1]; xyz[k*3+2]=u[2];
      px=u[0]; py=u[1]; pz=u[2]; k++;
    }
  });
  starts.push(k);
  return { xyz, n: k, starts: Int32Array.from(starts), cats: Uint8Array.from(cats), src: Int32Array.from(src),
           sx: new Float32Array(k), sy: new Float32Array(k), d: new Float32Array(k) };
}

let graticule = null;
function buildGraticule(){
  const lines = [];
  for(let lon=-180; lon<180; lon+=30){ const p=[]; for(let lat=-90; lat<=90; lat+=3) p.push(lon, lat); lines.push(p); }
  for(let lat=-60; lat<=60; lat+=30){ const p=[]; for(let lon=-180; lon<=180; lon+=3) p.push(lon, lat); lines.push(p); }
  graticule = buildLineLayer(lines, i => (i >= 12 && lines[i][1] === 0) ? 1 : 0);
}

/* =========================================================================
   RENDERER
   ========================================================================= */
const canvas = $('ecCanvas');
const ctx = canvas.getContext('2d');
let W = 0, H = 0, DPR = 1, CX = 0, CY = 0, SC = 1;
let M = [0,0,0, 0,0,0, 0,0,0];   // rows: right, up, depth
let raf = 0, lastTs = 0;
const hit = { kind: [], i: [], x: [], y: [], r: [] };

function updateMatrix(){
  const sl = Math.sin(S.lon0*DEG), cl = Math.cos(S.lon0*DEG);
  const sp = Math.sin(S.lat0*DEG), cp = Math.cos(S.lat0*DEG);
  M = [ -sl, cl, 0,
        -sp*cl, -sp*sl, cp,
         cp*cl,  cp*sl, sp ];
}

function resize(){
  const wrap = $('ecGlobeWrap');
  const w = wrap.clientWidth, h = wrap.clientHeight;
  if(!w || !h) return;
  DPR = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(w*DPR); canvas.height = Math.round(h*DPR);
  W = w; H = h;
  requestDraw();
}

function projectLayer(L){
  const [a0,a1,a2,b0,b1,b2,c0,c1,c2] = M;
  const xyz = L.xyz, sx = L.sx, sy = L.sy, d = L.d;
  for(let i=0, k=0; i<L.n; i++, k+=3){
    const x = xyz[k], y = xyz[k+1], z = xyz[k+2];
    sx[i] = CX + (a0*x + a1*y + a2*z) * SC;
    sy[i] = CY - (b0*x + b1*y + b2*z) * SC;
    d[i]  = c0*x + c1*y + c2*z;
  }
}

// Fill Path2D objects for front / back halves, one per category.
function tracePaths(L, nCat){
  const front = [], back = [];
  for(let c=0; c<nCat; c++){ front.push(new Path2D()); back.push(new Path2D()); }
  const { starts, cats, sx, sy, d } = L;
  for(let li=0; li<starts.length-1; li++){
    const s = starts[li], e = starts[li+1], cat = cats[li];
    let last = null;
    for(let j=s+1; j<e; j++){
      const isFront = (d[j-1] + d[j]) >= 0;
      const P = isFront ? front[cat] : back[cat];
      if(P !== last){ P.moveTo(sx[j-1], sy[j-1]); last = P; }
      P.lineTo(sx[j], sy[j]);
    }
  }
  return { front, back };
}

function requestDraw(){
  if(raf) return;
  raf = requestAnimationFrame(frame);
}

function frame(ts){
  raf = 0;
  if(!panel.classList.contains('active')){ S.playing = false; syncPlayBtn(); return; }
  if(S.playing){
    const dt = lastTs ? Math.min(100, ts - lastTs) : 16;
    const span = Math.max(1, S.tMax - S.tMin);
    S.cursor += span * (dt / (S.speedSec*1000));
    if(S.cursor >= S.tMax){ S.cursor = S.tMax; S.playing = false; syncPlayBtn(); }
    syncScrub();
  }
  lastTs = S.playing ? ts : 0;
  draw();
  if(S.playing || tween) requestDraw();
}

function quakeRadiusPx(m){
  const mm = (m == null || isNaN(m)) ? 1 : Math.max(0, m);
  return Math.max(1.6, 0.9 + 0.17*mm*mm) * Math.min(1.8, Math.sqrt(S.zoom));
}
function quakeColor(q){
  return S.colorMode === 'depth' ? bandFor(DEPTH_BANDS, q.depth).color : bandFor(MAG_BANDS, q.mag == null ? 0 : q.mag).color;
}
function hyporad(depth){
  if(!S.xray) return 1;
  return Math.max(0.05, 1 - Math.max(0, depth) * S.exag / EARTH_R_KM);
}

function draw(){
  if(!W) return;
  tweenStep();
  updateMatrix();
  ctx.setTransform(DPR,0,0,DPR,0,0);
  ctx.clearRect(0,0,W,H);
  CX = W/2; CY = H/2;
  SC = Math.min(W, H) * 0.43 * S.zoom;
  hit.kind.length = hit.i.length = hit.x.length = hit.y.length = hit.r.length = 0;

  // Atmosphere glow + globe body
  const glow = ctx.createRadialGradient(CX, CY, SC*0.96, CX, CY, SC*1.18);
  glow.addColorStop(0, 'rgba(34,211,238,0.28)'); glow.addColorStop(1, 'rgba(34,211,238,0)');
  ctx.fillStyle = glow; ctx.beginPath(); ctx.arc(CX, CY, SC*1.18, 0, Math.PI*2); ctx.fill();

  const body = ctx.createRadialGradient(CX - SC*0.35, CY - SC*0.35, SC*0.1, CX, CY, SC);
  if(S.xray){ body.addColorStop(0, 'rgba(37,99,255,0.20)'); body.addColorStop(1, 'rgba(7,11,20,0.55)'); }
  else      { body.addColorStop(0, '#0f1a3a'); body.addColorStop(1, '#070B14'); }
  ctx.fillStyle = body; ctx.beginPath(); ctx.arc(CX, CY, SC, 0, Math.PI*2); ctx.fill();

  // Collect line layers
  const lineSets = [];
  if(graticule){ projectLayer(graticule); lineSets.push({ L: graticule, n: 2, styles: [['rgba(174,184,214,0.10)', 0.6], ['rgba(174,184,214,0.22)', 0.8]] }); }
  if(S.layers.borders && S.data.borders){
    const L = S.data.borders.layer; projectLayer(L);
    lineSets.push({ L, n: 3, styles: [['rgba(34,211,238,0.55)', 0.8], ['rgba(244,246,255,0.38)', 0.7], ['rgba(174,184,214,0.22)', 0.5]] });
  }
  if(S.layers.faults && S.data.faults){
    const L = S.data.faults.layer; projectLayer(L);
    lineSets.push({ L, n: 1, styles: [['rgba(168,85,247,0.75)', 0.8]] });
  }
  if(S.layers.plates && S.data.plates){
    const L = S.data.plates.layer; projectLayer(L);
    lineSets.push({ L, n: 3, styles: PLATE_GROUP_KEYS.map(k => [PLATE_GROUPS[k].color, 2]) });
  }
  const traced = lineSets.map(ls => ({ ls, p: tracePaths(ls.L, ls.n) }));

  // Back half of surface lines (seen through the globe in X-ray mode)
  if(S.xray){
    ctx.globalAlpha = 0.22;
    for(const { ls, p } of traced){
      for(let c=0; c<ls.n; c++){ ctx.strokeStyle = ls.styles[c][0]; ctx.lineWidth = ls.styles[c][1]*0.8; ctx.stroke(p.back[c]); }
    }
    ctx.globalAlpha = 1;
  }

  // Depth reference shells (true spheres => concentric circles)
  if(S.xray){
    ctx.font = '10px "IBM Plex Mono", monospace'; ctx.textAlign = 'center';
    for(const km of [100, 300, 700]){
      const r = hyporad(km) * SC;
      ctx.strokeStyle = 'rgba(174,184,214,0.16)'; ctx.setLineDash([3,4]); ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.arc(CX, CY, r, 0, Math.PI*2); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(174,184,214,0.6)';
      ctx.fillText(km + ' km', CX, CY + r - 3);
    }
  }

  // Earthquakes
  let shown = 0;
  if(S.layers.quakes && S.quakes.length){
    shown = drawQuakes();
  }

  // Front half of surface lines on top
  for(const { ls, p } of traced){
    for(let c=0; c<ls.n; c++){ ctx.strokeStyle = ls.styles[c][0]; ctx.lineWidth = ls.styles[c][1]; ctx.stroke(p.front[c]); }
  }

  // Limb
  ctx.strokeStyle = 'rgba(34,211,238,0.65)'; ctx.lineWidth = 1.2;
  ctx.beginPath(); ctx.arc(CX, CY, SC, 0, Math.PI*2); ctx.stroke();

  // Volcanoes
  if(S.layers.volcanoes && S.data.volcanoes) drawVolcanoes();

  // Kansas City marker
  drawKC();

  // Selection highlight
  drawSelection();

  // Stamp
  const st = $('ecStamp');
  if(S.quakes.length){
    st.textContent = `${shown.toLocaleString()} of ${S.quakes.length.toLocaleString()} events · up to ${fmtUTCShort(S.cursor)}`;
  } else {
    st.textContent = S.qMeta && S.qMeta.error ? 'USGS: ' + NOT_CONNECTED : (S.qMeta ? 'No events match these filters' : 'loading USGS…');
  }
}

function project1(u, r){
  const [a0,a1,a2,b0,b1,b2,c0,c1,c2] = M;
  return [ CX + (a0*u[0]+a1*u[1]+a2*u[2]) * SC * r,
           CY - (b0*u[0]+b1*u[1]+b2*u[2]) * SC * r,
           c0*u[0]+c1*u[1]+c2*u[2] ];
}

function visibleWindow(){
  const span = Math.max(1, S.tMax - S.tMin);
  const lo = S.trail === 'recent' ? S.cursor - span*0.1 : -Infinity;
  return [lo, S.cursor, span];
}

function drawQuakes(){
  const [a0,a1,a2,b0,b1,b2,c0,c1,c2] = M;
  const [lo, hi, span] = visibleWindow();
  const recent = span * 0.03;
  const qs = S.quakes;
  const byColor = new Map();
  const back = [], front = [];
  let shown = 0;
  const many = qs.length > 1500;
  const pins = (S.xray && S.pins) ? new Path2D() : null;
  const glow = new Path2D();

  for(let i=0; i<qs.length; i++){
    const q = qs[i];
    if(q.time > hi || q.time < lo) continue;
    shown++;
    const x = S.qx[i], y = S.qy[i], z = S.qz[i];
    const r = hyporad(q.depth);
    const d = c0*x + c1*y + c2*z;
    if(!S.xray && d < 0) continue;
    const ux = a0*x + a1*y + a2*z, uy = b0*x + b1*y + b2*z;
    const px = CX + ux*SC*r, py = CY - uy*SC*r;
    if(px < -20 || py < -20 || px > W+20 || py > H+20) continue;
    const rad = quakeRadiusPx(q.mag);
    if(pins && r < 1 && (!many || (q.mag||0) >= 4.5) && d >= 0){
      pins.moveTo(CX + ux*SC, CY - uy*SC); pins.lineTo(px, py);
    }
    (d < 0 ? back : front).push(i);
    q._px = px; q._py = py; q._r = rad; q._d = d;
    if(hi - q.time < recent && S.playing){ glow.moveTo(px + rad*2.6, py); glow.arc(px, py, rad*2.6, 0, Math.PI*2); }
  }
  const paint = (list, alpha) => {
    byColor.clear();
    for(const i of list){
      const q = qs[i], col = quakeColor(q);
      let P = byColor.get(col); if(!P){ P = new Path2D(); byColor.set(col, P); }
      P.moveTo(q._px + q._r, q._py); P.arc(q._px, q._py, q._r, 0, Math.PI*2);
      hit.kind.push('quake'); hit.i.push(i); hit.x.push(q._px); hit.y.push(q._py); hit.r.push(q._r);
    }
    ctx.globalAlpha = alpha;
    for(const [col, P] of byColor){ ctx.fillStyle = col; ctx.fill(P); }
    ctx.globalAlpha = 1;
  };
  if(back.length) paint(back, 0.35);
  if(pins){ ctx.strokeStyle = 'rgba(244,246,255,0.28)'; ctx.lineWidth = 0.7; ctx.stroke(pins); }
  paint(front, 0.88);
  if(S.playing){ ctx.fillStyle = 'rgba(255,46,209,0.22)'; ctx.fill(glow); }
  return shown;
}

function drawVolcanoes(){
  const V = S.data.volcanoes;
  const P = new Path2D(), Pb = new Path2D();
  const s = Math.max(2.6, 2.6*Math.min(2, Math.sqrt(S.zoom)));
  for(let i=0; i<V.list.length; i++){
    const [x, y, d] = project1(V.u[i], 1);
    if(d < 0 && !S.xray) continue;
    if(x < -10 || y < -10 || x > W+10 || y > H+10) continue;
    const T = d < 0 ? Pb : P;
    T.moveTo(x, y - s); T.lineTo(x + s*0.9, y + s*0.7); T.lineTo(x - s*0.9, y + s*0.7); T.closePath();
    if(d >= 0){ hit.kind.push('volcano'); hit.i.push(i); hit.x.push(x); hit.y.push(y); hit.r.push(s); }
  }
  ctx.globalAlpha = 0.25; ctx.fillStyle = '#FF9F1C'; ctx.fill(Pb);
  ctx.globalAlpha = 1; ctx.fill(P);
  ctx.strokeStyle = 'rgba(5,3,12,0.8)'; ctx.lineWidth = 0.6; ctx.stroke(P);
}

function drawKC(){
  const [x, y, d] = project1(unit(KC.lon, KC.lat), 1);
  if(d < 0) return;
  ctx.fillStyle = '#39FF88'; ctx.strokeStyle = '#05030C'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.font = '600 10px "IBM Plex Mono", monospace'; ctx.textAlign = 'left';
  ctx.fillStyle = '#39FF88'; ctx.fillText('KC', x + 6, y - 5);
}

function drawSelection(){
  const sel = S.selected; if(!sel) return;
  if(sel.kind === 'quake'){
    const q = S.quakes[sel.i]; if(!q) return;
    const u = [S.qx[sel.i], S.qy[sel.i], S.qz[sel.i]];
    const [ex, ey, d] = project1(u, 1);
    const [hx, hy] = project1(u, hyporad(q.depth));
    if(!S.xray && d < 0) return;
    if(S.xray){
      ctx.strokeStyle = '#F4F6FF'; ctx.lineWidth = 1.4; ctx.setLineDash([4,3]);
      ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(hx, hy); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(244,246,255,0.8)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(ex-5, ey); ctx.lineTo(ex+5, ey); ctx.moveTo(ex, ey-5); ctx.lineTo(ex, ey+5); ctx.stroke();
    }
    const r = quakeRadiusPx(q.mag) + 5;
    ctx.strokeStyle = '#F4F6FF'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(hx, hy, r, 0, Math.PI*2); ctx.stroke();
    ctx.font = '600 11px "IBM Plex Mono", monospace'; ctx.fillStyle = '#F4F6FF'; ctx.textAlign = 'left';
    ctx.fillText(`M${num(q.mag,1)} · ${num(q.depth,0)} km`, hx + r + 4, hy + 4);
  } else if(sel.kind === 'volcano' && S.data.volcanoes){
    const [x, y, d] = project1(S.data.volcanoes.u[sel.i], 1);
    if(d < 0) return;
    ctx.strokeStyle = '#F4F6FF'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI*2); ctx.stroke();
  }
}

/* ---------------- smooth fly-to ---------------- */
let tween = null;
function flyTo(lon, lat, zoom){
  let dl = ((lon - S.lon0 + 540) % 360) - 180;
  tween = { t0: performance.now(), dur: 650, lon0: S.lon0, lat0: S.lat0, z0: S.zoom, dl, dlat: lat - S.lat0, dz: (zoom || S.zoom) - S.zoom };
  requestDraw();
}
function tweenStep(){
  if(!tween) return;
  const t = Math.min(1, (performance.now() - tween.t0) / tween.dur);
  const e = t < 0.5 ? 2*t*t : 1 - Math.pow(-2*t + 2, 2)/2;
  S.lon0 = tween.lon0 + tween.dl*e; S.lat0 = tween.lat0 + tween.dlat*e; S.zoom = tween.z0 + tween.dz*e;
  if(t >= 1) tween = null;
}

/* =========================================================================
   INTERACTION: drag to spin, pinch / wheel to zoom, tap to inspect
   ========================================================================= */
const ptrs = new Map();
let gesture = null;
canvas.addEventListener('pointerdown', e=>{
  canvas.setPointerCapture(e.pointerId);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  tween = null;
  if(ptrs.size === 1) gesture = { x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: 0 };
  else gesture = gesture ? Object.assign(gesture, { moved: 99 }) : { moved: 99 };
});
canvas.addEventListener('pointermove', e=>{
  const p = ptrs.get(e.pointerId); if(!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y;
  if(ptrs.size === 1){
    const k = 57.2958 / (Math.min(W, H) * 0.43 * S.zoom);
    S.lon0 = ((S.lon0 - dx*k + 540) % 360) - 180;
    S.lat0 = Math.max(-89, Math.min(89, S.lat0 + dy*k));
    if(gesture) gesture.moved += Math.abs(dx) + Math.abs(dy);
  } else if(ptrs.size === 2){
    const [a, b] = [...ptrs.values()];
    const before = Math.hypot(a.x - b.x, a.y - b.y);
    p.x = e.clientX; p.y = e.clientY;
    const [a2, b2] = [...ptrs.values()];
    const after = Math.hypot(a2.x - b2.x, a2.y - b2.y);
    if(before > 0) setZoom(S.zoom * after / before);
  }
  p.x = e.clientX; p.y = e.clientY;
  requestDraw();
});
function endPtr(e){
  if(!ptrs.has(e.pointerId)) return;
  ptrs.delete(e.pointerId);
  if(ptrs.size === 0 && gesture && gesture.moved < 8 && performance.now() - gesture.t0 < 500){
    const r = canvas.getBoundingClientRect();
    pick(e.clientX - r.left, e.clientY - r.top);
  }
  if(ptrs.size === 0) gesture = null;
}
canvas.addEventListener('pointerup', endPtr);
canvas.addEventListener('pointercancel', e=>{ ptrs.delete(e.pointerId); gesture = null; });
canvas.addEventListener('wheel', e=>{ e.preventDefault(); setZoom(S.zoom * Math.exp(-e.deltaY * 0.0015)); requestDraw(); }, { passive: false });

function setZoom(z){ S.zoom = Math.max(0.6, Math.min(14, z)); }

function pick(x, y){
  let best = -1, bd = Infinity;
  for(let k=0; k<hit.x.length; k++){
    const d = Math.hypot(hit.x[k] - x, hit.y[k] - y);
    const tol = Math.max(14, hit.r[k] + 6);
    // Prefer the later-drawn (front) item when distances tie
    if(d <= tol && d <= bd){ bd = d; best = k; }
  }
  if(best < 0){ S.selected = null; renderInspector(); requestDraw(); return; }
  S.selected = { kind: hit.kind[best], i: hit.i[best] };
  renderInspector();
  requestDraw();
}

$('ecZoomIn').addEventListener('click', ()=>{ setZoom(S.zoom * 1.4); requestDraw(); });
$('ecZoomOut').addEventListener('click', ()=>{ setZoom(S.zoom / 1.4); requestDraw(); });
$('ecHome').addEventListener('click', ()=> flyTo(KC.lon, KC.lat, 1.8));
$('ecFull').addEventListener('click', ()=>{
  const on = !document.body.classList.contains('ec-full');
  document.body.classList.toggle('ec-full', on);
  $('ecPanel').classList.toggle('is-full', on);
  $('ecFull').textContent = on ? '✕' : '⛶';
  $('ecFull').title = on ? 'Exit full screen' : 'Full screen';
  setTimeout(resize, 30);
});
if(window.ResizeObserver) new ResizeObserver(resize).observe($('ecGlobeWrap'));
window.addEventListener('resize', resize);

/* =========================================================================
   TIMELINE PLAYBACK
   ========================================================================= */
const scrub = $('ecScrub');
function syncScrub(){
  const span = Math.max(1, S.tMax - S.tMin);
  scrub.value = String(Math.round(1000 * (S.cursor - S.tMin) / span));
  $('ecCursorLabel').textContent = S.quakes.length ? fmtUTCShort(S.cursor) : '—';
}
function syncPlayBtn(){ $('ecPlay').textContent = S.playing ? '❚❚ PAUSE' : '▶ PLAY'; }
scrub.addEventListener('input', ()=>{
  S.playing = false; syncPlayBtn();
  S.cursor = S.tMin + (S.tMax - S.tMin) * (+scrub.value / 1000);
  syncScrub(); requestDraw(); renderStats();
});
scrub.addEventListener('change', renderStats);
$('ecPlay').addEventListener('click', ()=>{
  if(!S.quakes.length) return;
  if(S.playing){ S.playing = false; syncPlayBtn(); renderStats(); return; }
  if(S.cursor >= S.tMax) S.cursor = S.tMin;
  S.playing = true; lastTs = 0; syncPlayBtn(); requestDraw();
  statsTick();
});
function statsTick(){ if(!S.playing){ renderStats(); return; } renderStats(); setTimeout(statsTick, 700); }

function chipGroup(id, getter, setter){
  const box = $(id);
  const sync = ()=> box.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.v === String(getter())));
  box.querySelectorAll('.chip').forEach(c => c.addEventListener('click', ()=>{ setter(c.dataset.v); sync(); requestDraw(); }));
  sync();
}
chipGroup('ecSpeedChips', ()=>S.speedSec, v=>{ S.speedSec = +v; });
chipGroup('ecTrailChips', ()=>S.trail, v=>{ S.trail = v; renderStats(); });
chipGroup('ecModeChips', ()=>S.xray ? 'xray' : 'surface', v=>{ S.xray = v === 'xray'; renderLegend(); });
chipGroup('ecColorChips', ()=>S.colorMode, v=>{ S.colorMode = v; renderLegend(); });
chipGroup('ecExagChips', ()=>S.exag, v=>{ S.exag = +v; renderLegend(); });
$('ecPinsChip').addEventListener('click', ()=>{ S.pins = !S.pins; $('ecPinsChip').classList.toggle('active', S.pins); requestDraw(); });
$('ecPinsChip').classList.toggle('active', S.pins);

/* =========================================================================
   LAYERS
   ========================================================================= */
const LAYER_DEFS = [
  { key: 'quakes',    label: '🔴 Earthquakes' },
  { key: 'plates',    label: '🧩 Plate Boundaries' },
  { key: 'faults',    label: '〰️ Faults' },
  { key: 'volcanoes', label: '🌋 Volcanoes' },
  { key: 'borders',   label: '🗺 Borders' },
];
function layerError(key){
  if(key === 'quakes') return S.qMeta && S.qMeta.error;
  return S.dataErr[key];
}
function renderLayerChips(){
  const box = $('ecLayerChips');
  box.innerHTML = LAYER_DEFS.map(d=>{
    const on = S.layers[d.key], err = layerError(d.key);
    const loading = d.key === 'faults' && S.loading.faults;
    return `<button class="chip ${on ? 'active' : ''} ${err ? 'ec-chip-err' : ''}" data-layer="${d.key}">${on ? '☑' : '☐'} ${d.label}${err ? ' ⚠' : ''}${loading ? ' …' : ''}</button>`;
  }).join('');
  box.querySelectorAll('.chip').forEach(c => c.addEventListener('click', ()=>{
    const k = c.dataset.layer;
    S.layers[k] = !S.layers[k];
    if(k === 'faults' && S.layers.faults && !S.data.faults) loadLayer('faults');
    renderLayerChips(); renderLegend(); updateNotice(); requestDraw();
  }));
  const errs = LAYER_DEFS.filter(d => S.layers[d.key] && layerError(d.key));
  $('ecLayerErr').innerHTML = errs.map(d => `<div class="ec-nc">${esc(d.label.replace(/^\S+\s/, ''))}: ${NOT_CONNECTED}</div>`).join('');
}

const LAYER_FILES = { plates: 'data/earthcore/plates.json', faults: 'data/earthcore/faults.json',
                      borders: 'data/earthcore/borders.json', volcanoes: 'data/earthcore/volcanoes.json' };

async function loadLayer(key){
  if(key === 'faults') S.loading.faults = true;
  renderLayerChips();
  try{
    const r = await fetch(LAYER_FILES[key], { cache: 'no-cache' });
    if(r.status === 404) throw new Error('data file not built yet — the "Earth Core Layers" GitHub robot creates it');
    if(!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    if(key === 'plates'){
      const groupIdx = cls => PLATE_GROUP_KEYS.indexOf(plateGroup(cls, j.classes));
      j.layer = buildLineLayer(j.lines.map(l => l.p), i => Math.max(0, groupIdx(j.lines[i].c)));
    } else if(key === 'faults'){
      j.layer = buildLineLayer(j.faults.map(f => f.p));
    } else if(key === 'borders'){
      const all = [], cat = [];
      j.coast.forEach(p => { all.push(p); cat.push(0); });
      j.countries.forEach(p => { all.push(p); cat.push(1); });
      j.states.forEach(p => { all.push(p); cat.push(2); });
      j.layer = buildLineLayer(all, i => cat[i]);
    } else if(key === 'volcanoes'){
      if(!Array.isArray(j.volcanoes) || !j.volcanoes.length) throw new Error('file has no volcano records');
      j.list = j.volcanoes;
      j.u = j.list.map(v => unit(v.lon, v.lat));
    }
    S.data[key] = j; S.dataErr[key] = null;
  } catch(err){
    S.data[key] = null;
    S.dataErr[key] = (err && err.message) || 'failed to load';
  }
  if(key === 'faults') S.loading.faults = false;
  renderLayerChips(); renderSources(); updateNotice(); requestDraw();
}

/* =========================================================================
   USGS EARTHQUAKE QUERY
   ========================================================================= */
function buildQuery(){
  const p = new URLSearchParams();
  const f = S.f;
  let start, end;
  if(f.preset === 'custom'){
    if(!f.start) throw new Error('Pick a start date for the custom range.');
    start = new Date(f.start + 'T00:00:00Z');
    end = f.end ? new Date(new Date(f.end + 'T00:00:00Z').getTime() + 86400000) : new Date();
    if(!(end > start)) throw new Error('End date must be after the start date.');
  } else {
    end = new Date();
    start = new Date(end.getTime() - PRESETS[f.preset] * 3600000);
  }
  p.set('starttime', start.toISOString().slice(0,19));
  p.set('endtime', end.toISOString().slice(0,19));
  const add = (k, v) => { if(v !== '' && v != null && !isNaN(+v)) p.set(k, String(+v)); };
  add('minmagnitude', f.minMag); add('maxmagnitude', f.maxMag);
  add('mindepth', f.minDepth);   add('maxdepth', f.maxDepth);
  let regionNote = 'Global';
  if(f.region === 'kc'){ p.set('latitude', KC.lat); p.set('longitude', KC.lon); p.set('maxradiuskm', 1000); regionNote = 'Within 1,000 km of Kansas City'; }
  else if(f.region === 'us'){ p.set('minlatitude', 24.4); p.set('maxlatitude', 49.4); p.set('minlongitude', -125); p.set('maxlongitude', -66.9); regionNote = 'Lower 48 US bounding box'; }
  else if(f.region === 'view'){
    const lat = +S.lat0.toFixed(2), lon = +S.lon0.toFixed(2);
    p.set('latitude', lat); p.set('longitude', lon); p.set('maxradiuskm', 2500);
    regionNote = `Within 2,500 km of ${lat}, ${lon}`;
  }
  if(!f.nonQuake) p.set('eventtype', 'earthquake');
  return { p, start: start.getTime(), end: end.getTime(), regionNote };
}

let queryToken = 0;
async function loadQuakes(){
  readInputs();
  let q;
  try { q = buildQuery(); }
  catch(err){ $('ecQueryStatus').innerHTML = `<span style="color:var(--amber)">${esc(err.message)}</span>`; return; }
  const token = ++queryToken;
  S.playing = false; syncPlayBtn();
  $('ecQueryStatus').textContent = 'Asking USGS…';
  $('ecApply').disabled = true;
  const countUrl = USGS_BASE + 'count?format=geojson&' + q.p.toString();
  const qp = new URLSearchParams(q.p); qp.set('format', 'geojson'); qp.set('orderby', 'time'); qp.set('limit', String(USGS_MAX));
  const url = USGS_BASE + 'query?' + qp.toString();
  try{
    let total = null;
    try{
      const cr = await fetch(countUrl);
      if(cr.ok){ const cj = await cr.json(); total = typeof cj.count === 'number' ? cj.count : null; }
    } catch(_){ /* count is optional; the main query decides success */ }
    if(token !== queryToken) return;
    $('ecQueryStatus').textContent = total != null ? `Downloading ${total.toLocaleString()} events from USGS…` : 'Downloading from USGS…';
    const r = await fetch(url);
    if(!r.ok){
      let msg = 'HTTP ' + r.status;
      try{ const t = await r.text(); const m = t.match(/Error \d+:?\s*([^\n]+)/) || t.match(/\n([^\n]{10,200})\n/); if(m) msg += ' — ' + m[1].trim(); } catch(_){}
      throw new Error(msg);
    }
    const j = await r.json();
    if(token !== queryToken) return;
    const feats = Array.isArray(j.features) ? j.features : [];
    const list = [];
    for(const f of feats){
      const c = f.geometry && f.geometry.coordinates;
      if(!c || c.length < 2) continue;
      const pr = f.properties || {};
      list.push({ id: f.id, lon: +c[0], lat: +c[1], depth: c[2] == null ? 0 : +c[2], mag: pr.mag == null ? null : +pr.mag,
                  time: pr.time, raw: f });
    }
    list.sort((a, b) => a.time - b.time);
    setQuakes(list, q);
    S.qMeta = { url, countUrl, fetchedAt: Date.now(), count: list.length, total, capped: (total != null ? total > USGS_MAX : list.length >= USGS_MAX),
                regionNote: q.regionNote, error: null, generated: j.metadata && j.metadata.generated };
  } catch(err){
    if(token !== queryToken) return;
    setQuakes([], q);
    S.qMeta = { url, countUrl, fetchedAt: Date.now(), count: 0, error: (err && err.message) || 'request failed', regionNote: q.regionNote };
  }
  $('ecApply').disabled = false;
  renderQueryStatus(); renderLayerChips(); renderSources(); renderStats(); renderTop(); updateNotice();
  S.selected = null; renderInspector();
  requestDraw();
}

function setQuakes(list, q){
  S.quakes = list;
  const n = list.length;
  S.qx = new Float32Array(n); S.qy = new Float32Array(n); S.qz = new Float32Array(n);
  list.forEach((e, i) => { const u = unit(e.lon, e.lat); S.qx[i]=u[0]; S.qy[i]=u[1]; S.qz[i]=u[2]; });
  S.tMin = q.start; S.tMax = q.end; S.cursor = S.tMax;
  syncScrub();
}

function renderQueryStatus(){
  const m = S.qMeta, el = $('ecQueryStatus');
  if(!m) return;
  if(m.error){
    el.innerHTML = `<span class="ec-nc">EARTHQUAKES: ${NOT_CONNECTED}</span><br>USGS did not answer (${esc(m.error)}). Nothing has been drawn in its place.`;
    return;
  }
  let s = `<strong>${m.count.toLocaleString()}</strong> events loaded · ${esc(m.regionNote)} · fetched ${esc(fmtLocal(m.fetchedAt))}`;
  if(m.capped) s += `<br><span style="color:var(--amber)">USGS returns at most ${USGS_MAX.toLocaleString()} events per request${m.total ? ` (this filter matches ${m.total.toLocaleString()})` : ''}. Showing the newest ${USGS_MAX.toLocaleString()} — narrow the dates or raise the minimum magnitude to see the rest.</span>`;
  el.innerHTML = s;
}

/* ---------------- filter controls ---------------- */
function readInputs(){
  S.f.start = $('ecStart').value; S.f.end = $('ecEnd').value;
  S.f.minMag = $('ecMinMag').value; S.f.maxMag = $('ecMaxMag').value;
  S.f.minDepth = $('ecMinDepth').value; S.f.maxDepth = $('ecMaxDepth').value;
}
function initFilters(){
  $('ecMinMag').value = S.f.minMag;
  const today = new Date().toISOString().slice(0,10);
  $('ecEnd').value = today;
  $('ecStart').value = new Date(Date.now() - 7*86400000).toISOString().slice(0,10);
  $('ecStart').max = $('ecEnd').max = today;

  const tbox = $('ecTimeChips');
  tbox.innerHTML = Object.keys(PRESETS).map(k => `<button class="chip" data-v="${k}">${k}</button>`).join('') + '<button class="chip" data-v="custom">📅 Custom</button>';
  const syncT = ()=>{ tbox.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.v === S.f.preset)); $('ecCustomDates').hidden = S.f.preset !== 'custom'; };
  tbox.querySelectorAll('.chip').forEach(c => c.addEventListener('click', ()=>{ S.f.preset = c.dataset.v; syncT(); if(S.f.preset !== 'custom') loadQuakes(); }));
  syncT();

  const rbox = $('ecRegionChips');
  rbox.innerHTML = Object.entries(REGIONS).map(([k, r]) => `<button class="chip" data-v="${k}">${r.label}</button>`).join('');
  const syncR = ()=> rbox.querySelectorAll('.chip').forEach(c => c.classList.toggle('active', c.dataset.v === S.f.region));
  rbox.querySelectorAll('.chip').forEach(c => c.addEventListener('click', ()=>{
    S.f.region = c.dataset.v; syncR();
    if(S.f.region === 'kc') flyTo(KC.lon, KC.lat, 2.2);
    if(S.f.region === 'us') flyTo(-97, 38, 1.9);
    loadQuakes();
  }));
  syncR();

  const nq = $('ecNonQuakeChip');
  nq.addEventListener('click', ()=>{ S.f.nonQuake = !S.f.nonQuake; nq.classList.toggle('active', S.f.nonQuake); nq.textContent = (S.f.nonQuake ? '☑' : '☐') + ' Include non-earthquake events (quarry blasts, explosions…)'; });
  $('ecApply').addEventListener('click', loadQuakes);
}

/* =========================================================================
   PANELS: legend, inspector, stats, top list, sources, notices
   ========================================================================= */
function renderLegend(){
  const bands = S.colorMode === 'depth' ? DEPTH_BANDS : MAG_BANDS;
  const dot = c => `<span class="ec-dot" style="background:${c}"></span>`;
  let h = `<div class="ec-legend-row"><span class="status-label">${S.colorMode === 'depth' ? 'Depth mode' : 'Magnitude mode'}</span>${bands.map(b => `<span>${dot(b.color)}${b.label}</span>`).join('')}</div>`;
  h += `<div class="ec-legend-row"><span class="status-label">Size</span><span>bigger dot = bigger magnitude</span></div>`;
  if(S.layers.plates) h += `<div class="ec-legend-row"><span class="status-label">Plates</span>${PLATE_GROUP_KEYS.map(k => `<span><span class="ec-line" style="background:${PLATE_GROUPS[k].color}"></span>${PLATE_GROUPS[k].label}</span>`).join('')}</div>`;
  const other = [];
  if(S.layers.faults) other.push(`<span><span class="ec-line" style="background:#A855F7;height:2px"></span>Active fault</span>`);
  if(S.layers.volcanoes) other.push(`<span><span class="ec-tri"></span>Holocene volcano</span>`);
  other.push(`<span>${dot('#39FF88')}Kansas City</span>`);
  h += `<div class="ec-legend-row"><span class="status-label">Other</span>${other.join('')}</div>`;
  h += `<p class="field-hint" style="margin:0.4rem 0 0">${S.xray
      ? `X-RAY: each dot sits at its real depth below the surface. Depth is stretched ${S.exag}× so it's visible (700 km is only 11% of Earth's radius). Dashed rings = 100 / 300 / 700 km depth.${S.pins ? ' White pins join a dot to the spot on the surface above it.' : ''}`
      : 'SURFACE: each dot is drawn at its epicenter (the spot on the surface above it). Switch to X-RAY to see depth.'}</p>`;
  $('ecLegend').innerHTML = h;
}

function row(k, v){ return `<div class="status-row"><span class="status-label">${k}</span><span>${v}</span></div>`; }

function renderInspector(){
  const box = $('ecInspector');
  const sel = S.selected;
  if(!sel){ box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  if(sel.kind === 'quake'){
    const q = S.quakes[sel.i], pr = (q.raw && q.raw.properties) || {};
    const band = bandFor(DEPTH_BANDS, q.depth);
    const near = nearestPlateBoundary(q.lon, q.lat);
    box.innerHTML = `
      <div class="row" style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;">
        <div><div class="ec-big">M ${num(q.mag,1)} <span class="source-tag">${esc(pr.magType || '')}</span></div>
        <div>${esc(pr.place || 'Location name not given')}</div></div>
        <button class="icon-btn" id="ecInspClose" title="Close">✕</button>
      </div>
      <div style="margin:0.5rem 0;"><span class="badge info">MEASURED</span> <span class="source-tag">SOURCE: USGS ANSS ComCat · ${esc(pr.status || '')}</span></div>
      ${row('Time (UTC)', esc(fmtUTC(q.time)))}
      ${row('Your local time', esc(fmtLocal(q.time)))}
      ${row('Depth', `${num(q.depth,1)} km <span class="ec-dot" style="background:${band.color}"></span>${band.label}`)}
      ${row('Coordinates', `${num(q.lat,3)}, ${num(q.lon,3)}`)}
      ${row('Event type', esc(pr.type || '—') + (pr.type && pr.type !== 'earthquake' ? ' <span class="badge watch">USGS-classified</span>' : ''))}
      ${row('Review status', esc(pr.status || '—'))}
      ${pr.felt != null ? row('“Did You Feel It?” reports', esc(pr.felt)) : ''}
      ${pr.alert ? row('PAGER alert', esc(pr.alert)) : ''}
      ${pr.tsunami ? row('Tsunami flag', 'yes (USGS flag — check NOAA/tsunami.gov for actual warnings)') : ''}
      ${row('Network · Event ID', `${esc(pr.net || '—')} · ${esc(q.id)}`)}
      ${near ? `<div style="margin-top:0.6rem;"><span class="badge ec-calc">CALCULATED</span> <span class="source-tag">from PB2002 plate map</span></div>
        <p style="margin:0.35rem 0 0;font-size:0.88rem;">Nearest mapped plate boundary: <strong>${esc(near.name)}</strong> (${esc(near.cls)}), about <strong>${Math.round(near.km).toLocaleString()} km</strong> from the epicenter.</p>
        <p class="field-hint">Distance is geometry only. Being near a boundary is not, by itself, evidence of what caused this event.</p>` : ''}
      <div class="btn-row" style="margin-top:0.7rem;">
        ${pr.url ? `<a class="btn" href="${esc(pr.url)}" target="_blank" rel="noopener">Open on USGS ↗</a>` : ''}
        <button class="btn ghost" id="ecCopyRec">Copy source record</button>
        <button class="btn ghost" id="ecFlyRec">Center</button>
      </div>`;
    $('ecCopyRec').addEventListener('click', ()=> copyText(JSON.stringify(q.raw, null, 2), $('ecCopyRec')));
    $('ecFlyRec').addEventListener('click', ()=> flyTo(q.lon, q.lat, Math.max(S.zoom, 2.5)));
  } else {
    const v = S.data.volcanoes.list[sel.i], src = S.data.volcanoes.source || {};
    box.innerHTML = `
      <div class="row" style="display:flex;justify-content:space-between;align-items:flex-start;gap:0.5rem;">
        <div><div class="ec-big">🌋 ${esc(v.n || 'Unnamed volcano')}</div><div>${esc(v.c || '')}</div></div>
        <button class="icon-btn" id="ecInspClose" title="Close">✕</button>
      </div>
      <div style="margin:0.5rem 0;"><span class="badge normal">DOCUMENTED</span> <span class="source-tag">SOURCE: ${esc(src.name || 'Smithsonian GVP')}</span></div>
      ${row('Type', esc(v.t || '—'))}
      ${row('Last known eruption', esc(v.e || '—'))}
      ${row('Elevation', v.z != null ? esc(v.z) + ' m' : '—')}
      ${row('Tectonic setting', esc(v.s || '—'))}
      ${row('Coordinates', `${num(v.lat,3)}, ${num(v.lon,3)}`)}
      ${row('GVP volcano number', esc(v.id || '—'))}
      <div class="btn-row" style="margin-top:0.7rem;">
        ${v.id ? `<a class="btn" href="https://volcano.si.edu/volcano.cfm?vn=${encodeURIComponent(v.id)}" target="_blank" rel="noopener">Open on Smithsonian GVP ↗</a>` : ''}
      </div>`;
  }
  $('ecInspClose').addEventListener('click', ()=>{ S.selected = null; renderInspector(); requestDraw(); });
}

function copyText(t, btn){
  const done = ok => { btn.textContent = ok ? 'Copied ✓' : 'Copy failed'; setTimeout(()=> btn.textContent = 'Copy source record', 1600); };
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(()=>done(true), ()=>done(false));
  else done(false);
}

// Great-circle distance from a point to the nearest PB2002 boundary segment.
function nearestPlateBoundary(lon, lat){
  const D = S.data.plates; if(!D) return null;
  const L = D.layer, P = unit(lon, lat), xyz = L.xyz;
  let bestAng = Infinity, bestLine = -1;
  for(let li=0; li<L.starts.length-1; li++){
    for(let j=L.starts[li]; j<L.starts[li+1]-1; j++){
      const a = j*3, b = (j+1)*3;
      const A = [xyz[a], xyz[a+1], xyz[a+2]], B = [xyz[b], xyz[b+1], xyz[b+2]];
      let ang = Math.acos(Math.max(-1, Math.min(1, P[0]*A[0]+P[1]*A[1]+P[2]*A[2])));
      const angB = Math.acos(Math.max(-1, Math.min(1, P[0]*B[0]+P[1]*B[1]+P[2]*B[2])));
      if(angB < ang) ang = angB;
      // perpendicular foot on the great circle through A and B
      let n = [A[1]*B[2]-A[2]*B[1], A[2]*B[0]-A[0]*B[2], A[0]*B[1]-A[1]*B[0]];
      const nl = Math.hypot(n[0], n[1], n[2]);
      if(nl > 1e-9){
        n = [n[0]/nl, n[1]/nl, n[2]/nl];
        const pn = P[0]*n[0]+P[1]*n[1]+P[2]*n[2];
        const F = [P[0]-pn*n[0], P[1]-pn*n[1], P[2]-pn*n[2]];
        const s1 = (A[1]*F[2]-A[2]*F[1])*n[0] + (A[2]*F[0]-A[0]*F[2])*n[1] + (A[0]*F[1]-A[1]*F[0])*n[2];
        const s2 = (F[1]*B[2]-F[2]*B[1])*n[0] + (F[2]*B[0]-F[0]*B[2])*n[1] + (F[0]*B[1]-F[1]*B[0])*n[2];
        if(s1 >= 0 && s2 >= 0){ const g = Math.asin(Math.min(1, Math.abs(pn))); if(g < ang) ang = g; }
      }
      if(ang < bestAng){ bestAng = ang; bestLine = li; }
    }
  }
  if(bestLine < 0) return null;
  const rec = D.lines[L.src[bestLine]];
  const cls = (D.classes && D.classes[rec.c]) ? D.classes[rec.c][0] : rec.c;
  return { km: bestAng * EARTH_R_KM, name: rec.b, cls };
}

function renderStats(){
  const box = $('ecDepthStats');
  if(!S.quakes.length){ box.innerHTML = `<div class="empty-state">${S.qMeta && S.qMeta.error ? 'EARTHQUAKES: ' + NOT_CONNECTED : 'No events loaded.'}</div>`; return; }
  const [lo, hi] = visibleWindow();
  const counts = DEPTH_BANDS.map(()=>0);
  let n = 0;
  for(const q of S.quakes){
    if(q.time > hi || q.time < lo) continue;
    n++; counts[DEPTH_BANDS.indexOf(bandFor(DEPTH_BANDS, q.depth))]++;
  }
  const max = Math.max(1, ...counts);
  box.innerHTML = `<p class="field-hint" style="margin-top:0">${n.toLocaleString()} events shown on the globe right now (${S.trail === 'recent' ? 'recent window' : 'everything up to the timeline marker'}).</p>` +
    DEPTH_BANDS.map((b, i) => `<div class="ec-bar"><span class="ec-bar-label">${b.label}</span><span class="ec-bar-track"><span style="width:${(100*counts[i]/max).toFixed(1)}%;background:${b.color}"></span></span><span class="ec-bar-n">${counts[i].toLocaleString()}</span></div>`).join('') +
    `<p class="source-tag" style="margin:0.5rem 0 0">SOURCE: USGS depths as reported (km below sea level). Counted here in your browser.</p>`;
}

function renderTop(){
  const box = $('ecTopList');
  if(!S.quakes.length){ box.innerHTML = `<div class="empty-state">${S.qMeta && S.qMeta.error ? 'EARTHQUAKES: ' + NOT_CONNECTED : 'No events loaded.'}</div>`; return; }
  const idx = S.quakes.map((q, i) => i).filter(i => S.quakes[i].mag != null).sort((a, b) => S.quakes[b].mag - S.quakes[a].mag).slice(0, 8);
  box.innerHTML = idx.map(i=>{
    const q = S.quakes[i], pr = q.raw.properties || {};
    const band = bandFor(DEPTH_BANDS, q.depth);
    return `<div class="list-item ec-top" data-i="${i}">
      <div class="row"><strong>M ${num(q.mag,1)}</strong><span class="timestamp">${esc(fmtUTCShort(q.time))}</span></div>
      <div class="desc">${esc(pr.place || q.id)}</div>
      <div class="meta"><span class="ec-dot" style="background:${band.color}"></span><span class="timestamp">${num(q.depth,1)} km deep</span></div>
    </div>`;
  }).join('');
  box.querySelectorAll('.ec-top').forEach(elm => elm.addEventListener('click', ()=>{
    const i = +elm.dataset.i, q = S.quakes[i];
    S.cursor = S.tMax; S.playing = false; syncPlayBtn(); syncScrub();
    S.selected = { kind: 'quake', i };
    renderInspector(); renderStats();
    flyTo(q.lon, q.lat, Math.max(S.zoom, 2.5));
    $('ecPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));
}

function sourceRow(ok, title, body){
  return `<div class="status-row" style="display:block;"><div><span class="status-dot ${ok ? 'ok' : 'err'}"></span><strong>${title}</strong></div><div class="field-hint" style="margin-top:0.2rem;">${body}</div></div>`;
}
function renderSources(){
  const parts = [];
  const m = S.qMeta;
  if(!m) parts.push(sourceRow(true, 'Earthquakes — USGS FDSN event API', 'loading…'));
  else if(m.error) parts.push(sourceRow(false, 'Earthquakes — USGS FDSN event API', `<span class="ec-nc">${NOT_CONNECTED}</span> (${esc(m.error)}). <a href="${esc(m.url)}" target="_blank" rel="noopener">Try the request yourself ↗</a>`));
  else parts.push(sourceRow(true, 'Earthquakes — USGS FDSN event API (ANSS ComCat)', `${m.count.toLocaleString()} events · live, read directly by your browser at ${esc(fmtLocal(m.fetchedAt))}. <a href="${esc(m.url)}" target="_blank" rel="noopener">Raw data for this view ↗</a> · Public domain (USGS).`));
  for(const [key, label] of [['plates', 'Plate boundaries'], ['faults', 'Active faults'], ['volcanoes', 'Volcanoes'], ['borders', 'Borders & coastlines']]){
    const d = S.data[key], err = S.dataErr[key];
    if(err) parts.push(sourceRow(false, label, `<span class="ec-nc">${NOT_CONNECTED}</span> (${esc(err)}). Nothing is drawn for this layer.`));
    else if(!d) parts.push(sourceRow(true, label, key === 'faults' ? 'Loads when you switch the Faults layer on (about 1.3 MB).' : 'loading…'));
    else {
      const s = d.source || {};
      const count = d.count != null ? d.count.toLocaleString() + ' records · ' : '';
      parts.push(sourceRow(true, `${label} — ${esc(s.name || '')}`,
        `${count}copy saved in this repo on ${esc((s.retrieved_utc || '').slice(0,10))} · ${esc(s.license || '')}${s.citation ? ' · ' + esc(s.citation) : ''}${s.url ? ` · <a href="${esc(s.url)}" target="_blank" rel="noopener">source ↗</a>` : ''}${s.processing ? `<br>${esc(s.processing)}` : ''}`));
    }
  }
  $('ecSources').innerHTML = parts.join('');
}

function updateNotice(){
  const n = $('ecNotice');
  if(S.layers.quakes && S.qMeta && S.qMeta.error){
    n.hidden = false; n.innerHTML = `EARTHQUAKES<br>${NOT_CONNECTED}<br><span style="font-size:0.75rem;color:var(--text-dim)">USGS could not be reached. Other layers still work.</span>`;
  } else n.hidden = true;
}

/* =========================================================================
   INIT (lazy — runs the first time the EARTH tab is opened)
   ========================================================================= */
function init(){
  if(S.inited){ resize(); requestDraw(); return; }
  S.inited = true;
  buildGraticule();
  initFilters();
  renderLayerChips(); renderLegend(); renderSources(); renderStats(); renderTop();
  resize();
  loadLayer('borders'); loadLayer('plates'); loadLayer('volcanoes');
  loadQuakes();
}

document.querySelectorAll('.nav-btn').forEach(btn => btn.addEventListener('click', ()=>{
  if(btn.dataset.tab === 'earth') setTimeout(init, 0);
  else if(S.playing){ S.playing = false; syncPlayBtn(); }
  if(btn.dataset.tab !== 'earth' && document.body.classList.contains('ec-full')) $('ecFull').click();
}));
if(panel.classList.contains('active')) init();

// Exposed for debugging in the browser console only.
window.EarthCore = { state: S, reload: loadQuakes };
})();
