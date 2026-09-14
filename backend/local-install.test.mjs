import assert from 'node:assert/strict';
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import test from 'node:test';

const execFileAsync = promisify(execFile);

test('local installer enables an email-free profile without a fake owner address', async () => {
  const installer = await readFile(new URL('../scripts/install-local.sh', import.meta.url), 'utf8');

  assert.match(installer, /export MIAOS_LOCAL_PROFILE="\\\$\{MIAOS_LOCAL_PROFILE:-1\}"/);
  assert.match(installer, /export INSTANCE_DOMAINS="\\\$\{INSTANCE_DOMAINS:-localhost\}"/);
  assert.doesNotMatch(installer, /export MIAOS_SINGLE_USER_EMAIL=/);
  assert.doesNotMatch(installer, /export ADMIN_EMAILS=/);
});

test('local installer pins Ghost CLI and exposes only the Mia in-app browser connector', async () => {
  const installer = await readFile(new URL('../scripts/install-local.sh', import.meta.url), 'utf8');
  const verifier = await readFile(new URL('../scripts/verify-local-install.sh', import.meta.url), 'utf8');
  const cleanup = await readFile(new URL('../scripts/clean-local-install.sh', import.meta.url), 'utf8');
  const release = await readFile(new URL('../scripts/ghost-release.env', import.meta.url), 'utf8');
  const adapter = await readFile(new URL('./miaos-ghost-cli.py', import.meta.url), 'utf8');

  assert.match(release, /GHOST_COMMIT="[0-9a-f]{40}"/);
  assert.match(installer, /fetch --quiet --depth 1 origin "\$GHOST_COMMIT"/);
  assert.match(installer, /in_app_browser_transport\.py/);
  assert.match(installer, /cat > "\$local_bin\/ghost-cli"/);
  assert.match(installer, /cat > "\$local_bin\/miaos-desktop"/);
  assert.match(installer, /export HERMES_PYTHON="\$hermes_install_dir\/venv\/bin\/python"/);
  assert.match(installer, /app_install_dir="\$local_share\/miaos\/app"/);
  assert.match(installer, /electron" \. --user-data-dir="\$miaos_home\/electron"/);
  assert.match(installer, /export GHOST_MIA_SOCKET="\$miaos_home\/ghost-bridge\.sock"/);
  assert.match(installer, /export GHOST_MIA_TOKEN_FILE="\$miaos_home\/ghost-bridge\.token"/);
  assert.match(installer, /export GHOST_IN_APP_BROWSER_SOCKET="\$miaos_home\/ghost-bridge\.sock"/);
  assert.match(installer, /export GHOST_IN_APP_BROWSER_TOKEN_FILE="\$miaos_home\/ghost-bridge\.token"/);
  assert.match(installer, /git -C "\$repo_root" ls-files -z -- backend frontend macos modules/);
  assert.doesNotMatch(installer, /cp -a "\$repo_root\/\$area"/);
  assert.match(installer, /exec "\$app_install_dir\/macos\/node_modules\/\.bin\/electron"/);
  assert.match(verifier, /launcher still references the source checkout/);
  assert.match(installer, /mia-512-linux\.png/);
  assert.match(installer, /StartupWMClass=miaos/);
  assert.match(installer, /Unexpected configured credential file/);
  assert.match(verifier, /Ghost in-app browser connector is missing/);
  assert.match(verifier, /Mia Linux application icon is missing/);
  assert.match(verifier, /Mia Electron runtime is missing/);
  assert.match(cleanup, /ghost-cli/);
  assert.match(cleanup, /\*"\/server\.js"\*/);
  assert.match(cleanup, /--system/);
  assert.match(cleanup, /for package_name in mia miaos/);
  assert.match(cleanup, /dpkg --purge "\$package_name"/);
  assert.match(cleanup, /\/opt\/miaos/);
  assert.match(cleanup, /\/usr\/bin\/ghost-cli/);
  assert.match(cleanup, /pgrep -f '\^\/opt\/miaos\/'/);
  assert.match(cleanup, /\$local_share\/miaos/);
  assert.match(cleanup, /--all/);
  assert.match(cleanup, /getent passwd "\$SUDO_USER"/);
  assert.match(adapter, /SUPPORTED_METHODS/);
  assert.doesNotMatch(adapter, /import\s+playwright|subprocess|launch\(/i);
});

test('local installer bundles first-turn dependencies and the guarded bot command', async () => {
  const installer = await readFile(new URL('../scripts/install-local.sh', import.meta.url), 'utf8');
  const verifier = await readFile(new URL('../scripts/verify-local-install.sh', import.meta.url), 'utf8');
  const cleanup = await readFile(new URL('../scripts/clean-local-install.sh', import.meta.url), 'utf8');

  assert.match(installer, /uv" pip install[\s\S]*boto3==1\.42\.89[\s\S]*edge-tts==7\.2\.7/);
  assert.match(installer, /cat > "\$local_bin\/miaos-bot"/);
  assert.match(installer, /modules\/bot-creation\/scripts\/miaos-bot\.js/);
  assert.match(verifier, /Mia bot launcher is missing/);
  assert.match(cleanup, /miaos-bot/);
});

test('source workflows isolate Mia runtimes and preserve an existing Hermes installation', async () => {
  const cleanup = await readFile(new URL('../scripts/clean_slate_mac.sh', import.meta.url), 'utf8');
  const installer = await readFile(new URL('../scripts/install-local-mac.sh', import.meta.url), 'utf8');
  const linuxInstaller = await readFile(new URL('../scripts/install-local.sh', import.meta.url), 'utf8');
  const linuxCleanup = await readFile(new URL('../scripts/clean-local-install.sh', import.meta.url), 'utf8');

  // Legacy Mia product paths remain cleanup targets, but standalone Hermes
  // state and launchers are never selected.
  assert.match(cleanup, /\/Applications\/MiaOS\.app/);
  assert.match(cleanup, /Library\/Application Support\/MiaOS/);
  assert.doesNotMatch(cleanup, /Library\/Application Support\/Hermes/);
  assert.doesNotMatch(cleanup, /"\$user_home\/\.hermes"/);
  assert.doesNotMatch(cleanup, /launcher_names=\([^)]*hermes/);
  assert.match(cleanup, /ghost-cli/);
  assert.match(cleanup, /--verify/);
  assert.match(cleanup, /Clean-slate verification passed/);
  assert.match(cleanup, /Source repositories, DMG files/);
  assert.doesNotMatch(cleanup, /Documents\/MiaOS/);
  assert.doesNotMatch(installer, /--skip-runtimes/);
  assert.match(installer, /always provisions fresh pinned runtimes/);
  assert.match(installer, /hermes_home="\$miaos_home\/hermes"/);
  assert.match(installer, /Preserving existing Hermes installation/);
  assert.doesNotMatch(installer, /for stage in [^\n]*\bpath\b/);
  assert.match(linuxInstaller, /hermes_home="\$local_share\/miaos\/hermes"/);
  assert.match(linuxInstaller, /mia_runtime_bin="\$local_share\/miaos\/bin"/);
  assert.match(linuxInstaller, /Preserving existing Hermes installation/);
  assert.doesNotMatch(linuxInstaller, /for stage in [^\n]*\bpath\b/);
  assert.doesNotMatch(linuxCleanup, /hermes_home="\$user_home\/\.hermes"/);
  assert.doesNotMatch(linuxCleanup, /for name in hermes hermes-agent hermes-acp/);
});

test('macOS clean slate never selects the active source checkout as temporary runtime state', async (t) => {
  const sourceScript = new URL('../scripts/clean_slate_mac.sh', import.meta.url);
  const sourceRoot = await mkdtemp(join(tmpdir(), 'miaos-clean-source-'));
  const scriptsRoot = join(sourceRoot, 'scripts');
  const copiedScript = join(scriptsRoot, 'clean_slate_mac.sh');
  t.after(() => rm(sourceRoot, { recursive: true, force: true }));
  await mkdir(scriptsRoot);
  await copyFile(sourceScript, copiedScript);
  await chmod(copiedScript, 0o755);

  const { stdout } = await execFileAsync('bash', [copiedScript]);
  assert.doesNotMatch(stdout, new RegExp(`Would remove: ${sourceRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\n|$)`));
});

test('Linux package validates and refreshes pinned runtimes and emits release integrity metadata', async () => {
  const packager = await readFile(new URL('../macos/scripts/package-linux.cjs', import.meta.url), 'utf8');
  const macPackager = await readFile(new URL('../macos/scripts/package-mac.cjs', import.meta.url), 'utf8');
  const pythonRelease = await readFile(new URL('../scripts/python-release.env', import.meta.url), 'utf8');

  assert.match(packager, /requiredPinnedDirectory\("HERMES_BUNDLE_DIR"/);
  assert.match(packager, /requiredPinnedDirectory\("GHOST_BUNDLE_DIR"/);
  assert.match(packager, /requiredPythonRuntime\(\)/);
  assert.match(packager, /sync_bundle \/opt\/miaos\/hermes/);
  assert.match(packager, /sync_bundle \/opt\/miaos\/ghost-cli/);
  assert.match(packager, /path\.join\(installRoot, "bin", "hermes"\)/);
  assert.match(packager, /fs\.symlinkSync\("\.\.\/\.\.", path\.join\(installRoot, "app", "resources", "runtime"\)\)/);
  assert.match(packager, /export HERMES_PYTHON="\\\$\{hermes_home\}\/hermes-agent\/venv\/bin\/python"/);
  assert.match(packager, /path\.join\(packageRoot, "usr", "bin", "ghost-cli"\)/);
  assert.match(packager, /path\.join\(packageRoot, "usr", "bin", "mia"\)/);
  assert.match(packager, /Package: mia\\n/);
  assert.match(packager, /Name=Mia\\nExec=mia\\n/);
  assert.match(packager, /`Mia_\$\{VERSION\}_amd64\.deb`/);
  assert.match(packager, /\/opt\/miaos\/app\/resources\/backend\/miaos-ghost-cli\.py/);
  assert.doesNotMatch(packager, /ghost-cli\/ghost_cli\.py/);
  assert.doesNotMatch(packager, /if \[\[ ! -x "\\\$\{hermes_home\}\/hermes-agent\/hermes" \]\]; then/);
  assert.match(packager, /\.sha256/);
  assert.match(packager, /\.spdx\.json/);
  assert.match(packager, /pruneHermesBundle/);
  assert.match(packager, /copyPortableRuntime\(hermesBundle/);
  assert.match(packager, /pruneGhostBundle\(stagedGhost\)/);
  assert.match(packager, /assertNoRuntimeState\(installRoot\)/);
  assert.match(macPackager, /Sensitive tracked source cannot be packaged/);
  assert.match(packager, /assertNoPrivateBuildPaths\(packageRoot/);
  assert.match(packager, /cwd: appSource/);
  assert.match(macPackager, /cwd: appSource/);
  assert.match(packager, /"better-sqlite3", "build"/);
  assert.match(packager, /chown root:root \/opt\/miaos\/app\/chrome-sandbox/);
  assert.match(packager, /chmod 4755 \/opt\/miaos\/app\/chrome-sandbox/);
  assert.match(pythonRelease, /PYTHON_BUILD="[0-9]+"/);
  assert.match(pythonRelease, /PYTHON_EXECUTABLE_SHA256="[0-9a-f]{64}"/);
  assert.match(pythonRelease, /PYTHON_LIBRARY_SHA256="[0-9a-f]{64}"/);
});
