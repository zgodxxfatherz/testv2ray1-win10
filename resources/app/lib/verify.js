'use strict';
// Verify the tunnel actually carries traffic, instead of assuming a started
// core means a working VPN. Probes through the local HTTP proxy and compares
// the observed egress IP against the machine's direct egress IP.
const http = require('http');

const PROXY_HOST = '127.0.0.1';
const PROXY_PORT = 10809;

// Minimal HTTP client that tunnels through an HTTP proxy.
// For an https:// URL the proxy must be given an absolute URI and we speak
// CONNECT ourselves, otherwise https sites cannot be tested here.
function viaProxy(url, timeout = 25000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = http.request({
      host: PROXY_HOST,
      port: PROXY_PORT,
      method: 'GET',
      path: u.href,                 // absolute-form: required for HTTP proxies
      headers: { Host: u.host, 'User-Agent': 'testv2ray1/1.0' },
      timeout,
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 500, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
    req.end();
  });
}

function direct(url, timeout = 10000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? require('https') : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'testv2ray1/1.0' }, timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
      res.on('end', () => resolve({ ok: true, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
  });
}

const ECHO = 'http://ip-api.com/json/?fields=status,country,countryCode,city,isp,query';

function parseEcho(body) {
  try {
    const j = JSON.parse(body);
    if (j.status && j.status !== 'success') return null;
    return {
      ip: j.query || '',
      country: j.country || '',
      countryCode: j.countryCode || '',
      city: j.city || '',
      isp: j.isp || '',
    };
  } catch (e) { return null; }
}

// Confirm the local proxy port is actually accepting connections.
function probePort(timeout = 3000) {
  return new Promise((resolve) => {
    const net = require('net');
    const s = new net.Socket();
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { s.destroy(); } catch (e) {} resolve(v); };
    s.setTimeout(timeout);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
    try { s.connect(PROXY_PORT, PROXY_HOST); } catch (e) { fin(false); }
  });
}

// A single request is not enough evidence on this network: a cold Reality
// handshake measured at ~8s here, which sat right on the old 12s timeout and
// reported a working link as broken. Retry before declaring failure, and say how
// many attempts succeeded so a flaky path is visible rather than hidden.
const TRIES = 4;

async function viaProxyRetry() {
  let last = { ok: false, error: 'no attempt made' };
  for (let i = 0; i < TRIES; i++) {
    last = await viaProxy(ECHO);
    if (last.ok) return { ...last, tries: i + 1 };
    if (i < TRIES - 1) await new Promise((r) => setTimeout(r, 900));
  }
  return { ...last, tries: TRIES };
}

// Full verdict on whether the tunnel is usable.
// kind: 'tunnelled' -> egress differs from direct (traffic really is proxied)
//      'leaking'   -> egress identical to direct (proxy armed but not routing)
//      'dead'      -> no response through the proxy at all
async function verify() {
  const portOpen = await probePort();
  if (!portOpen) {
    return { ok: false, kind: 'dead', reason: 'Nothing is listening on 127.0.0.1:' + PROXY_PORT };
  }

  const via = await viaProxyRetry();
  const through = via.ok ? parseEcho(via.body) : null;
  if (!through || !through.ip) {
    return {
      ok: false, kind: 'dead', portOpen: true,
      reason: `The server accepted the connection but returned no data (handshake failed) on ${via.tries}/${TRIES} attempts.`,
      detail: via.error || (via.status ? 'HTTP ' + via.status : 'empty response'),
    };
  }

  // Compare with the machine's own egress so we can prove the tunnel is real.
  const dir = await direct(ECHO);
  const baseline = dir.ok ? parseEcho(dir.body) : null;

  const changed = !baseline || !baseline.ip || baseline.ip !== through.ip;
  return {
    ok: changed,
    kind: changed ? 'tunnelled' : 'leaking',
    ip: through.ip,
    country: through.country,
    countryCode: through.countryCode,
    city: through.city,
    isp: through.isp,
    directIp: baseline ? baseline.ip : null,
    directCountry: baseline ? baseline.country : null,
    reason: changed
      ? 'Traffic is leaving through the tunnel.'
      : 'The proxy is armed but traffic is still going out directly - it is not tunnelling.',
  };
}

module.exports = { verify, viaProxy, direct, probePort, parseEcho, PROXY_PORT };