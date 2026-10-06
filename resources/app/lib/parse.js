'use strict';
const fs = require('fs');
const caps = require('./capabilities');

function b64decode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/').replace(/\s+/g, '');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function parseQuery(q) {
  const out = {};
  if (!q) return out;
  for (const part of q.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) out[decodeURIComponent(part)] = '';
    else out[decodeURIComponent(part.slice(0, i))] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

function normHostPort(hostport, portDef) {
  let h = String(hostport || '').trim();
  let port = parseInt(portDef, 10) || 0;

  if (h.startsWith('[')) {
    // bracketed IPv6, optionally with port: [::1]:443
    const close = h.indexOf(']');
    if (close >= 0) {
      const inner = h.slice(1, close);
      const tail = h.slice(close + 1);
      if (tail.startsWith(':')) port = parseInt(tail.slice(1), 10) || port;
      h = inner;
    }
  } else {
    const idx = h.lastIndexOf(':');
    // only treat as host:port when there is exactly one colon and the tail is numeric
    if (idx > 0 && h.indexOf(':') === idx) {
      const tail = h.slice(idx + 1);
      if (/^\d+$/.test(tail)) { port = parseInt(tail, 10); h = h.slice(0, idx); }
    }
  }
  return { host: h, port: port || 443 };
}

// Parse a single v2ray share link. Returns a server object or throws.
function parseLink(line) {
  const raw = String(line || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  if (!/^(vless|vmess|ss|trojan|vmess):\/\//i.test(raw) && !/^[a-z0-9-]+:\/\//i.test(raw)) {
    if (/^[A-Za-z0-9+/=]{24,}={0,2}$/.test(raw.replace(/\s+/g, '')) && raw.length > 40) {
      // bare base64 subscription payload
      const decoded = b64decode(raw.replace(/\s+/g, ''));
      const lines = decoded.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length && lines.every((l) => /:\/\//.test(l))) {
        return { __multi: lines.map((l) => parseLink(l)).filter(Boolean) };
      }
    }
    return null;
  }

  const m = raw.match(/^([a-zA-Z0-9+.-]+):\/\/(.*)$/);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const rest = m[2];

  if (scheme === 'vmess') {
    let j;
    try { j = JSON.parse(b64decode(rest)); } catch (e) { throw new Error('vmess payload is not valid base64 JSON'); }
    const hp = normHostPort(j.add, j.port);
    return {
      id: uid(),
      remark: j.ps || j.remarks || hp.host,
      protocol: 'vmess',
      address: hp.host,
      port: hp.port,
      uuid: j.id,
      alterId: parseInt(j.aid, 10) || 0,
      security: j.scy || j.security || 'auto',
      network: (j.net || 'tcp').toLowerCase(),
      allowInsecure: j.allowInsecure || j.skipCertVerify || '',
      headerType: j.headerType || '',
      tls: String(j.tls || '').toLowerCase() === 'tls',
      host: j.host || '',
      path: j.path || '',
      sni: j.sni || j.host || '',
      fingerprint: j.fp || '',
      source: raw,
    };
  }

  if (scheme === 'ss') {
    // Two shapes:
    //   ss://base64(method:pass@host:port)#name     (whole body base64)
    //   ss://base64(method:pass)@host:port#name     (userinfo base64, SIP002)
    let body = rest, name = '';
    const hash = body.indexOf('#');
    if (hash >= 0) { name = decodeURIComponent(body.slice(hash + 1)); body = body.slice(0, hash); }
    let userinfo, hostport;
    if (!body.includes('@')) {
      const dec = b64decode(body);
      const at = dec.lastIndexOf('@');
      if (at < 0) throw new Error('ss link missing @');
      userinfo = dec.slice(0, at); hostport = dec.slice(at + 1);
    } else {
      const at = body.lastIndexOf('@');
      userinfo = body.slice(0, at); hostport = body.slice(at + 1);
      // userinfo may still be base64 (no ':' before decoding)
      if (!userinfo.includes(':')) {
        try {
          const dec = b64decode(userinfo);
          if (dec.includes(':')) userinfo = dec;
        } catch (e) { /* already plain */ }
      }
    }
    const colon = userinfo.indexOf(':');
    const method = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
    const pass = colon >= 0 ? userinfo.slice(colon + 1) : '';
    const hp = normHostPort(hostport, 443);
    return {
      id: uid(), remark: name || hp.host, protocol: 'shadowsocks',
      address: hp.host, port: hp.port, method: decodeURIComponent(method),
      password: decodeURIComponent(pass), source: raw,
    };
  }

  // vless://trojan://  -> vless://uuid@host:port?params#name
  let body = rest, name = '';
  const hash = body.indexOf('#');
  if (hash >= 0) { name = decodeURIComponent(body.slice(hash + 1)); body = body.slice(0, hash); }
  const qIdx = body.indexOf('?');
  const query = parseQuery(qIdx >= 0 ? body.slice(qIdx + 1) : '');
  const base = qIdx >= 0 ? body.slice(0, qIdx) : body;
  const at = base.lastIndexOf('@');
  if (at < 0) throw new Error('link missing @host:port');
  const userinfo = base.slice(0, at);
  const hp = normHostPort(base.slice(at + 1), 443);

  const s = {
    id: uid(),
    remark: name || hp.host,
    protocol: scheme,
    address: hp.host,
    port: hp.port,
    uuid: decodeURIComponent(userinfo),
    network: (query.type || 'tcp').toLowerCase(),
    tls: String(query.security || '').toLowerCase() === 'tls' || query.security === 'reality',
    security: query.security || 'none',
    sni: query.sni || query.host || '',
    host: query.host || '',
    path: decodeURIComponent(query.path || query.serviceName || ''),
    fingerprint: query.fp || '',
    publicKey: query.pbk || '',
    shortId: query.sid || '',
    spiderX: query.spx || '',
    flow: query.flow || '',
    alpn: query.alpn || '',
    allowInsecure: query.allowInsecure || query.insecure || '',
    headerType: query.headerType || '',
    xhttpMode: query.mode || '',
    source: raw,
  };
  if (scheme === 'trojan') { s.password = decodeURIComponent(userinfo); delete s.uuid; }
  return s;
}

let counter = 0;
function uid() {
  counter += 1;
  return 'srv-' + Date.now().toString(36) + '-' + counter.toString(36);
}

// Tag a node whose transport the bundled core cannot run. The node is still
// kept: it can be listed, geo-located and pinged, it just cannot be connected
// through. Rejecting it at import time would silently hide real servers.
function annotate(s) {
  const why = caps.unsupportedReason(s.network);
  s.unsupported = !!why;
  s.unsupportedReason = why || null;
  return s;
}

function parseBulk(text) {
  const servers = [];
  const errors = [];
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // subscription URL -> fetch it
    if (/^https?:\/\//i.test(line)) {
      try { errors.push({ line, error: 'subscription URL: fetch in the UI (Subscription tab)' }); } catch (e) {}
      continue;
    }
    try {
      const p = parseLink(line);
      if (p && p.__multi) servers.push(...p.__multi.map(annotate));
      else if (p) servers.push(annotate(p));
    } catch (e) {
      errors.push({ line: line.slice(0, 80), error: e.message });
    }
  }
  return { servers, errors };
}

function parseFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  return parseBulk(text);
}

module.exports = { parseLink, parseBulk, parseFile, b64decode, annotate };
