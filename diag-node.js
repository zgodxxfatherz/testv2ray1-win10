'use strict';
// Diagnose one node against the real 32-bit core: start it, send a real
// request through the SOCKS port, and report exactly what the core logged.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const tls = require('tls');
const { spawn } = require('child_process');

const APP = path.join(__dirname, 'resources', 'app');
const CORE = path.join(__dirname, 'resources', 'core');
const TMP = path.join(os.tmpdir(), 't1win7-diag');
const { parseLink } = require(path.join(APP, 'lib', 'parse'));
const { buildConfig } = require(path.join(APP, 'lib', 'core'));

fs.mkdirSync(TMP, { recursive: true });

const SOCKS = 29808;
const HTTP = 29809;

// Pass your own link as an argument. No real credentials are stored in this
// file on purpose: a committed share-link is a working credential for anyone
// who clones the repo.
//
//   node diag-node.js "vless://uuid@host:443?..."
//
// The placeholder below is the shape only - it will not connect anywhere.
const LINK = process.argv[2] || 'vless://00000000-0000-0000-0000-000000000000@127.0.0.1:443?encryption=none&security=none&type=tcp#not-a-real-server';

// One real request through SOCKS5 + TLS, so we see the actual failure point.
function probe(host, port443, timeoutMs = 14000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = net.connect(SOCKS, '127.0.0.1', () => s.write(Buffer.from([5, 1, 0])));
    let stage = 0, fin = false;
    const done = (ok, why) => { if (fin) return; fin = true; try { s.destroy(); } catch (e) {} resolve({ ok, ms: Date.now() - t0, why }); };
    const hb = Buffer.from(host);
    s.on('data', function on(d) {
      if (stage === 0) {
        stage = 1;
        s.write(Buffer.concat([Buffer.from([5, 1, 0, 3, hb.length]), hb,
          Buffer.from([(port443 >> 8) & 0xff, port443 & 0xff])]));
        return;
      }
      if (stage === 1) {
        stage = 2;
        if (d[1] !== 0) return done(false, 'SOCKS5 reply code ' + d[1]);
        const t = tls.connect({ socket: s, servername: host, rejectUnauthorized: false });
        t.setTimeout(timeoutMs, () => done(false, 'TLS handshake timed out'));
        t.once('secureConnect', () => t.write('GET /generate_204 HTTP/1.1\r\nHost: ' + host + '\r\nConnection: close\r\n\r\n'));
        t.on('data', (c) => done(true, String(c).split('\r\n')[0]));
        t.on('error', (e) => done(false, 'TLS: ' + e.message));
        s.removeListener('data', on);
      }
    });
    s.on('error', (e) => done(false, e.message));
    setTimeout(() => done(false, 'timed out'), timeoutMs + 2000);
  });
}

async function attempt(label, server, tweak) {
  const cfg = buildConfig([server], server.id, TMP);
  cfg.log.loglevel = 'debug';           // we want the reason, not silence
  cfg.inbounds[0].port = HTTP;
  cfg.inbounds[1].port = SOCKS;
  if (tweak) tweak(cfg);
  const p = path.join(TMP, 'c-' + label.replace(/\W+/g, '_') + '.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));

  const proc = spawn(path.join(CORE, 'xray.exe'), ['run', '-c', p],
    { cwd: CORE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XRAY_LOCATION_ASSET: CORE } });

  let log = '';
  const keep = (b) => { log += b.toString(); if (log.length > 60000) log = log.slice(-30000); };
  proc.stdout.on('data', keep);
  proc.stderr.on('data', keep);

  await new Promise((r) => setTimeout(r, 2000));
  if (proc.exitCode !== null) {
    console.log('\n### ' + label + ': CORE DIED ON STARTUP (code ' + proc.exitCode + ')');
    console.log(log.split(/\r?\n/).filter((l) => /error|failed|invalid|unknown/i.test(l)).slice(0, 6).join('\n'));
    return { ok: false };
  }

  let r = null;
  for (let i = 0; i < 3; i++) {
    r = await probe('www.gstatic.com', 443);
    if (r.ok) break;
    await new Promise((x) => setTimeout(x, 900));
  }
  try { proc.kill(); } catch (e) {}
  await new Promise((r2) => setTimeout(r2, 600));

  const ob = cfg.outbounds[0];
  const rs = ob.streamSettings.realitySettings || {};
  console.log('\n### ' + label);
  console.log('  outbound : ' + ob.protocol + ' ' + ob.streamSettings.network + ' / ' + ob.streamSettings.security +
    '  flow=' + ((ob.settings.vnext || [])[0].users[0].flow || '(none)'));
  console.log('  serverName=' + rs.serverName + '  publicKey=' + String(rs.publicKey).slice(0, 12) + '...' +
    '  shortId=' + rs.shortId + '  fingerprint=' + rs.fingerprint);
  console.log('  verdict  : ' + (r.ok ? 'WORKS  ' + r.ms + 'ms' : 'FAILED  ' + r.why));
  const interesting = log.split(/\r?\n/).filter((l) =>
    /error|failed|reality|handshake|rejected|invalid|unexpected|refused|eof|timeout|traffic|accepted/i.test(l));
  console.log('  core log :');
  console.log('    ' + (interesting.slice(-6).join('\n    ') || '(nothing notable)').slice(0, 1400));
  return r;
}

(async () => {
  const server = parseLink(LINK);
  console.log('parsed: ' + server.remark + '  ' + server.protocol + '/' + server.network +
    '  ' + server.address + ':' + server.port + '  flow=' + (server.flow || '(none)'));

  // Baseline: the same routing shape over plain TCP with no tunnel at all.
  await attempt('A: as linked (reality + xtls-rprx-vision)', server);
  // Does dropping the Vision flow change anything? It is the usual culprit when
  // a provider's server is newer than the client core.
  await attempt('B: same link, flow removed', server, (cfg) => {
    delete cfg.outbounds[0].settings.vnext[0].users[0].flow;
  });
})().catch((e) => { console.error('ERR', e); process.exit(2); });