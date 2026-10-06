'use strict';
/* TESTV2RAY1 renderer: server list, pings, geo, connect, wireframe globe */

const $ = (s) => document.querySelector(s);
const state = {
  servers: [], activeId: null, geo: {}, pings: {},
  connected: false, connectedVia: null,
  autoSelect: false, autoConnect: false, watch: false,
  origin: null,
};

/* ---------------- globe ---------------- */
const canvas = $('#globe');
const g2 = canvas.getContext('2d');
const GLOBE = { cx: 0, cy: 0, r: 0, rot: -0.6, drag: false, lx: 0, hover: null };

function sizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  g2.setTransform(dpr, 0, 0, dpr, 0, 0);
  GLOBE.cx = r.width * 0.56;
  GLOBE.cy = r.height * 0.56;
  GLOBE.r = Math.min(r.width, r.height) * 0.40;
  drawGlobe();
}

// lon/lat -> screen; z > 0 means the point faces the viewer
function project(lon, lat) {
  const a = (lon * Math.PI) / 180 + GLOBE.rot;
  const b = (lat * Math.PI) / 180;
  const cb = Math.cos(b);
  return {
    x: GLOBE.cx + cb * Math.sin(a) * GLOBE.r,
    y: GLOBE.cy - Math.sin(b) * GLOBE.r,
    z: cb * Math.cos(a),
  };
}

// inverse orthographic — used to pick the country under the cursor
function unproject(x, y) {
  const dx = x - GLOBE.cx, dy = y - GLOBE.cy;
  const rho = Math.hypot(dx, dy);
  if (rho > GLOBE.r) return null;
  const c = 1 - (rho * rho) / (GLOBE.r * GLOBE.r);
  if (c < 0) return null;
  const lat = Math.asin(-dy / GLOBE.r) * 180 / Math.PI;
  const lon = (Math.atan2(dx, dy) - GLOBE.rot) * 180 / Math.PI;
  return { lon, lat, z: Math.sqrt(c) };
}

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > lat) !== (yj > lat)) && (lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}

function countryAt(lon, lat) {
  if (!window.EARTH_COUNTRIES) return null;
  for (const c of window.EARTH_COUNTRIES) {
    for (const ring of c.rings) if (inRing(lon, lat, ring)) return c;
  }
  return null;
}

function drawGlobe() {
  const { cx, cy, r } = GLOBE;
  if (!r) return;
  g2.clearRect(0, 0, canvas.width, canvas.height);

  // atmosphere
  const glow = g2.createRadialGradient(cx, cy, r * 0.92, cx, cy, r * 1.28);
  glow.addColorStop(0, 'rgba(92,225,230,0)');
  glow.addColorStop(0.55, 'rgba(92,225,230,0.09)');
  glow.addColorStop(1, 'rgba(92,225,230,0)');
  g2.fillStyle = glow;
  g2.beginPath(); g2.arc(cx, cy, r * 1.28, 0, Math.PI * 2); g2.fill();

  // ocean
  const sea = g2.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.1, cx, cy, r);
  sea.addColorStop(0, '#0e1417');
  sea.addColorStop(1, '#070a0b');
  g2.fillStyle = sea;
  g2.beginPath(); g2.arc(cx, cy, r, 0, Math.PI * 2); g2.fill();

  // graticule
  g2.strokeStyle = 'rgba(120,160,170,0.13)';
  g2.lineWidth = 1;
  g2.beginPath();
  for (let lat = -60; lat <= 60; lat += 30) {
    const p = project(0, lat);
    g2.moveTo(cx - r, p.y); g2.lineTo(cx + r, p.y);
  }
  for (let lon = -180; lon < 180; lon += 30) {
    const a = project(lon, -90), b = project(lon, 90);
    g2.moveTo(a.x, a.y); g2.lineTo(b.x, b.y);
  }
  g2.stroke();

  // real country boundaries (241 countries from Natural Earth 50m)
  const countries = window.EARTH_COUNTRIES || [];
  g2.lineWidth = 0.7;
  for (const c of countries) {
    const isHover = GLOBE.hover && GLOBE.hover.name === c.name;
    g2.strokeStyle = isHover ? 'rgba(200,240,74,0.95)' : 'rgba(190,225,232,0.42)';
    g2.beginPath();
    for (const ring of c.rings) {
      let started = false;
      for (let i = 0; i < ring.length; i++) {
        const p = project(ring[i][0], ring[i][1]);
        if (p.z < 0) { started = false; continue; }
        if (!started) { g2.moveTo(p.x, p.y); started = true; } else g2.lineTo(p.x, p.y);
      }
    }
    g2.stroke();
  }

  // limb
  g2.strokeStyle = 'rgba(150,200,210,0.35)';
  g2.lineWidth = 1.2;
  g2.beginPath(); g2.arc(cx, cy, r, 0, Math.PI * 2); g2.stroke();

  // node markers
  for (const s of state.servers) {
    const gg = state.geo[s.id];
    if (!gg || gg.lat == null) continue;
    const p = project(gg.lon, gg.lat);
    if (p.z < 0.02) continue;
    const active = s.id === state.activeId;
    const col = active ? '200,240,74' : '92,225,230';
    g2.fillStyle = `rgba(${col},${0.3 + p.z * 0.7})`;
    g2.beginPath(); g2.arc(p.x, p.y, active ? 3.6 : 2.1, 0, Math.PI * 2); g2.fill();
    if (active) {
      const ping = state.pings[s.id];
      const rad = 6 + (ping && ping.ms > 0 ? Math.min(ping.ms / 12, 26) : 12);
      g2.strokeStyle = 'rgba(200,240,74,0.5)';
      g2.lineWidth = 1;
      g2.beginPath(); g2.arc(p.x, p.y, rad, 0, Math.PI * 2); g2.stroke();
      g2.strokeStyle = 'rgba(200,240,74,0.16)';
      g2.beginPath(); g2.arc(p.x, p.y, rad * 1.9, 0, Math.PI * 2); g2.stroke();
      g2.fillStyle = 'rgba(235,240,242,0.95)';
      g2.font = '9px Consolas, monospace';
      g2.fillText(String(s.remark).slice(0, 20), p.x + 10, p.y - 7);
    }
  }

  // your egress IP - only meaningful when the tunnel is actually carrying
  // traffic. Showing it while merely connected mislabels it as the server.
  if (state.connected && state.origin && state.origin.lat != null) {
    const p = project(state.origin.lon, state.origin.lat);
    if (p.z > 0) {
      g2.strokeStyle = 'rgba(255,92,92,0.95)';
      g2.lineWidth = 1.2;
      g2.beginPath(); g2.arc(p.x, p.y, 4.5, 0, Math.PI * 2); g2.stroke();
      g2.beginPath();
      g2.moveTo(p.x - 9, p.y); g2.lineTo(p.x + 9, p.y);
      g2.moveTo(p.x, p.y - 9); g2.lineTo(p.x, p.y + 9);
      g2.stroke();
    }
  }

  if (GLOBE.hover) {
    g2.fillStyle = 'rgba(200,240,74,0.92)';
    g2.font = '10px Consolas, monospace';
    g2.fillText(GLOBE.hover.name.toUpperCase(), cx - r, cy - r - 10);
  }
}

(function globeLoop() {
  if (!GLOBE.drag) GLOBE.rot += 0.0016;
  drawGlobe();
  requestAnimationFrame(globeLoop);
})();

canvas.addEventListener('mousedown', (e) => { GLOBE.drag = true; GLOBE.lx = e.clientX; });
window.addEventListener('mouseup', () => { GLOBE.drag = false; });
window.addEventListener('mousemove', (e) => {
  if (GLOBE.drag) {
    GLOBE.rot += (e.clientX - GLOBE.lx) * 0.006;
    GLOBE.lx = e.clientX;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const ll = unproject(e.clientX - rect.left, e.clientY - rect.top);
  const hit = ll ? countryAt(ll.lon, ll.lat) : null;
  if ((hit ? hit.name : null) !== (GLOBE.hover && GLOBE.hover.name)) {
    GLOBE.hover = hit;
    canvas.title = hit ? hit.name : '';
  }
});
window.addEventListener('resize', sizeCanvas);
setTimeout(sizeCanvas, 30);

/* ---------------- list rendering ---------------- */
function pingClass(ms) {
  if (ms == null || ms < 0) return 'bad';
  if (ms < 120) return 'good';
  if (ms < 320) return 'mid';
  return 'bad';
}

function renderList() {
  const el = $('#serverList');
  $('#count').textContent = `${state.servers.length} NODE${state.servers.length === 1 ? '' : 'S'}`;
  if (!state.servers.length) {
    el.innerHTML = `<div class="empty">NO NODES IN ARRAY<br>Paste a vless:// link above and press IMPORT</div>`;
    return;
  }
  el.innerHTML = state.servers.map((s) => {
    const gg = state.geo[s.id] || {};
    const pg = state.pings[s.id];
    const ms = pg ? pg.ms : null;
    const loc = gg.location || 'resolving…';
    // Nodes the bundled core cannot run stay listed but are visibly marked, so
    // an xhttp link is never silently dropped from an import.
    const no = s.unsupported ? ' unsupported' : '';
    const badge = s.unsupported
      ? `<span class="badge bad" title="${esc(s.unsupportedReason || 'unsupported transport')}">${esc((s.network || '').toUpperCase())}</span>`
      : `<span class="badge">${esc((s.security || 'none').toUpperCase())}</span>`;
    return `<div class="node${no}${s.id === state.activeId ? ' active' : ''}" data-id="${s.id}"${s.unsupported ? ` title="${esc(s.unsupportedReason || '')}"` : ''}>
      <div class="flag">${gg.flag || '◎'}</div>
      <div class="meta">
        <div class="nm">${esc(s.remark)}</div>
        <div class="sub">${esc(loc)} · ${esc(s.address)}:${s.port} · ${esc(s.protocol)}${(s.network && s.network !== 'tcp') ? '/' + esc(s.network) : ''}${s.tls ? '/TLS' : ''}${s.unsupported ? ' · UNSUPPORTED ON THIS BUILD' : ''}</div>
      </div>
      <div class="right">
        ${badge}
        <span class="ping ${pingClass(ms)}">${ms == null ? '—' : ms < 0 ? 'FAIL' : ms + 'ms'}</span>
        <button class="kill" data-kill="${s.id}" title="Remove">✕</button>
      </div>
    </div>`;
  }).join('');
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderActive() {
  const s = state.servers.find((x) => x.id === state.activeId);
  if (!s) {
    $('#activeName').textContent = 'NO NODE SELECTED';
    $('#activeSub').textContent = 'Awaiting configuration data';
    $('#roPing').textContent = '—'; $('#roLoc').textContent = '—';
    $('#roProto').textContent = '—'; $('#roHost').textContent = '—';
    $('#coords').textContent = 'LAT — · LON — · NO SIGNAL';
    return;
  }
  const gg = state.geo[s.id] || {};
  const pg = state.pings[s.id];
  $('#activeName').textContent = s.remark.toUpperCase();
  $('#activeSub').textContent = gg.resolved
    ? `${gg.ip} — hosted in ${gg.location}. Traffic from this machine is routed through this node when CONNECT is armed.`
    : `${s.address}:${s.port} — resolving location…`;
  $('#roPing').textContent = pg ? (pg.ms < 0 ? 'UNREACHABLE' : pg.ms + ' ms') : '—';
  const locEl = $('#roLoc');
  locEl.textContent = gg.location || '—';
  // Long city names were being cut off mid-word; wrap them instead.
  locEl.classList.toggle('wrap', (gg.location || '').length > 18);
  $('#roProto').textContent = `${s.protocol.toUpperCase()}${(s.network && s.network !== 'tcp') ? ' / ' + s.network.toUpperCase() : ''}${s.tls ? ' / TLS' : ''}` + (s.unsupported ? ' · UNSUPPORTED' : '');
  $('#roProto').classList.toggle('warn', !!s.unsupported);
  $('#roHost').textContent = `${s.address}:${s.port}`;
  $('#roHost').classList.toggle('wrap', `${s.address}:${s.port}`.length > 18);
  $('#coords').textContent = gg.lat != null
    ? `LAT ${gg.lat.toFixed(3)} · LON ${gg.lon.toFixed(3)} · ${gg.isp || 'ISP N/A'}`
    : 'LAT — · LON — · NO SIGNAL';
}

$('#serverList').addEventListener('click', async (e) => {
  const kill = e.target.closest('[data-kill]');
  if (kill) {
    e.stopPropagation();
    const r = await api.remove(kill.dataset.kill);
    state.servers = r.servers; state.activeId = r.activeId;
    delete state.geo[kill.dataset.kill]; delete state.pings[kill.dataset.kill];
    renderList(); renderActive();
    return;
  }
  const node = e.target.closest('.node');
  if (!node) return;
  state.activeId = node.dataset.id;
  await api.setActive(state.activeId);
  renderList(); renderActive();
  if (!state.geo[state.activeId]) lookupOne(state.activeId);
});

/* ---------------- actions ---------------- */
async function lookupOne(id) {
  const s = state.servers.find((x) => x.id === id);
  if (!s) return;
  const g = await api.geo(s.address);
  state.geo[id] = g;
  if (id === state.activeId) renderActive();
  renderList();
}

async function lookupAll() {
  for (const s of state.servers) await lookupOne(s.id);
  drawGlobe();
}

async function pingAll() {
  $('#btnPingAll').disabled = true;
  for (const s of state.servers) {
    state.pings[s.id] = await api.pingOne(s.address, s.port);
    renderList(); renderActive();
  }
  $('#btnPingAll').disabled = false;
  if (state.autoSelect) selectBest();
  drawGlobe();
}

function selectBest() {
  const ranked = state.servers
    .filter((s) => state.pings[s.id] && state.pings[s.id].ms > 0)
    .sort((a, b) => state.pings[a.id].ms - state.pings[b.id].ms);
  if (!ranked.length) return;
  state.activeId = ranked[0].id;
  api.setActive(state.activeId);
  renderList(); renderActive();
}

$('#btnImportText').addEventListener('click', async () => {
  const txt = $('#txtLinks').value.trim();
  if (!txt) return;
  const r = await api.addText(txt);
  if (r.added) { $('#txtLinks').value = ''; await reload(); await lookupAll(); }
  if (r.errors && r.errors.length) alert('Some lines were skipped:\n\n' + r.errors.map((e) => `${e.line}\n  ${e.error}`).join('\n\n'));
});

$('#btnImportFile').addEventListener('click', async () => {
  const r = await api.addFile();
  if (r.canceled) return;
  await reload();
  if (r.added) await lookupAll();
  if (r.errors && r.errors.length) alert('Errors:\n' + r.errors.map((e) => e.error).join('\n'));
});

$('#btnSub').addEventListener('click', async () => {
  const url = prompt('Subscription URL:');
  if (!url) return;
  const r = await api.subFetch(url);
  await reload();
  if (r.added) await lookupAll();
  if (!r.added) alert('Nothing imported. ' + (r.errors[0] ? r.errors[0].error : ''));
});

$('#btnClear').addEventListener('click', async () => {
  if (!confirm('Remove all nodes?')) return;
  const r = await api.clear();
  state.servers = r.servers; state.activeId = r.activeId; state.geo = {}; state.pings = {};
  renderList(); renderActive(); drawGlobe();
});

$('#btnPingAll').addEventListener('click', pingAll);
$('#btnGeoAll').addEventListener('click', lookupAll);

// Bring the tunnel up, trying every node until one genuinely carries
// traffic. Used by the CONNECT button, by auto-connect on start and by the
// watch-and-reconnect loop, so all three behave identically.
async function connectTunnel(opts) {
  const o = opts || {};
  const quiet = !!o.quiet;
  const btn = $('#btnConnect');
  if (btn) { btn.disabled = true; btn.textContent = 'CONNECTING\u2026'; }
  if (!quiet) setNotice('Testing the tunnel before arming the system proxy\u2026');

  const order = [state.activeId, ...state.servers.map((s) => s.id)]
    .filter((id, i, a) => id && a.indexOf(id) === i);

  let last = null, r = null, used = null;
  for (const id of order) {
    const s = state.servers.find((x) => x.id === id);
    if (!quiet) setNotice(`Testing ${s ? s.remark : 'node'}\u2026`);
    r = await api.connect(true, id);
    if (r.ok) { used = id; break; }
    last = r;
    // A dead core or a held port will fail the same way for every node, so stop
    // trying. An unsupported transport is a property of that one node, so keep
    // going - the next node may be a perfectly good ws link.
    if (r.kind === 'core') break;
  }

  if (!r || !r.ok) {
    if (btn) { btn.disabled = false; btn.textContent = 'CONNECT'; }
    setChip('#chipCore', 'CORE', 'FAILED', false);
    setChip('#chipProxy', 'SYSTEM PROXY', 'OFF', false);
    setChip('#chipIp', 'IP', 'no tunnel', false);
    const why = last && last.error ? last.error : 'no node responded';
    setNotice(`Not connected - ${why}. System proxy left OFF, so your browsing is unaffected.`, 'bad');
    if (!quiet) refreshIp();
    return { ok: false, error: why };
  }

  if (used && used !== state.activeId) {
    state.activeId = used;
    await api.setActive(used);
    renderList(); renderActive();
  }

  state.connected = true;
  state.connectedVia = used;
  if (btn) { btn.disabled = false; btn.textContent = 'DISCONNECT'; btn.classList.add('live'); }
  setChip('#chipCore', 'CORE', 'RUNNING', true);
  setChip('#chipProxy', 'SYSTEM PROXY', `127.0.0.1:${r.proxy.httpPort}`, true);
  const where = r.egress ? [r.egress.city, r.egress.country].filter(Boolean).join(', ') : '';
  if (r.egress) {
    state.origin = { lat: null, lon: null };
    setChip('#chipIp', 'EGRESS', `${r.egress.ip} \u00b7 ${where}`, true);
  }
  const node = state.servers.find((x) => x.id === used);
  setNotice(`Connected via ${node ? node.remark : 'node'}${where ? ' - traffic leaves from ' + where : ''}.`, 'good');
  refreshIp();
  return { ok: true, egress: r.egress, nodeId: used };
}

async function disconnectTunnel(quiet) {
  await api.connect(false);
  state.connected = false;
  state.connectedVia = null;
  const btn = $('#btnConnect');
  if (btn) { btn.disabled = false; btn.textContent = 'CONNECT'; btn.classList.remove('live'); }
  setChip('#chipCore', 'CORE', 'OFFLINE', false);
  setChip('#chipProxy', 'SYSTEM PROXY', 'OFF', false);
  if (!quiet) setNotice('');
  refreshIp();
}

$('#btnConnect').addEventListener('click', async () => {
  if (!state.servers.length) { setNotice('Import a server first.', 'bad'); return; }
  if (state.connected) { await disconnectTunnel(false); state.watch = false; return; }
  await connectTunnel({});
});

$('#btnCoreOnly').addEventListener('click', async () => {
  const r = await api.coreStart();
  setChip('#chipCore', 'CORE', r.started ? 'RUNNING' : 'FAILED', !!r.started);
  if (!r.started && r.error) alert(r.error);
});

$('#btnLogs').addEventListener('click', async () => {
  const s = await api.coreStatus();
  $('#logBody').textContent = (s.log || []).join('\n') || 'no core output yet';
  $('#logModal').classList.add('open');
});
$('#btnCloseLogs').addEventListener('click', () => $('#logModal').classList.remove('open'));

$('#btnMenu').addEventListener('click', () => $('#menuDrawer').classList.toggle('open'));
$('#mPing').addEventListener('click', pingAll);
$('#mGeo').addEventListener('click', async () => { await lookupAll(); $('#menuDrawer').classList.remove('open'); });
$('#mAuto').addEventListener('click', (e) => {
  state.autoSelect = !state.autoSelect;
  e.target.textContent = (state.autoSelect ? 'AUTO-SELECT BEST: ON' : 'TOGGLE AUTO-SELECT BEST');
  if (state.autoSelect) selectBest();
});

/* ---------------- automation ---------------- */

// Auto-connect as soon as the app opens.
$('#mAutoConnect').addEventListener('click', (e) => {
  state.autoConnect = !state.autoConnect;
  e.target.textContent = 'AUTO-CONNECT ON START: ' + (state.autoConnect ? 'ON' : 'OFF');
  savePrefs();
  setNotice(state.autoConnect
    ? 'Auto-connect is ON - the tunnel will arm itself next time the app starts.'
    : 'Auto-connect is OFF.', state.autoConnect ? 'good' : '');
});

// Keep the tunnel up: detect a drop and move to another node automatically.
$('#mAutoWatch').addEventListener('click', (e) => {
  state.watch = !state.watch;
  e.target.textContent = 'WATCH & RECONNECT: ' + (state.watch ? 'ON' : 'OFF');
  savePrefs();
  setNotice(state.watch
    ? 'Watch is ON - if the tunnel drops it will switch nodes on its own.'
    : 'Watch is OFF.', state.watch ? 'good' : '');
  if (state.watch) startWatch();
});

function savePrefs() {
  try { localStorage.setItem('prefs', JSON.stringify({ autoConnect: state.autoConnect, watch: state.watch })); } catch (e) {}
}
function loadPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem('prefs') || '{}');
    state.autoConnect = !!p.autoConnect;
    state.watch = !!p.watch;
  } catch (e) { state.autoConnect = false; state.watch = false; }
}

// One supervision tick. Reconnecting is serialised through state.watching so a
// slow retry storm can never stack up.
let watchBusy = false;
async function watchTick() {
  if (!state.watch || watchBusy) return;
  if (!state.servers.length) return;
  if (state.connected) {
    const v = await api.connectVerify().catch(() => ({ ok: false }));
    if (v.ok) return;                       // still healthy
    setNotice('Tunnel dropped - moving to another node\u2026');
    await disconnectTunnel(true);
  }
  watchBusy = true;
  try { await connectTunnel({ quiet: true }); }
  finally { watchBusy = false; }
}

let watchTimer = null;
function startWatch() {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = setInterval(watchTick, 20000);
}

$('#mRefreshIp').addEventListener('click', refreshIp);

function setNotice(text, tone) {
  const el = $('#notice');
  if (!el) return;
  if (!text) { el.hidden = true; el.textContent = ''; return; }
  el.hidden = false;
  el.className = 'notice' + (tone ? ' ' + tone : '');
  el.innerHTML = `<span class="dot"></span><span>${esc(text)}</span>`;
}

function setChip(sel, label, val, on) {
  const el = $(sel);
  el.innerHTML = `${label} <b>${esc(val)}</b>`;
  el.classList.toggle('on', !!on);
  el.classList.toggle('warn', !on && val === 'FAILED');
}

async function refreshIp() {
  if (state.connected) {
    // Ask the main process: it probes through the tunnel itself and can tell
    // us the true endpoint IP, or that there is no working tunnel at all.
    try {
      const v = await api.connectVerify();
      if (v.ok && v.ip) {
        state.origin = { lat: null, lon: null };
        const where = [v.city, v.country].filter(Boolean).join(', ');
        setChip('#chipIp', 'EGRESS', `${v.ip} · ${where}`, true);
        return;
      }
      // Tunnel is not carrying traffic. Don't fight the watcher: when it is
            // on, it owns reconnection. Otherwise fall back to a clear FAILED state.
            if (state.watch) {
              setChip('#chipIp', 'IP', 'reconnecting\u2026', false);
              return;
            }
            state.connected = false;
            const btn = $('#btnConnect');
            if (btn) { btn.textContent = 'CONNECT'; btn.classList.remove('live'); }
            setChip('#chipCore', 'CORE', 'FAILED', false);
            setChip('#chipProxy', 'SYSTEM PROXY', 'OFF', false);
            setChip('#chipIp', 'IP', 'no tunnel', false);
            return;
    } catch (e) {
      setChip('#chipIp', 'IP', 'lookup failed', false);
      return;
    }
  }

  // Not connected: show this machine's real, direct egress address.
  try {
    const res = await fetch('https://ipwho.is/');
    const j = await res.json();
    const ip = j.ip;
    if (!ip) throw new Error('no ip');
    state.origin = { lat: j.latitude ?? null, lon: j.longitude ?? null };
    const where = [j.city, j.country].filter(Boolean).join(', ');
    setChip('#chipIp', 'YOUR IP', `${ip} · ${where}`, false);
    drawGlobe();
  } catch (e) {
    setChip('#chipIp', 'IP', 'lookup failed', false);
  }
}

async function reload() {
  const r = await api.serversList();
  state.servers = r.servers;
  state.activeId = r.activeId;
  renderList(); renderActive(); drawGlobe();
}

(async function init() {
  await reload();
  loadPrefs();
  // Reflect the saved automation state in the menu.
  $('#mAutoConnect').textContent = 'AUTO-CONNECT ON START: ' + (state.autoConnect ? 'ON' : 'OFF');
  $('#mAutoWatch').textContent = 'WATCH & RECONNECT: ' + (state.watch ? 'ON' : 'OFF');

  const ps = await api.proxyStatus();
  if (ps.enabled) setChip('#chipProxy', 'SYSTEM PROXY', ps.proxyServer || 'ON', true);
  await lookupAll();
  await refreshIp();
  setInterval(refreshIp, 30000);
  const bar = $('#trafficBar span');
  setInterval(() => { bar.style.width = (25 + Math.random() * 60) + '%'; }, 900);

  if (state.watch) startWatch();

  // Arm the tunnel by itself when asked, but only after the app has settled.
  if (state.autoConnect && state.servers.length) {
    setNotice('Auto-connect: bringing the tunnel up\u2026');
    setTimeout(() => connectTunnel({}), 1200);
  }
})();
