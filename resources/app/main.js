'use strict';
const fs = require('fs');
const path = require('path');
const { app, ipcMain, dialog, BrowserWindow, shell } = require('electron');
const { parseBulk, parseFile, b64decode, annotate } = require('./lib/parse');
const geo = require('./lib/geo');
const proxy = require('./lib/proxy');
const coreLib = require('./lib/core');
const verifyLib = require('./lib/verify');
const caps = require('./lib/capabilities');

const BASE = __dirname;
// Persisted state must live outside the app bundle: when packaged, BASE is
// inside app.asar (read-only). userData is per-user and writable on Win7.
// productName in package.json keeps this path stable across versions
const DATA = app.getPath('userData');
const STORE = path.join(DATA, 'store.json');
let win = null;
let runner = null;
let state = { servers: [], activeId: null, autoSelect: false, routing: 'global' };

function loadStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    state.servers = Array.isArray(raw.servers) ? raw.servers : [];
    // Re-annotate on load: the store may have been written by a newer 64-bit
    // build that accepted transports this core cannot run.
    for (const s of state.servers) if (s && typeof s === 'object') annotate(s);
    state.activeId = raw.activeId || (state.servers[0] && state.servers[0].id) || null;
    state.autoSelect = !!raw.autoSelect;
    state.routing = raw.routing || 'global';
  } catch (e) { /* fresh install */ }
}

function saveStore() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(state, null, 2));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 760, minWidth: 980, minHeight: 640,
    backgroundColor: '#050607',
    title: 'TESTV2RAY1',
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(BASE, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(BASE, 'renderer', 'index.html'));
}

// Only one copy may own 10808/10809 and the system-proxy settings at a time.
// Without this a second launch fights the first over both.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.whenReady().then(async () => {
    // Ask the real core which transports it accepts before anything is parsed,
    // so gating is based on the binary in front of us and not a version table.
    try {
      const cap = await new Promise((res) => {
        const t = setTimeout(() => res(null), 60000);   // never block startup for long
        try { res(caps.probe()); } catch (e) { res(null); }
        clearTimeout(t);
      });
      if (cap) console.log(`[core] Xray ${cap.version} (${cap.arch}) - unsupported transports: ${cap.unsupported.join(', ') || 'none'}`);
      else console.log('[core] capability probe did not finish; transports will not be gated');
    } catch (e) { /* non-fatal */ }

    loadStore();
    // A previous run that was killed rather than closed may still have Windows
    // routed at a dead port. Clear that before showing anything.
    try { const r = await proxy.reapStale(); if (r.reaped) console.log('[startup] ' + r.reason); }
    catch (e) { /* non-fatal */ }
    runner = new coreLib.CoreRunner(BASE, DATA);
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', async () => {
    try { await proxy.disable(); } catch (e) {}
    if (runner) runner.stop();
    // Make sure no core survives us holding 10808/10809, otherwise the next
    // launch cannot bind and reports a bogus "core failed to start".
    try { await coreLib.releasePorts(); } catch (e) {}
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    // Synchronous last resort: if the async cleanup above did not finish, do not
    // leave the machine pointing at a proxy nobody is listening on.
    try { require('child_process').execFileSync('reg.exe',
      ['add', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
       '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f'],
      { windowsHide: true }); } catch (e) {}
  });

  // Kill only the core we started. `taskkill /IM xray.exe` would also kill a
  // v2rayN or another Xray the user may be running on purpose.
  process.on('exit', () => {
    try {
      const p = runner && runner.proc;
      if (p && p.pid) require('child_process').execFileSync('taskkill.exe', ['/PID', String(p.pid), '/F'], { windowsHide: true });
    } catch (e) {}
  });
}

/* ---------------- servers ---------------- */

ipcMain.handle('servers:list', () => ({ servers: state.servers, activeId: state.activeId, routing: state.routing }));

ipcMain.handle('servers:addText', (_e, text) => {
  const { servers, errors } = parseBulk(text);
  for (const s of servers) if (!state.servers.some((x) => x.id === s.id)) state.servers.push(s);
  saveStore();
  return { added: servers.length, errors };
});

ipcMain.handle('servers:addFile', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'Config / Link list', extensions: ['txt', 'json', 'conf', 'list'] }] });
  if (r.canceled || !r.filePaths.length) return { added: 0, errors: [], canceled: true };
  const out = [];
  for (const fp of r.filePaths) {
    try {
      const { servers, errors } = parseFile(fp);
      out.push(...servers);
    } catch (e) { out.push({ __error: e.message, file: fp }); }
  }
  const good = out.filter((s) => !s.__error);
  for (const s of good) if (!state.servers.some((x) => x.id === s.id)) state.servers.push(s);
  saveStore();
  return { added: good.length, errors: out.filter((s) => s.__error) };
});

ipcMain.handle('servers:addJson', (_e, obj) => {
  // v2rayN / Clash style JSON arrays of outbound objects
  const list = Array.isArray(obj) ? obj : (obj && obj.outbounds) || [];
  const added = [];
  for (const o of list) {
    if (!o || o.tag === 'direct' || o.tag === 'block' || o.tag === 'proxy') continue;
    const s = fromOutbound(o);
    if (s) { state.servers.push(s); added.push(s); }
  }
  saveStore();
  return { added: added.length, servers: added };
});

function fromOutbound(o) {
  try {
    const st = o.stream || {};
    const base = {
      id: 'srv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7),
      remark: o.tag || 'server', protocol: o.protocol, network: st.network || 'tcp',
      tls: st.security === 'tls' || st.security === 'reality', security: st.security || 'none',
      host: '', path: '', sni: '',
      fingerprint: (st.tlsSettings && st.tlsSettings.fingerprint) || '',
      publicKey: (st.realitySettings && st.realitySettings.publicKey) || '',
      shortId: (st.realitySettings && st.realitySettings.shortId) || '',
      spiderX: (st.realitySettings && st.realitySettings.spiderX) || '',
    };
    if (st.wsSettings) { base.path = st.wsSettings.path || '/'; base.host = (st.wsSettings.headers && st.wsSettings.headers.Host) || ''; }
    if (st.grpcSettings) base.path = st.grpcSettings.serviceName || '';
    if (st.httpSettings) { base.path = st.httpSettings.path || '/'; base.host = (st.httpSettings.host || []).join(','); }
    if (st.tlsSettings) base.sni = st.tlsSettings.serverName || '';
    if (st.realitySettings) base.sni = st.realitySettings.serverName || base.sni;
    if (o.protocol === 'vless' || o.protocol === 'vmess') {
      const v = (o.settings.vnext || [])[0]; if (!v) return null;
      const u = (v.users || [])[0]; if (!u) return null;
      Object.assign(base, { address: v.address, port: v.port, uuid: u.id, flow: u.flow || '', alterId: u.alterId || 0, security: u.security || 'auto' });
    } else if (o.protocol === 'trojan') {
      const v = (o.settings.servers || [])[0]; if (!v) return null;
      Object.assign(base, { address: v.address, port: v.port, password: v.password });
    } else if (o.protocol === 'shadowsocks') {
      const v = (o.settings.servers || [])[0]; if (!v) return null;
      Object.assign(base, { address: v.address, port: v.port, method: v.method, password: v.password });
    } else return null;
    return annotate(base);
  } catch (e) { return null; }
}

ipcMain.handle('servers:update', (_e, id, patch) => {
  const s = state.servers.find((x) => x.id === id);
  if (s) Object.assign(s, patch);
  saveStore();
  return s || null;
});

ipcMain.handle('servers:remove', (_e, id) => {
  state.servers = state.servers.filter((x) => x.id !== id);
  if (state.activeId === id) state.activeId = state.servers[0] ? state.servers[0].id : null;
  saveStore();
  return { servers: state.servers, activeId: state.activeId };
});

ipcMain.handle('servers:setActive', (_e, id) => {
  state.activeId = id;
  saveStore();
  return id;
});

ipcMain.handle('servers:clear', () => {
  state.servers = []; state.activeId = null; saveStore();
  return { servers: [], activeId: null };
});

/* ---------------- geo / ping ---------------- */

ipcMain.handle('geo:lookup', async (_e, host) => {
  const g = await geo.lookupGeo(host);
  return { ...g, flag: geo.flagEmoji(g.countryCode), location: geo.locationLine(g) };
});

ipcMain.handle('geo:lookupAll', async () => {
  const out = {};
  for (const s of state.servers) {
    const g = await geo.lookupGeo(s.address);
    out[s.id] = { ...g, flag: geo.flagEmoji(g.countryCode), location: geo.locationLine(g) };
  }
  return out;
});

ipcMain.handle('ping:one', async (_e, host, port) => geo.tcpPing(host, parseInt(port, 10) || 443, 6000));
ipcMain.handle('ping:all', async () => {
  const results = {};
  for (const s of state.servers) {
    results[s.id] = await geo.tcpPing(s.address, s.port, 6000);
  }
  return results;
});

ipcMain.handle('subscription:fetch', async (_e, url) => {
  const text = await geo.getText(url, 15000);
  if (!text) return { added: 0, errors: [{ line: url, error: 'fetch failed or empty response' }] };
  const { servers, errors } = parseBulk(b64decode(text.replace(/\s+/g, '')) || text);
  for (const s of servers) state.servers.push(s);
  saveStore();
  return { added: servers.length, errors };
});

/* ---------------- core + proxy ---------------- */

ipcMain.handle('core:start', async () => {
  if (!coreLib.isCorePresent(BASE)) return { started: false, error: 'core/xray.exe is missing' };
  try { return await runner.start(state.servers, state.activeId); }
  catch (e) { return { started: false, error: e.message, log: runner.getLog() }; }
});

ipcMain.handle('core:stop', () => { runner.stop(); return { started: false }; });
ipcMain.handle('core:status', () => ({ running: runner.isRunning(), log: runner.getLog(), ports: { http: coreLib.HTTP_PORT, socks: coreLib.SOCKS_PORT } }));

ipcMain.handle('proxy:enable', async () => { try { return await proxy.enable(); } catch (e) { return { enabled: false, error: e.message }; } });
ipcMain.handle('proxy:disable', async () => { try { return await proxy.disable(); } catch (e) { return { enabled: false, error: e.message }; } });
ipcMain.handle('proxy:status', async () => { try { return await proxy.status(); } catch (e) { return { enabled: false, error: e.message }; } });

ipcMain.handle('connect:toggle', async (_e, want, nodeId) => {
  if (want) {
    const targetId = nodeId || state.activeId;
    const node = state.servers.find((s) => s.id === targetId);
    if (!node) return { ok: false, kind: 'core', error: 'No node selected.' };
    // Build the outbound here so an unusable transport is reported as such,
    // rather than as the core's opaque "unknown transport protocol".
    try { coreLib.buildOutbound(node); }
    catch (e) { return { ok: false, kind: 'transport', error: e.message }; }

    const started = await runner.start(state.servers, targetId);
    if (!started.started) return { ok: false, kind: 'core', error: started.error || 'core failed to start' };

    // Only arm the system proxy once the core is confirmed accepting
    // connections. Arming it against a dead port blacks out the whole
    // machine's browsing with no obvious cause.
    const portUp = await verifyLib.probePort();
    if (!portUp) {
      runner.stop();
      return { ok: false, error: 'Core did not open 127.0.0.1:' + coreLib.HTTP_PORT + ' - system proxy left untouched.' };
    }

    const p = await proxy.enable();

    // Give the tunnel a moment, then prove traffic really is being routed.
    await new Promise((r) => setTimeout(r, 1200));
    const check = await verifyLib.verify();

    if (!check.ok) {
      // Never leave a half-working proxy armed: it would leave the user with
      // no internet and no indication why.
      await proxy.disable();
      runner.stop();
      return { ok: false, error: check.reason, kind: check.kind, detail: check.detail || null, core: started, proxy: p };
    }

    return { ok: true, core: started, proxy: p, egress: check };
  }
  await proxy.disable();
  runner.stop();
  return { ok: true };
});

// Live verdict on the tunnel, used by the UI status chips.
ipcMain.handle('connect:verify', async () => {
  const ps = await proxy.status();
  const coreRunning = runner.isRunning();
  if (!coreRunning && !ps.enabled) {
    return { ok: false, kind: 'off', reason: 'Not connected.' };
  }
  const check = await verifyLib.verify();
  return { ...check, coreRunning, proxyEnabled: ps.enabled };
});

ipcMain.handle('shell:open', (_e, url) => { shell.openExternal(url); return true; });

// So the UI can show which core it is actually running on.
ipcMain.handle('core:info', () => {
  const info = caps.coreVersion(caps.coreDir());
  return { ...info, gated: caps.isReady() };
});
