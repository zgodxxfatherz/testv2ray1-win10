'use strict';
const https = require('https');
const http = require('http');
const dns = require('dns');

function getJSON(url, timeout = 8000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'testv2ray1/1.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 200000) req.destroy(); });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(null); }
      });
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

function getText(url, timeout = 10000) {
  return new Promise((resolve) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve(data));
    });
    req.setTimeout(timeout, () => { req.destroy(); resolve(''); });
    req.on('error', () => resolve(''));
  });
}

// Resolve hostname -> first IPv4/IPv6 address string (or the input if already an IP).
function resolveHost(host) {
  return new Promise((resolve) => {
    if (!host) return resolve('');
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':')) return resolve(host);
    dns.lookup(host, { all: false }, (err, addr) => resolve(err ? '' : addr));
  });
}

const cache = new Map();

async function lookupGeo(host) {
  const key = String(host || '').toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const finish = (o) => { o.flag = flagEmoji(o.countryCode); o.location = locationLine(o); cache.set(key, o); return o; };
  const ip = await resolveHost(key);
  const out = {
    host: key,
    ip: ip || key,
    country: '', countryCode: '', region: '', city: '', lat: null, lon: null,
    isp: '', resolved: false,
  };
  if (!out.ip) return finish(out);

  // ip-api.com free tier: http, 45 req/min
  let j = await getJSON(`http://ip-api.com/json/${encodeURIComponent(out.ip)}?fields=status,country,countryCode,regionName,city,lat,lon,isp,query`);
  if (!j || j.status !== 'success') {
    j = await getJSON(`https://ipwho.is/${encodeURIComponent(out.ip)}`);
    if (j && j.success) {
      out.country = j.country || ''; out.countryCode = j.country_code || '';
      out.region = j.region || ''; out.city = j.city || '';
      out.lat = j.latitude ?? null; out.lon = j.longitude ?? null;
      out.isp = (j.connection && j.connection.isp) || j.isp || '';
      out.ip = j.ip || out.ip; out.resolved = true;
      return finish(out);
    }
    return finish(out);
  }
  out.country = j.country || ''; out.countryCode = j.countryCode || '';
  out.region = j.region || ''; out.city = j.city || '';
  out.lat = j.lat; out.lon = j.lon; out.isp = j.isp || '';
  out.ip = j.query || out.ip; out.resolved = true;
  return finish(out);
}

// TCP connect latency in ms to host:port (falls back to ICMP-less TCP handshake).
function tcpPing(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const net = require('net');
    const started = Date.now();
    let done = false;
    const socket = new net.Socket();
    const finish = (ms, err) => {
      if (done) return; done = true;
      try { socket.destroy(); } catch (e) {}
      resolve(err ? { ms: -1, error: err } : { ms: ms });
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(Date.now() - started));
    socket.once('timeout', () => finish(-1, 'timeout'));
    socket.once('error', (e) => finish(-1, e.code || e.message));
    try { socket.connect(port, host); } catch (e) { finish(-1, e.message); }
  });
}

function flagEmoji(code) {
  if (!code || code.length !== 2) return '';
  return String.fromCodePoint(0x1f1e6 + code.toUpperCase().charCodeAt(0) - 65,
                             0x1f1e6 + code.toUpperCase().charCodeAt(1) - 65);
}

function locationLine(g) {
  if (!g || !g.resolved) return 'Unknown location';
  const parts = [g.city, g.region, g.country].filter(Boolean);
  const uniq = [];
  for (const p of parts) if (!uniq.includes(p)) uniq.push(p);
  return uniq.join(', ') || g.country || 'Unknown location';
}

module.exports = { lookupGeo, tcpPing, resolveHost, getText, getJSON, flagEmoji, locationLine };
