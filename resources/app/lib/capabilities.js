'use strict';
// What the bundled core can run, detected from the actual binary rather than
// assumed from a version number.
//
// The Win7 build hard-coded a blocklist because Xray 1.8.0 genuinely lacked
// xhttp and httpupgrade. This build ships a current amd64 core, so those gates
// would be wrong. Instead the app probes the real core once at startup
// (`probe()` below) and only refuses a transport the core actually rejects.
//
// Verified against the bundled core with `xray run -test`; see compat-probe.js.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Everything the app might ever emit. Probed, not assumed.
const CANDIDATES = ['tcp', 'ws', 'grpc', 'h2', 'http', 'httpupgrade', 'xhttp', 'kcp', 'quic'];

let cache = null;   // Set<string> of unsupported transports, once probed

function coreDir() {
  const packaged = path.join(process.resourcesPath || '', 'core');
  if (process.resourcesPath && fs.existsSync(path.join(packaged, 'xray.exe'))) return packaged;
  return path.join(__dirname, '..', '..', 'core');
}

function coreVersion(dir) {
  try {
    const r = spawnSync(path.join(dir, 'xray.exe'), ['version'], { encoding: 'utf8', cwd: dir, timeout: 15000 });
    const line = String(r.stdout || '').split(/\r?\n/)[0] || '';
    const v = line.match(/Xray\s+([\d.]+)/);
    const arch = line.match(/windows\/(\w+)/);
    return { version: v ? v[1] : 'unknown', arch: arch ? arch[1] : 'unknown', raw: line.trim() };
  } catch (e) { return { version: 'unknown', arch: 'unknown', raw: '' }; }
}

// Ask the core to validate one transport. This is the only trustworthy source:
// version strings lie (Reality is present in 1.8.0 despite what some READMEs
// claim) and config shape differs between builds.
function probeOne(network, dir) {
  const os = require('os');
  const tmp = path.join(os.tmpdir(), 't1-cap-' + process.pid + '-' + Math.random().toString(36).slice(2));
  fs.mkdirSync(tmp, { recursive: true });
  const cfg = {
    log: { loglevel: 'error' },
    inbounds: [{ tag: 'in', port: 0, listen: '127.0.0.1', protocol: 'socks', settings: {} }],
    outbounds: [{
      tag: 'probe', protocol: 'vless',
      settings: { vnext: [{ address: 'example.com', port: 443, users: [{ id: '00000000-0000-0000-0000-000000000000', encryption: 'none' }] }] },
      streamSettings: { network, security: 'none' },
    }],
    routing: { rules: [] },
  };
  if (network === 'ws') cfg.outbounds[0].streamSettings.wsSettings = { path: '/' };
  if (network === 'grpc') cfg.outbounds[0].streamSettings.grpcSettings = { serviceName: 'p' };
  // Probe the raw transport, not the app's rewrite of it: we want to know what
  // the core itself accepts.
  if (network === 'h2' || network === 'http') { cfg.outbounds[0].streamSettings.network = 'http'; cfg.outbounds[0].streamSettings.httpSettings = { path: '/' }; }
  if (network === 'httpupgrade') cfg.outbounds[0].streamSettings.httpupgradeSettings = { path: '/' };
  if (network === 'xhttp') cfg.outbounds[0].streamSettings.xhttpSettings = { path: '/' };
  if (network === 'quic') cfg.outbounds[0].streamSettings.quicSettings = { security: 'none', key: 'k', header: { type: 'none' } };

  const file = path.join(tmp, 'c.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  let ok = false, why = '';
  try {
    const r = spawnSync(path.join(dir, 'xray.exe'), ['run', '-test', '-c', file],
      { encoding: 'utf8', cwd: dir, timeout: 30000, env: { ...process.env, XRAY_LOCATION_ASSET: dir } });
    const out = String(r.stdout || '') + String(r.stderr || '');
    ok = r.status === 0 && /Configuration OK/.test(out);
    if (!ok) why = (out.split(/Failed to start:\s*/)[1] || '').trim().slice(0, 120);
  } catch (e) { why = e.message; }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  return { ok, why };
}

// Returns { version, arch, unsupported: string[], raw }
function probe() {
  const dir = coreDir();
  const info = coreVersion(dir);
  const unsupported = [];
  const removed = [];
  for (const n of CANDIDATES) {
    const r = probeOne(n, dir);
    if (r.ok) continue;
    // Distinguish "this core cannot do it" from "this core deliberately removed
    // it and something else replaced it", which is worth saying out loud.
    if (/has been removed/i.test(r.why || '')) removed.push(n);
    else unsupported.push(n);
  }
  cache = new Set(unsupported);
  return { ...info, unsupported: unsupported.slice(), removed: removed.slice(), probed: CANDIDATES.length };
}

// Legacy transports the app rewrites before emitting, so they never reach the
// core in their old form. 'h2'/'http' became xhttp; 'splithttp' is xhttp's old
// name. buildOutbound() converts them, so they must not be probed or gated.
const REWRITTEN = { h2: 'xhttp', http: 'xhttp', splithttp: 'xhttp' };

function unsupportedReason(network) {
  const n = String(network || '').toLowerCase();
  if (REWRITTEN[n]) return null;          // handled by buildOutbound
  if (!cache) {
    // Not probed yet: do not guess. Let it through and let the core complain
    // with its own message rather than blocking a transport that may work.
    return null;
  }
  if (!cache.has(n)) return null;
  return `The bundled core rejected the "${n}" transport when it was tested at startup.`;
}

function isReady() { return cache !== null; }

module.exports = { CANDIDATES, probe, probeOne, unsupportedReason, isReady, coreDir, coreVersion };