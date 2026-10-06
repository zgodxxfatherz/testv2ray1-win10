'use strict';
// Harness for the Windows 10/11 build. Transport support is discovered from the
// bundled core, not hard-coded, so this suite checks the discovery itself.
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { spawn, spawnSync, execFileSync } = require('child_process');

const APP = path.join(__dirname, 'resources', 'app');
const CORE = path.join(__dirname, 'resources', 'core');
const TMP = path.join(os.tmpdir(), 't1win10-tests');
const { parseBulk } = require(path.join(APP, 'lib', 'parse'));
const coreLib = require(path.join(APP, 'lib', 'core'));
const geo = require(path.join(APP, 'lib', 'geo'));
const proxy = require(path.join(APP, 'lib', 'proxy'));
const verifyLib = require(path.join(APP, 'lib', 'verify'));
const caps = require(path.join(APP, 'lib', 'capabilities'));

fs.mkdirSync(TMP, { recursive: true });

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  -> ' + String(extra).slice(0, 220) : '')); }
};
const section = (t) => console.log('\n== ' + t + ' ==');

const VALID_PK = 'uzFTrr52mInUnWtw0S0MsGwRaiR2QAkesRmzhCLtGQY';
// Current Xray validates UUIDs strictly. The old fixtures used placeholders
// like 'aaaaaaaa-...' that this core rejects outright.
const V_UU = '8aaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const V_UU2 = '9f8e7d6c-5b4a-4938-8271-6a5b4c3d2e1f';
const V_UU3 = '11111111-2222-3333-4444-555555555555';

const LINKS = [
  'vless://' + V_UU3 + '@it.example-cloud.com:443?encryption=none&security=reality&sni=www.microsoft.com&fp=chrome&pbk=' + VALID_PK + '&sid=6ba85179e30d4fc2&spx=%2F&type=tcp&flow=xtls-rprx-vision#Italy-Reality',
  'vless://' + V_UU2 + '@de.example-node.net:8443?encryption=none&security=tls&sni=cdn.example.org&type=ws&host=cdn.example.org&path=%2Fray#Germany-WS',
  'vmess://' + Buffer.from(JSON.stringify({
    v: '2', ps: 'vmess-node', add: 'nl.example-server.com', port: '443',
    id: V_UU, aid: '0', scy: 'auto', net: 'ws', tls: 'tls',
    host: 'cdn.example.com', path: '/path',
  })).toString('base64'),
  'trojan://MyPassw0rd%21@tr.example-server.net:443?sni=tr.example-server.net&type=grpc&serviceName=grpcsvc#Netherlands-GRPC',
  'ss://' + Buffer.from('aes-256-gcm:sekretpass').toString('base64') + '@ss.example-host.net:8388#Singapore-SS',
  // transports that were impossible on the Win7 core and must work here
  'vless://' + V_UU3 + '@xh.example.com:443?encryption=none&security=none&type=xhttp&path=%2Fx#XHTTP-Node',
  'vless://' + V_UU3 + '@hu.example.com:443?encryption=none&security=none&type=httpupgrade&path=%2Fh#HTTPUPGRADE-Node',
  'vless://' + V_UU3 + '@h2.example.com:443?encryption=none&security=none&type=h2&path=%2Fh#LEGACY-H2-Node',
];

(async () => {
  section('PLATFORM');
  const v = spawnSync(path.join(CORE, 'xray.exe'), ['version'], { encoding: 'utf8', cwd: CORE });
  const is64 = /amd64/.test(v.stdout || '');
  check('core is current amd64 Xray', is64 && !/1\.8\.0/.test(v.stdout || ''), (v.stdout || '').split(/\r?\n/)[0]);
  check('app source unpacked and editable', fs.existsSync(path.join(APP, 'main.js')) && !fs.existsSync(path.join(__dirname, 'resources', 'app.asar')));

  section('CAPABILITY DISCOVERY (not a hard-coded list)');
  const cap = caps.probe();
  console.log('        Xray ' + cap.version + ' (' + cap.arch + ')');
  console.log('        unsupported: ' + (cap.unsupported.join(', ') || 'none'));
  console.log('        removed upstream: ' + (cap.removed.join(', ') || 'none'));
  check('probe covered every candidate transport', cap.probed === caps.CANDIDATES.length, cap.probed);
  check('gate is now populated', caps.isReady());
  check('xhttp is supported here', caps.unsupportedReason('xhttp') === null);
  check('httpupgrade is supported here', caps.unsupportedReason('httpupgrade') === null);
  check('legacy h2 is not gated (rewritten instead)', caps.unsupportedReason('h2') === null);

  section('LEGACY h2 REWRITE (the core removed plain HTTP/2 transport)');
  const h2 = parseBulk('vless://11111111-2222-3333-4444-555555555555@h2.example.com:443?encryption=none&security=none&type=h2&path=%2Fh#H2').servers[0];
  const h2ob = coreLib.buildOutbound(h2);
  check('h2 outbound emitted as xhttp', h2ob.streamSettings.network === 'xhttp', h2ob.streamSettings.network);
  check('no httpSettings left behind', !h2ob.streamSettings.httpSettings);
  check('xhttp path preserved', h2ob.streamSettings.xhttpSettings.path === '/h', JSON.stringify(h2ob.streamSettings.xhttpSettings));

  section('LINK PARSING');
  const { servers, errors } = parseBulk(LINKS.join('\n'));
  check('8 links parsed, none dropped', servers.length === 8, servers.length + ' parsed, errors=' + JSON.stringify(errors));
  check('nothing flagged unsupported on this core', servers.every((s) => s.unsupported === false),
    servers.filter((s) => s.unsupported).map((s) => s.remark).join(', '));

  section('allowInsecure: CAPTURED BUT NOT EMITTED (upstream removed the flag)');
  const ai = parseBulk('vless://' + V_UU3 + '@ai.example.com:443?encryption=none&security=tls&sni=ai.example.com&allowInsecure=1&type=tcp#AI').servers[0];
  check('allowInsecure captured from the link', ai.allowInsecure === '1', ai.allowInsecure);
  // Current Xray rejects the flag outright. Emitting it makes the core abort, so
  // the parser keeps the value for the UI to show and buildOutbound must not
  // write it into tlsSettings.
  const aiob = coreLib.buildOutbound(ai);
  const emitted = aiob.streamSettings.tlsSettings || {};
  check('allowInsecure NOT written into the config', emitted.allowInsecure === undefined, JSON.stringify(emitted));
  check('sniff: no pinnedPeerCertSha256 invented either', emitted.pinnedPeerCertSha256 === undefined, JSON.stringify(emitted));
  const aif = path.join(TMP, 'ai.json');
  const aicfg = coreLib.buildConfig([ai], ai.id, TMP);
  aicfg.log.loglevel = 'error';
  fs.writeFileSync(aif, JSON.stringify(aicfg, null, 2));
  const air = spawnSync(path.join(CORE, 'xray.exe'), ['run', '-test', '-c', aif],
    { encoding: 'utf8', cwd: CORE, env: { ...process.env, XRAY_LOCATION_ASSET: CORE } });
  check('core accepts an allowInsecure link once the dead flag is dropped',
    air.status === 0 && /Configuration OK/.test(String(air.stdout || '') + String(air.stderr || '')),
    (String(air.stdout || '') + String(air.stderr || '')).split(/Failed to start:\s*/)[1]);
  const secure = servers.find((s) => s.remark === 'Germany-WS');
  check('secure links carry no verification bypass', !secure || !secure.allowInsecure);

  section('EVERY TRANSPORT VALIDATED BY THE REAL CORE');
  for (const s of servers) {
    const cfg = coreLib.buildConfig([s], s.id, TMP);
    cfg.log.loglevel = 'error';
    const f = path.join(TMP, 't-' + s.remark.replace(/\W+/g, '_') + '.json');
    fs.writeFileSync(f, JSON.stringify(cfg, null, 2));
    const r = spawnSync(path.join(CORE, 'xray.exe'), ['run', '-test', '-c', f],
      { encoding: 'utf8', cwd: CORE, env: { ...process.env, XRAY_LOCATION_ASSET: CORE } });
    const out = String(r.stdout || '') + String(r.stderr || '');
    check('accepted: ' + s.remark + ' (' + s.protocol + '/' + (s.network || 'tcp') + ')',
      r.status === 0 && /Configuration OK/.test(out), out.split(/Failed to start:\s*/)[1]);
  }

  section('LIVE CORE + REAL TRAFFIC');
  const live = {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'http-in', port: 10809, listen: '127.0.0.1', protocol: 'http', settings: {}, sniffing: { enabled: true, destOverride: ['http', 'tls'] } },
      { tag: 'socks-in', port: 10808, listen: '127.0.0.1', protocol: 'socks', settings: { udp: true, auth: 'noauth' } },
    ],
    outbounds: [{ tag: 'direct', protocol: 'freedom', settings: {} }],
    routing: { rules: [] },
  };
  const livePath = path.join(TMP, 'live.json');
  fs.writeFileSync(livePath, JSON.stringify(live, null, 2));
  const proc = spawn(path.join(CORE, 'xray.exe'), ['run', '-c', livePath],
    { cwd: CORE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, XRAY_LOCATION_ASSET: CORE } });
  let out = '';
  proc.stdout.on('data', (b) => { out += b; });
  proc.stderr.on('data', (b) => { out += b; });
  await new Promise((r) => setTimeout(r, 2500));
  check('core stays alive', proc.exitCode === null, 'exited ' + proc.exitCode + ' ' + out.slice(0, 200));
  const tunnelled = await new Promise((resolve) => {
    const s = net.connect(10809, '127.0.0.1', () => s.write('CONNECT www.gstatic.com:443 HTTP/1.1\r\nHost: www.gstatic.com:443\r\n\r\n'));
    let buf = '';
    s.on('data', (d) => { buf += d.toString(); const m = buf.match(/^HTTP\/1\.1 (\d+)/); if (m) { s.destroy(); resolve({ ok: true, status: Number(m[1]) }); } });
    s.on('error', (e) => resolve({ ok: false, error: e.message }));
    setTimeout(() => { s.destroy(); resolve({ ok: false, error: 'timeout' }); }, 12000);
  });
  check('HTTP proxy CONNECT tunnel works', tunnelled.ok && tunnelled.status === 200, JSON.stringify(tunnelled));
  check('verify.probePort sees the port open', (await verifyLib.probePort()) === true);
  try { proc.kill(); } catch (e) {}
  await new Promise((r) => setTimeout(r, 700));

  section('VERIFY RETRIES (a cold Reality handshake measured ~8s here)');
  const src = fs.readFileSync(path.join(APP, 'lib', 'verify.js'), 'utf8');
  check('verify retries before declaring failure', /TRIES\s*=\s*[3-9]/.test(src));
  check('per-request timeout raised past 8s', /viaProxy\(url, timeout = (\d{5,})/.test(src) && Number(/viaProxy\(url, timeout = (\d{5,})/.exec(src)[1]) > 12000);
  check('failure message reports how many attempts ran', /attempts/.test(src));

  section('CRASH SAFETY / SYSTEM PROXY');
  const before = await proxy.status();
  const wasEnabled = before.enabled, wasServer = before.proxyServer;
  const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  execFileSync('reg.exe', ['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', '127.0.0.1:10809', '/f'], { windowsHide: true });
  execFileSync('reg.exe', ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'], { windowsHide: true });
  const reaped = await proxy.reapStale();
  check('stale proxy pointing at a dead port is cleared', reaped.reaped === true, JSON.stringify(reaped));
  const after = await proxy.status();
  check('ProxyEnable restored', after.enabled === wasEnabled, JSON.stringify(after));
  check('ProxyServer preserved', after.proxyServer === wasServer, after.proxyServer + ' vs ' + wasServer);
  execFileSync('reg.exe', ['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', '127.0.0.1:9999', '/f'], { windowsHide: true });
  execFileSync('reg.exe', ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f'], { windowsHide: true });
  const foreign = await proxy.reapStale();
  check('a proxy the app does not own is left alone', foreign.reaped === false, JSON.stringify(foreign));
  execFileSync('reg.exe', ['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', wasEnabled ? '1' : '0', '/f'], { windowsHide: true });
  if (wasServer) execFileSync('reg.exe', ['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', wasServer, '/f'], { windowsHide: true });

  section('UI: NOTICE BANNER MUST NOT SWALLOW THE LAYOUT');
  const css = fs.readFileSync(path.join(APP, 'renderer', 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(APP, 'renderer', 'index.html'), 'utf8');
  check('notice lives outside .grid', /<div class="notice"[^>]*>\s*<!--[\s\S]*?-->\s*<\/div>\s*<main class="grid">/.test(html) || html.indexOf('id="notice"') < html.indexOf('class="grid"'));
  check('notice cannot absorb spare height', /\.notice\{[^}]*flex:0 0 auto/.test(css));
  check('globe canvas present', /id="globe"/.test(html));
  check('country geometry shipped', fs.statSync(path.join(APP, 'renderer', 'countries.js')).size > 500000);

  section('RUNTIME COMPATIBILITY (Electron 31 / Chromium 126 / Node 20)');
  const rjs = fs.readFileSync(path.join(APP, 'renderer', 'app.js'), 'utf8');
  const mjs = fs.readFileSync(path.join(APP, 'main.js'), 'utf8');
  check('main: single instance lock used', /requestSingleInstanceLock/.test(mjs));
  check('main: no blanket taskkill of every xray.exe', !/\['\/IM',\s*'xray\.exe'/.test(mjs));
  check('main: cleanup targets only the core it started', /runner\.proc|\['\/PID'/.test(mjs));
  check('renderer: no direct main-process API misuse', !/require\(['"]electron['"]\)/.test(rjs));

  console.log(`\n===== ${pass} passed, ${fail} failed =====\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });