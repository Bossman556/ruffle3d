// Builds Ruffle3D and produces everything the website needs:
//   website/app/                              the hosted web app ("Launch in browser", installable PWA)
//   website/downloads/Ruffle3D-<ver>-<os>.zip one offline package per platform (windows, mac, linux)
//   website/downloads/Ruffle3D-<ver>.zip      the same with every launcher
//   website/downloads/latest.json             version, size and SHA-256 shown on the download page
// Usage: npm run package
import { build } from 'vite';
import { readFileSync, writeFileSync, rmSync, cpSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zip } from './zip.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const version = pkg.version;
const dist = path.join(root, 'dist');
const site = path.join(root, 'website');

console.log(`Building Ruffle3D ${version}…`);
await build({ root, logLevel: 'warn' });

// stamp the offline cache so installed apps pick up the new build
const swFile = path.join(dist, 'sw.js');
writeFileSync(swFile, readFileSync(swFile, 'utf8').replace('__VERSION__', `${version}-${Date.now().toString(36)}`));

// hosted copy for the website
rmSync(path.join(site, 'app'), { recursive: true, force: true });
cpSync(dist, path.join(site, 'app'), { recursive: true });

// offline package
const walk = (dir) => readdirSync(dir).flatMap((n) => { const p = path.join(dir, n); return statSync(p).isDirectory() ? walk(p) : [p]; });
const top = `Ruffle3D-${version}`;
const L = path.join(root, 'scripts', 'launchers');
const readme = `Ruffle3D ${version}
==============

Parametric solid and free-form NURBS surface modelling for product design.

Start
-----
Windows:  double-click "Start Ruffle3D (Windows).cmd"
macOS:    double-click "Start Ruffle3D (macOS).command"
          (first time: right-click → Open, because the file is not notarised)
Linux:    run ./start-ruffle3d.sh

The launcher starts a small local web server on http://localhost:47830 and opens Ruffle3D in your
default browser. Nothing is sent over the internet; your projects stay on this computer (stored by
your browser for that address). Use Chrome, Edge, Firefox or Safari (2023 or newer).

macOS and Linux need Node.js or Python 3 (most Linux systems have Python 3 already).

Licences for the open-source components are in the licenses folder.

Tip: in Chrome or Edge choose "Install Ruffle3D" from the address bar to get a desktop window and an
app icon. The installed app keeps working offline.
`;
const common = [
  ...walk(dist).map((f) => ({ name: `${top}/app/${path.relative(dist, f).split(path.sep).join('/')}`, data: readFileSync(f) })),
  { name: `${top}/README.txt`, data: Buffer.from(readme.replace(/\n/g, '\r\n')) },
  // third-party licence texts (required by the LGPL, MIT, ISC and OFL licences)
  ...readdirSync(path.join(root, 'site', 'assets', 'licenses')).map((n) => ({ name: `${top}/licenses/${n}`, data: readFileSync(path.join(root, 'site', 'assets', 'licenses', n)) })),
];
// Code signing (optional). Windows: set RUFFLE_SIGN_PFX to a code-signing certificate (.pfx) and
// RUFFLE_SIGN_PASSWORD to its password; the PowerShell launcher is then Authenticode-signed with a
// timestamp, so it runs under the AllSigned policy and shows your name as publisher. macOS: set
// RUFFLE_MAC_IDENTITY (a "Developer ID Application" identity in your keychain) and build on a Mac to
// sign the launcher with codesign. Without these variables the packages are built unsigned.
function signWindows(file) {
  const pfx = process.env.RUFFLE_SIGN_PFX;
  if (!pfx) return readFileSync(file);
  const tmp = path.join(root, 'dist', `signed-${path.basename(file)}`);
  cpSync(file, tmp);
  const ps = `$c = Get-PfxCertificate -FilePath '${pfx.replace(/'/g, "''")}' -Password (ConvertTo-SecureString $env:RUFFLE_SIGN_PASSWORD -AsPlainText -Force); $r = Set-AuthenticodeSignature -FilePath '${tmp.replace(/'/g, "''")}' -Certificate $c -TimestampServer 'http://timestamp.digicert.com' -HashAlgorithm SHA256; if ($r.Status -ne 'Valid') { throw $r.StatusMessage }`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Signing ${path.basename(file)} failed: ${(r.stderr || r.stdout || '').trim()}`);
  console.log(`Signed ${path.basename(file)}`);
  return readFileSync(tmp);
}
function signMac(file) {
  const id = process.env.RUFFLE_MAC_IDENTITY;
  if (!id || process.platform !== 'darwin') return readFileSync(file);
  const tmp = path.join(root, 'dist', `signed-${path.basename(file)}`);
  cpSync(file, tmp);
  const r = spawnSync('codesign', ['--force', '--timestamp', '--sign', id, tmp], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`codesign failed: ${(r.stderr || '').trim()}`);
  console.log(`Signed ${path.basename(file)} for macOS`);
  return readFileSync(tmp);
}
const launch = {
  windows: [
    { name: `${top}/Start Ruffle3D (Windows).cmd`, data: readFileSync(path.join(L, 'Start Ruffle3D (Windows).cmd')) },
    { name: `${top}/server.ps1`, data: signWindows(path.join(L, 'server.ps1')) },
  ],
  mac: [
    { name: `${top}/Start Ruffle3D (macOS).command`, data: signMac(path.join(L, 'start.sh')), mode: 0o100755 },
    { name: `${top}/serve.mjs`, data: readFileSync(path.join(root, 'scripts', 'serve.mjs')) },
  ],
  linux: [
    { name: `${top}/start-ruffle3d.sh`, data: readFileSync(path.join(L, 'start.sh')), mode: 0o100755 },
    { name: `${top}/serve.mjs`, data: readFileSync(path.join(root, 'scripts', 'serve.mjs')) },
  ],
};
const downloads = path.join(site, 'downloads');
mkdirSync(downloads, { recursive: true });
for (const f of readdirSync(downloads)) if (/^Ruffle3D-.*\.(zip|exe|dmg|AppImage|deb)$/.test(f)) rmSync(path.join(downloads, f));
const write = (file, entries) => {
  const buf = zip(entries);
  writeFileSync(path.join(downloads, file), buf);
  return { file, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
};
// one package per platform, plus one with every launcher
const platforms = {};
for (const [os, extra] of Object.entries(launch)) platforms[os] = write(`${top}-${os}.zip`, [...common, ...extra]);
const all = write(`${top}.zip`, [...common, ...launch.windows, ...launch.mac, launch.linux[0]]);
// desktop installers (Electron): the Windows setup is built here on Windows; macOS and Linux builds
// run on those systems (see .github/workflows/desktop.yml). Skip with --no-installer.
const installers = {};
if (!process.argv.includes('--no-installer')) {
  const targets = { win32: '--win', darwin: '--mac', linux: '--linux' }[process.platform];
  console.log('Building the desktop installer…');
  // build outside synced folders (OneDrive and similar lock files while the builder renames them)
  const out = path.join(process.env.LOCALAPPDATA || tmpdir(), 'ruffle3d-build', 'release');
  rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', targets, '--publish', 'never', `--config.directories.output="${out}"`], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: process.env.CSC_LINK ? 'true' : 'false' } });
  if (r.status !== 0) throw new Error('The desktop installer build failed');
  for (const f of readdirSync(out)) {
    if (!/\.(exe|dmg|AppImage|deb)$/.test(f)) continue;
    const buf = readFileSync(path.join(out, f));
    writeFileSync(path.join(downloads, f), buf);
    const os = /\.exe$/.test(f) ? 'windows' : /\.dmg$/.test(f) ? 'mac' : /\.deb$/.test(f) ? 'linuxDeb' : 'linux';
    installers[os] = { file: f, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
    console.log(`website/downloads/${f} (${(buf.length / 1e6).toFixed(1)} MB)`);
  }
}
const info = { version, ...all, date: new Date().toISOString().slice(0, 10), platforms, installers };
writeFileSync(path.join(downloads, 'latest.json'), JSON.stringify(info, null, 2));
const file = all.file, zipBuf = { length: all.bytes };
console.log(`website/app/ updated · website/downloads/${file} (${(zipBuf.length / 1e6).toFixed(1)} MB)`);
// rebuild the website pages so the version, size and checksum stay in sync
await import('./build-site.mjs');
