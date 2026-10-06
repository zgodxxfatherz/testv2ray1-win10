'use strict';
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { HTTP_PORT, SOCKS_PORT } = require('./core');

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
// Its own folder: the Win7 build backs up to %APPDATA%\testv2ray1-win7 and the
// dev build to %APPDATA%\testv2ray1. Three builds must not share one backup.
const BACKUP = path.join(process.env.APPDATA || '', 'testv2ray1-win10', 'proxy-backup.json');

function reg(args) {
  return new Promise((resolve) => {
    execFile('reg.exe', args, { windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

function parseRegDump(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    // reg query prints e.g. "    ProxyEnable    REG_DWORD    0x1"
    const m = line.match(/^\s{4}(\S+)\s{4}(REG_\S+)\s{4}(.*)$/);
    if (m) out[m[1]] = { type: m[2], value: m[3].trim() };
  }
  return out;
}

async function readSettings() {
  const r = await reg(['query', KEY]);
  if (r.code !== 0) return null;
  return parseRegDump(r.stdout);
}

async function saveBackup() {
  const s = await readSettings();
  if (!s) return null;
  fs.mkdirSync(path.dirname(BACKUP), { recursive: true });
  const payload = {};
  for (const k of ['ProxyServer', 'ProxyEnable', 'ProxyOverride']) if (s[k]) payload[k] = s[k];
  if (Object.keys(payload).length) fs.writeFileSync(BACKUP, JSON.stringify(payload, null, 2));
  return payload;
}

async function restoreBackup() {
  let payload = null;
  try { payload = JSON.parse(fs.readFileSync(BACKUP, 'utf8')); } catch (e) { payload = null; }
  const set = async (name, type, value) => {
    if (!value) return;
    const r = await reg(['add', KEY, '/v', name, '/t', type, '/d', String(value), '/f']);
    if (r.code !== 0) throw new Error(`reg add ${name} failed: ${(r.stderr || r.stdout).trim()}`);
  };
  if (payload && payload.ProxyServer) await set('ProxyServer', payload.ProxyServer.type, payload.ProxyServer.value);

  if (payload && payload.ProxyOverride) await set('ProxyOverride', payload.ProxyOverride.type, payload.ProxyOverride.value);

  if (payload && payload.ProxyEnable) await set('ProxyEnable', payload.ProxyEnable.type, payload.ProxyEnable.value);
  else await set('ProxyEnable', 'REG_DWORD', '0x0');

  // Deliberately do NOT delete ProxyServer / ProxyOverride when there is no
  // backup. A disabled-but-present ProxyServer is a normal pre-existing state,
  // and wiping it would destroy the user's own setting. enable() always writes a
  // backup before arming, so "no backup" means "we did not set this".
  await notifyWinInet();
  return payload;
}

// Tell WinINET/Explorer that proxy settings changed so Chrome/Edge/Telegram pick it up live.
function notifyWinInet() {
  return new Promise((resolve) => {
    const ps = `$sig = @'
[DllImport("wininet.dll", SetLastError=true, CharSet=CharSet.Auto)]
public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);
'@
$s = Add-Type -MemberDefinition $sig -Name W -Namespace N -PassThru
$opt = 39; $opt2 = 37
[N]::W::InternetSetOption([IntPtr]::Zero, $opt, [IntPtr]::Zero, 0) | Out-Null
[N]::W::InternetSetOption([IntPtr]::Zero, $opt2, [IntPtr]::Zero, 0) | Out-Null
Write-Output "ok"`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true }, () => resolve());
  });
}

async function enable() {
  await saveBackup();
  const proxyServer = `127.0.0.1:${HTTP_PORT}`;
  const override = 'localhost;127.*;<local>';
  await reg(['add', KEY, '/v', 'ProxyServer', '/t', 'REG_SZ', '/d', proxyServer, '/f']);
  await reg(['add', KEY, '/v', 'ProxyOverride', '/t', 'REG_SZ', '/d', override, '/f']);
  await reg(['add', KEY, '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '1', '/f']);
  await notifyWinInet();
  return { enabled: true, proxyServer, override, httpPort: HTTP_PORT, socksPort: SOCKS_PORT };
}

async function disable() {
  await restoreBackup();
  return { enabled: false };
}

async function status() {
  const s = await readSettings();
  if (!s) return { enabled: false, proxyServer: null };
  const enabled = s.ProxyEnable && s.ProxyEnable.value === '0x1';
  return {
    enabled,
    proxyServer: s.ProxyServer ? s.ProxyServer.value : null,
    override: s.ProxyOverride ? s.ProxyOverride.value : null,
  };
}

// If the app was killed or crashed, nothing ran disable() and Windows is still
// pointing every app at a proxy that no longer exists - the machine looks
// offline. On startup, clear that: our proxy target with nothing listening is
// by definition ours and stale.
async function reapStale(timeout = 1500) {
  const s = await status();
  if (!s.enabled) return { reaped: false, reason: 'system proxy was already off' };
  const ours = new RegExp(`127\\.0\\.0\\.1:${HTTP_PORT}`);
  if (!ours.test(s.proxyServer || '')) {
    return { reaped: false, reason: `proxy points at ${s.proxyServer} - not ours, left alone` };
  }
  const net = require('net');
  const alive = await new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (e) {} resolve(v); };
    sock.setTimeout(timeout);
    sock.once('connect', () => fin(true));
    sock.once('timeout', () => fin(false));
    sock.once('error', () => fin(false));
    try { sock.connect(HTTP_PORT, '127.0.0.1'); } catch (e) { fin(false); }
  });
  if (alive) {
    // Something is listening: a core from a previous run that we can adopt.
    return { reaped: false, reason: `127.0.0.1:${HTTP_PORT} is still listening` };
  }
  await restoreBackup();
  return { reaped: true, reason: `cleared a stale system proxy (nothing on 127.0.0.1:${HTTP_PORT})` };
}

module.exports = { enable, disable, status, reapStale, notifyWinInet, readSettings };
