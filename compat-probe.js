'use strict';
// Which transports does the bundled modern core accept?
// Answers with the real binary, not a version table.
const path = require('path');
const caps = require('./resources/app/lib/capabilities');

const info = caps.coreVersion(caps.coreDir());
console.log('bundled core: Xray ' + info.version + '  (' + info.arch + ')');
console.log('  ' + info.raw + '\n');

const { servers } = require('./resources/app/lib/parse').parseBulk(
  ['vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&type=tcp',
   'vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&type=ws&path=%2F',
   'vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&type=grpc&serviceName=p',
   'vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&type=h2&path=%2F',
   'vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&type=httpupgrade&path=%2F',
   'vless://00000000-0000-0000-0000-000000000000@example.com:443?encryption=none&type=xhttp&path=%2F',
  ].join('\n'));

console.log('== transports, built by lib/core.js then validated by the core ==');
let pass = 0, fail = 0;
const { buildOutbound } = require('./resources/app/lib/core');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const tmp = path.join(os.tmpdir(), 't1-compat');
fs.mkdirSync(tmp, { recursive: true });
const dir = caps.coreDir();

for (const s of servers) {
  let ob;
  try { ob = buildOutbound(s); }
  catch (e) { fail++; console.log('  BUILD-FAIL  ' + s.network + '  -> ' + e.message.slice(0, 90)); continue; }
  const cfg = {
    log: { loglevel: 'error' },
    inbounds: [{ tag: 'in', port: 0, listen: '127.0.0.1', protocol: 'socks', settings: {} }],
    outbounds: [ob, { tag: 'direct', protocol: 'freedom', settings: {} }],
    routing: { rules: [] },
  };
  const f = path.join(tmp, s.network + '.json');
  fs.writeFileSync(f, JSON.stringify(cfg));
  const r = spawnSync(path.join(dir, 'xray.exe'), ['run', '-test', '-c', f],
    { encoding: 'utf8', cwd: dir, env: { ...process.env, XRAY_LOCATION_ASSET: dir } });
  const out = String(r.stdout || '') + String(r.stderr || '');
  if (r.status === 0 && /Configuration OK/.test(out)) { pass++; console.log('  OK    ' + s.network); }
  else {
    fail++;
    console.log('  FAIL  ' + s.network + '  -> ' + (out.split(/Failed to start:\s*/)[1] || '').trim().slice(0, 120));
  }
}

console.log('\n== startup capability probe (what the app will gate on) ==');
const r = caps.probe();
console.log('  probed ' + r.probed + ' transports');
console.log('  unsupported: ' + (r.unsupported.length ? r.unsupported.join(', ') : '(none)'));

console.log(`\n===== ${pass} accepted, ${fail} rejected =====\n`);