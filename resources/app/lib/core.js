'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const caps = require('./capabilities');

const HTTP_PORT = 10809;   // system proxy (http)
const SOCKS_PORT = 10808; // local socks5

// Ports are a shared singleton. A core left over from a previous run (or from
// a "CORE ONLY" start) keeps them bound and makes every later start fail with
// an opaque "core failed to start", so clear them before spawning.
function portOwner(port) {
  return new Promise((resolve) => {
    execFile('netstat.exe', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve([]);
      const pids = new Set();
      for (const line of String(stdout).split(/\r?\n/)) {
        if (!new RegExp(`^\\s*TCP\\s+\\S+:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`).test(line)) continue;
        const m = line.match(/\s(\d+)\s*$/);
        if (m) pids.add(m[1]);
      }
      resolve([...pids]);
    });
  });
}

async function killPids(pids) {
  for (const pid of pids) {
    if (String(pid) === String(process.pid)) continue;
    await new Promise((resolve) => {
      execFile('taskkill.exe', ['/PID', String(pid), '/F'], { windowsHide: true }, () => resolve());
    });
  }
}

// Returns true when both ports are free.
async function releasePorts(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const owners = [...await portOwner(HTTP_PORT), ...await portOwner(SOCKS_PORT)];
    if (!owners.length) return true;
    await killPids(owners);
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 350));
  }
}

function coreDir(base) {
  // packaged: resources/core ; dev: <app>/core
  const p1 = path.join(process.resourcesPath || '', 'core');
  if (process.resourcesPath && fs.existsSync(path.join(p1, 'xray.exe'))) return p1;
  return path.join(base, 'core');
}

function corePaths(base) {
  const d = coreDir(base);
  return {
    dir: d,
    xray: path.join(d, 'xray.exe'),
    geoip: path.join(d, 'geoip.dat'),
    geosite: path.join(d, 'geosite.dat'),
  };
}

function isCorePresent(base) {
  try { return fs.existsSync(corePaths(base).xray); } catch (e) { return false; }
}

// Build an xray outbound object from a parsed server.
function buildOutbound(s) {
  const stream = { network: s.network || 'tcp' };

  // Ask the bundled core what it supports rather than trusting a version table.
  // Unsupported transports are refused with an explanation; the core would
  // otherwise answer only "unknown transport protocol".
  const bad = caps.unsupportedReason(stream.network);
  if (bad) {
    throw new Error(
      `This node needs the "${stream.network}" transport, which the bundled core cannot run.\n\n`
      + `${bad}\n\n`
      + 'It can still be imported and shown on the globe, but connecting through it is blocked.\n'
      + 'Ask your provider for a link using ws, grpc, tcp or h2 instead.'
    );
  }

  const sec = (s.security || 'none').toLowerCase();
  const useTls = !!s.tls || sec === 'tls' || sec === 'reality';

  if (useTls) {
    stream.security = sec === 'reality' ? 'reality' : 'tls';
    if (s.sni) stream.tlsSettings = { serverName: s.sni };
    else if (s.host) stream.tlsSettings = { serverName: s.host };
    if (s.fingerprint) {
      stream.tlsSettings = stream.tlsSettings || {};
      stream.tlsSettings.fingerprint = s.fingerprint;
    }
    // Current Xray REMOVED tlsSettings.allowInsecure ("has been removed and
    // migrated to pinnedPeerCertSha256"), so emitting it makes the core abort
    // before it ever binds a port. The parsed value is kept on the node and
    // shown in the UI, but it is deliberately not written into the config:
    // dropping a verification bypass is the safe direction to fail.
    if (String(s.allowInsecure || '') === '1') {
      // Intentionally not emitted. See note above.
    }
    if (s.alpn) {
      stream.tlsSettings = stream.tlsSettings || {};
      stream.tlsSettings.alpn = s.alpn.split(',').map((x) => x.trim()).filter(Boolean);
    }
    if (sec === 'reality') {
      stream.realitySettings = {
        publicKey: s.publicKey || '',
        fingerprint: s.fingerprint || 'chrome',
        serverName: s.sni || s.host || '',
        shortId: s.shortId || '',
        spiderX: s.spiderX || '/',
      };
      if (stream.tlsSettings) delete stream.tlsSettings;
    }
  }

  if (stream.network === 'ws') {
    stream.wsSettings = { path: s.path || '/' };
    if (s.host) stream.wsSettings.headers = { Host: s.host };
  } else if (stream.network === 'grpc') {
    stream.grpcSettings = { serviceName: (s.path || s.serviceName || '').replace(/^\//, '') };
  } else if (stream.network === 'http' || stream.network === 'h2') {
    // Current Xray removed plain HTTP/2 transport: "h2" and "http" links now
    // mean XHTTP. Verified - the core errors with "the feature HTTP transport
    // has been removed and migrated to XHTTP stream-one H2 & H3". So a legacy
    // h2 link has to be rewritten as xhttp, not emitted as network:"http".
    stream.network = 'xhttp';
    stream.xhttpSettings = { path: s.path || '/' };
    if (s.host) stream.xhttpSettings.host = s.host;
    delete stream.httpSettings;
  } else if (stream.network === 'httpupgrade') {
    stream.httpupgradeSettings = { path: s.path || '/' };
    if (s.host) stream.httpupgradeSettings.host = s.host;
  } else if (stream.network === 'xhttp') {
    stream.xhttpSettings = { path: s.path || '/' };
    if (s.host) stream.xhttpSettings.host = s.host;
    // mode/extra are only understood by newer cores; harmless where ignored.
    if (s.xhttpMode) stream.xhttpSettings.mode = s.xhttpMode;
  } else if (stream.network === 'tcp' && s.headerType === 'http') {
    stream.tcpSettings = { header: { type: 'http', request: { path: [s.path || '/'], headers: { Host: [s.host] } } } };
  }

  let settings;
  switch (s.protocol) {
    case 'vless':
      settings = { vnext: [{ address: s.address, port: s.port, users: [{
        id: s.uuid, encryption: 'none',
        ...(s.flow ? { flow: s.flow } : {}),
      }] }] };
      break;
    case 'vmess':
      settings = { vnext: [{ address: s.address, port: s.port, users: [{
        id: s.uuid, alterId: s.alterId || 0, security: s.security || 'auto',
      }] }] };
      break;
    case 'trojan':
      settings = { servers: [{ address: s.address, port: s.port, password: s.password }] };
      break;
    case 'shadowsocks':
      settings = { servers: [{ address: s.address, port: s.port, method: s.method, password: s.password }] };
      break;
    default:
      throw new Error('Unsupported protocol: ' + s.protocol);
  }
  // Xray reads transport settings from "streamSettings". Using the key "stream"
  // makes Xray silently ignore ws/tls/reality entirely, so every connection
  // falls back to plain TCP and the server answers with nothing.
  return { tag: 'proxy', protocol: s.protocol, settings, streamSettings: stream };
}

function buildConfig(servers, activeId, dataDir) {
  const active = servers.find((s) => s.id === activeId) || servers[0];
  if (!active) throw new Error('No server selected');
  // NOTE: Xray treats the FIRST outbound in this array as the default for
  // unrouted traffic. The proxy must therefore be first, otherwise every
  // request silently goes out 'direct' and the tunnel appears connected
  // while nothing is actually tunnelled.
  const outbounds = [
    buildOutbound(active),
    { tag: 'direct', protocol: 'freedom', settings: {} },
    { tag: 'block', protocol: 'blackhole', settings: { response: { type: 'http' } } },
  ];
  return {
    log: { loglevel: 'warning' },
    inbounds: [
      {
        tag: 'http-in', port: HTTP_PORT, listen: '127.0.0.1', protocol: 'http',
        settings: { allowTransparent: false },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false },
      },
      {
        tag: 'socks-in', port: SOCKS_PORT, listen: '127.0.0.1', protocol: 'socks',
        settings: { udp: true, auth: 'noauth' },
        sniffing: { enabled: true, destOverride: ['http', 'tls', 'quic'], routeOnly: false },
      },
    ],
    outbounds,
    routing: {
      domainStrategy: 'IPIfNonMatch',
      rules: [
        { type: 'field', ip: ['geoip:private'], outboundTag: 'direct' },
        { type: 'field', protocol: ['bittorrent'], outboundTag: 'direct' },
        // final catch-all: everything not matched above goes through the tunnel
        { type: 'field', network: 'tcp,udp', outboundTag: 'proxy' },
      ],
    },
    policy: { levels: { '0': { handshake: 4, connIdle: 300, uplinkOnly: 2, downlinkOnly: 5 } } },
  };
}

class CoreRunner {
  constructor(base, dataDir) {
    this.base = base;
    this.proc = null;
    // must be a writable path (userData), never the read-only asar bundle
    this.dataDir = dataDir || path.join(base, 'data');
    this.configPath = path.join(this.dataDir, 'config.json');
    this.logBuf = [];
  }

  async start(servers, activeId) {
    this.stop();
    // Clear any orphaned core still holding 10808/10809, otherwise the new
    // process cannot bind and we report a misleading "core failed to start".
    const freed = await releasePorts();
    if (!freed) {
      return { started: false, error: 'Ports ' + HTTP_PORT + '/' + SOCKS_PORT + ' are held by another program that could not be stopped. Close other VPN or proxy apps and try again.', log: [] };
    }
    fs.mkdirSync(this.dataDir, { recursive: true });
    const cfg = buildConfig(servers, activeId, this.dataDir);
    fs.writeFileSync(this.configPath, JSON.stringify(cfg, null, 2));
    const p = corePaths(this.base);
    if (!fs.existsSync(p.xray)) throw new Error('xray.exe not found in core/ — cannot start the core');

    this.proc = spawn(p.xray, ['run', '-c', this.configPath], {
      cwd: p.dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, XRAY_LOCATION_ASSET: p.dir },
    });
    // Remembered after stop() so the exit handler can still clean up a core we
    // launched, without taskkill'ing every xray.exe on the machine.
    this.lastPid = this.proc.pid;
    const onData = (buf) => {
      const text = buf.toString();
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.logBuf.push(line);
        if (this.logBuf.length > 300) this.logBuf.shift();
      }
    };
    this.proc.stdout.on('data', onData);
    this.proc.stderr.on('data', onData);
    this.proc.on('error', (e) => {
      this.proc = null;
      this.logBuf.push(`[core failed to launch: ${e.message}]`);
    });
    this.proc.on('exit', (code, signal) => {
      this.proc = null;
      this.logBuf.push(`[core exited with code ${code}${signal ? ' (' + signal + ')' : ''}]`);
    });
    await new Promise((r) => setTimeout(r, 1200));
    if (!this.proc) {
      return { started: false, error: 'The core exited immediately - see logs.', log: this.logBuf.slice(-12) };
    }
    return { started: true, log: this.logBuf.slice(-12) };
  }

  isRunning() { return !!this.proc; }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch (e) {} this.proc = null; }
  }

  getLog() { return this.logBuf.slice(-60); }
}

module.exports = { CoreRunner, buildConfig, buildOutbound, corePaths, isCorePresent, releasePorts, HTTP_PORT, SOCKS_PORT };
