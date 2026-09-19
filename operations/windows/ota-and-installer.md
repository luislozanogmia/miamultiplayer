# Windows OTA Updates and Installer

Implementation spec for over-the-air updates and the installer story for the
Windows build of Mia. Written against:

- `macos/src/main.cjs` — `configureAutoUpdates()` / `checkForMiaUpdate()`
  (electron-updater 6.8.9, GitHub provider, owner `luislozanogmia`,
  repo `mia_multiplayer`).
- `macos/scripts/package-mac.cjs` — `writeUpdateFeed()` hand-generates
  `latest-mac.yml` + zip because the repo packages with `@electron/packager`,
  **not** electron-builder.
- `.github/workflows/windows-build.yml` — CI contract that runs
  `npm run package:win` (`macos/scripts/package-win.cjs`) and uploads
  `macos/dist/` artifacts.
- Releases are published with `gh release create` carrying the platform
  assets plus the electron-updater channel file(s).

Everything below was verified against electron-updater 6.x source
(`packages/electron-updater/src/NsisUpdater.ts`, `AppUpdater.ts`) and the
electron-builder auto-update docs (`website/docs/features/auto-update.md`).

---

## 1. What electron-updater requires on Windows

**Windows OTA support in electron-updater is NSIS-only.** The docs are
explicit: *"Squirrel.Windows is not supported. Simplified auto-update is
supported on Windows if you use the default NSIS target."*

Facts the implementation must respect:

- On `win32`, electron-updater instantiates `NsisUpdater`. There is **no zip
  updater class for Windows** (macOS uses zip via `MacUpdater`; Linux has
  AppImage/deb/rpm/pacman updaters). A zip-only Windows release **cannot be
  auto-updated** — a zip is a fine *distribution* artifact, but it is not an
  *update channel*.
- The GitHub provider on Windows fetches the channel file **`latest.yml`**
  (Windows equivalent of our `latest-mac.yml`) from the release, then
  downloads the NSIS installer `.exe` named in it, verifies the base64
  **sha512** from the yml, and finally spawns the installer.
- Installer spawn arguments (from `NsisUpdater.doInstall`):
  - `--updated` — always passed.
  - `/S` — when the install is silent (`quitAndInstall(true, …)` or the
    `autoInstallOnAppQuit` path, which always installs silently).
  - `--force-run` — when `quitAndInstall(…, true)`; the installer is expected
    to relaunch the app.
  - `/D=<dir>` — only if `autoUpdater.installDirectory` is set (we don't).
  - `--package-file=<path>` — web-installer target only (we don't use it).
- **Elevation:** if admin rights are required (or the spawn fails with
  `EACCES`), NsisUpdater runs `<resourcesPath>/elevate.exe <installer>`.
  electron-builder normally bundles `elevate.exe`; we do not. Therefore the
  installer **must be per-user** (`$LOCALAPPDATA\Programs\Mia`, HKCU registry
  only) so no elevation is ever needed.
- **Authenticode verification:** `NsisUpdater.verifySignature()` reads
  `publisherName` from the updater config. When `publisherName` is absent it
  logs a warning and **skips verification** (fail-open in 6.x; electron-builder
  has announced v28 will treat a missing `publisherName` as a failure — set it
  as soon as we sign). Because `main.cjs` calls `setFeedURL(options)`, the
  config is the options object we pass, so `publisherName` goes there — no
  `app-update.yml` needed (same as macOS today).
- **Differential updates** are optional. They require `.blockmap` assets;
  when absent, electron-updater logs a warning and falls back to a full
  installer download. Hand-rolled packaging ⇒ full downloads. Acceptable.
- **GitHub provider release resolution (important gotcha):** the provider
  resolves the *latest non-prerelease semver tag* for the whole repo and
  looks for `latest.yml` among **that release's** assets. Consequences:
  1. Windows and macOS assets must live on the **same `vX.Y.Z` release**
     (`latest.yml` and `latest-mac.yml` coexist fine). If Windows assets sat
     on a separate release, whichever release is "latest" would 404 for the
     other platform's channel file and the update check would error.
  2. The CI trigger tag `v0.2.8-win` parses as semver **prerelease**
     (`-win` suffix), so electron-updater ignores it by default
     (`allowPrerelease` is false). That tag is a build trigger only —
     **never** publish user-facing assets on a `v*-win` release.
- Asset naming: use **no spaces** in file names (GitHub rewrites spaces to
  dots in asset URLs, which breaks the `url:` match). Convention here:
  `Mia-Setup-<version>-x64.exe`.

Supported-target summary for the record: NSIS ✅ (full support), NSIS web
installer ✅ (not used), Squirrel.Windows ❌, MSI ❌, AppX ❌ (Store updates
only), portable/zip ❌.

## 2. Producing the NSIS installer without electron-builder

### Options considered

| Path | Verdict |
| --- | --- |
| **A. `makensis` directly with a checked-in `.nsi` script** | **Recommended.** Matches the repo's hand-rolled style (we already hand-generate `latest-mac.yml`, DMG via `create-dmg.cjs`, notarization by hand). NSIS 3.x is preinstalled on GitHub `windows-latest` runners, so CI needs no extra install step. The NsisUpdater contract (Section 1) is small and fully known. |
| B. electron-builder used solely as the NSIS step (`electron-builder --win nsis --prepackaged <dir>`) | Works and auto-emits `latest.yml` + blockmaps, but reintroduces the dependency the repo deliberately avoids, fights `assertCleanReleaseCheckout` (it wants its own dirs/config), and its installer script assumes electron-builder's resource layout (`app-update.yml`, `elevate.exe`). Keep as fallback if the hand-rolled installer misbehaves. |
| C. Squirrel.Windows | Rejected: electron-updater does not support it; it would mean `RELEASES` + `.nupkg` and a different updater (`electron.autoUpdater`), forking the whole update code path. |

### 2a. The `.nsi` contract (what the script MUST do)

Check in `macos/scripts/installer.nsi`. Hard requirements, each traced to the
NsisUpdater behavior in Section 1:

1. **Per-user install, no elevation.**
   `RequestExecutionLevel user`; `InstallDir "$LOCALAPPDATA\Programs\Mia"`.
   All registry writes under **HKCU** only
   (`HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Mia`:
   `DisplayName`, `DisplayVersion`, `DisplayIcon`, `Publisher`,
   `UninstallString`, `InstallLocation`, `EstimatedSize`). Never write HKLM.
2. **Silent mode must fully work.** `/S` is NSIS-native; the script must not
   call `MessageBox` or any page that blocks in silent mode. The
   `autoInstallOnAppQuit` path always installs with `/S` and no relaunch.
3. **Ignore `--updated` gracefully.** NSIS ignores unrecognized arguments
   unless the script reads `$CMDLINE`, so nothing to do — but do not error on
   unknown args.
4. **Implement `--force-run`.** Read `${GetParameters}` /
   `${GetOptions}`-style parsing of `$CMDLINE`; if `--force-run` is present,
   `Exec '"$INSTDIR\Mia.exe"'` at the end of the install section (use
   `Exec`, not `ExecWait`). Without this, "Restart and install" would install
   but never bring Mia back.
5. **Handle a (still-)running Mia.** The app quits before install, but file
   locks can linger. Loop up to ~15s: try `Delete "$INSTDIR\Mia.exe"`
   (or `nsProcess`/`FindProcDLL` if we vendor a plugin — prefer plugin-free:
   retry `ClearErrors` / `Delete` with `Sleep 1000`). Abort with exit code ≠ 0
   only after the timeout so electron-updater can surface the failure.
6. **Clean upgrade semantics.** `RMDir /r "$INSTDIR"` of the previous payload
   before copying (the app keeps user data in `%APPDATA%\Mia` /
   `app.getPath("userData")`, never under `$INSTDIR`, so this is safe), then
   `File /r "${APPDIR}\*"`.
7. **Shortcuts + uninstaller.** Start-menu shortcut always; desktop shortcut
   on first install only (skip when `--updated` is present, to respect a
   user's deletion). `WriteUninstaller "$INSTDIR\Uninstall Mia.exe"`;
   uninstaller must also support `/S` and must **not** delete
   `%APPDATA%\Mia`.
8. **Parameterization.** Build with
   `makensis /DVERSION=<v> /DAPPDIR=<packaged dir> /DOUTFILE=<dist>\Mia-Setup-<v>-x64.exe installer.nsi`
   — no versions hardcoded in the script. Set `Unicode true`,
   `SetCompressor /SOLID lzma`, `Name "Mia"`, icon from
   `macos/assets` (a `.ico` must be added; generate from `mia-512.png` with
   `png2ico`/ImageMagick during packaging or check it in).

### 2b. `package-win.cjs` `writeUpdateFeed` equivalent

Mirror `package-mac.cjs` exactly, substituting the installer for the zip.
The mac function for reference produces:

```yaml
version: ${VERSION}
files:
  - url: ${zipName}
    sha512: ${sha512}      # base64 of SHA-512 digest
    size: ${size}          # bytes
path: ${zipName}
sha512: ${sha512}
releaseDate: '2026-…ISO…'
```

Windows version — write **`latest.yml`** (not `latest-win.yml`; electron-updater
hardcodes `latest.yml` as the Windows channel file name):

```js
// electron-updater consumes an NSIS installer plus latest.yml from the
// GitHub release; both must be uploaded as release assets alongside the zip.
function writeUpdateFeed(installerPath) {
  const installerName = path.basename(installerPath); // Mia-Setup-<v>-x64.exe
  const size = fs.statSync(installerPath).size;
  const sha512 = crypto.createHash("sha512").update(fs.readFileSync(installerPath)).digest("base64");
  fs.writeFileSync(path.join(DIST_ROOT, "latest.yml"), [
    `version: ${VERSION}`,
    "files:",
    `  - url: ${installerName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${installerName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n"));
  return installerPath;
}
```

Field semantics (identical to mac): `version` plain semver, no `v` prefix;
`files[].url` is the bare asset filename (the GitHub provider resolves it
against the release's download URL); `sha512` is **base64**, not hex;
`size` in bytes; legacy top-level `path`/`sha512` duplicate `files[0]` for
older updater compatibility — keep them; `releaseDate` single-quoted ISO-8601.

Build order inside `buildInstaller()` for Windows (ordering matters because
hashes must be computed over the **final, signed** bytes):

1. `packager({ platform: "win32", arch: "x64", icon: <ico>, … })` — same
   staging as mac (backend/frontend/modules/runtime as `extraResource`).
2. *(when signing is live)* Sign `Mia.exe` inside the packaged dir (§3).
3. `makensis` → `dist/Mia-Setup-${VERSION}-x64.exe`.
4. *(when signing is live)* Sign the installer `.exe`.
5. `writeUpdateFeed(installerPath)` → `dist/latest.yml`. **Never** re-touch
   the exe after this step.
6. Keep the existing zip step (`dist/Mia-${VERSION}-x64-win.zip` + `.sha256`)
   as a portable/no-install artifact if desired — it is not an update channel.

CI (`windows-build.yml`): extend the artifact upload globs with
`macos/dist/*.exe` and `macos/dist/latest.yml`. `makensis` is already on
`windows-latest`; add `makensis /VERSION` to the verify step if paranoid.

## 3. Code signing on Windows

### Unsigned behavior (state we ship in until signing lands)

- **First install:** the user downloads `Mia-Setup-…exe` in a browser, which
  stamps Mark-of-the-Web ⇒ SmartScreen shows "Windows protected your PC"
  (Unknown publisher). The user must click *More info → Run anyway*.
  Occasional Defender heuristic flags are possible for unsigned Electron
  installers.
- **OTA updates still work unsigned.** electron-updater downloads with Node's
  HTTP stack (no MOTW zone identifier is written), verifies the yml's sha512,
  and spawns the installer directly — SmartScreen does not interpose, and
  with `publisherName` unset the Authenticode check is skipped (warning
  logged). So: SmartScreen friction is a **first-install** problem, not an
  update problem, under electron-updater 6.x. (Do not rely on this forever —
  see the v28 fail-closed note in §1.)

### Azure Trusted Signing (recommended signing path)

- **Setup:** Azure subscription → create a *Trusted Signing* account in a
  supported region (e.g. East US) → complete **identity validation** →
  create a *certificate profile* (Public Trust) → grant the signing identity
  the *Trusted Signing Certificate Profile Signer* role.
- **Eligibility/timeline:** organizations need a verifiable legal identity
  (Microsoft currently requires ~3+ years of verifiable business history for
  org public trust; individual-developer validation exists but availability
  has been restricted/preview — verify current policy at signup). Azure-side
  setup is under an hour; identity validation is typically 1–5 business
  days, longer if documents are requested.
- **Cost:** Basic tier ≈ **$9.99/month** (5,000 signatures/mo), Premium
  ≈ $99.99/month. Certificates are short-lived (≈3 days) and rotated by the
  service; RFC 3161 timestamping makes signatures outlive the cert.
- **SmartScreen:** Trusted Signing–signed apps get materially better baseline
  SmartScreen reputation than a fresh OV cert; expect warnings to disappear
  quickly rather than after months of download volume.
- **Fallback:** a classic OV cert from Certum/SSL.com (~$200–450/yr, cloud
  HSM) if Trusted Signing validation is refused; integration is the same
  `signtool` step with a different provider.

### Integration into packaging

Signing happens on the CI Windows runner between packager and feed steps
(§2b order). Tooling: `signtool sign` with the Trusted Signing dlib
(`Azure.CodeSigning.Dlib`) or the thinner `trusted-signing-cli` npm package:

```
trusted-signing-cli -e https://eus.codesigning.azure.net -a <account> -c <profile> <file.exe>
```

Auth via the standard Azure env vars (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`,
`AZURE_CLIENT_SECRET`) stored as GitHub Actions secrets — per repo policy,
never in the tree. Sign, at minimum: `Mia.exe` (the app), the uninstaller if
extracted separately (NSIS embeds it; signing the installer covers it for
SmartScreen purposes), and the final `Mia-Setup-…exe`. Gate the steps on the
secrets being present so unsigned local/dev packaging still works.

Once signing is live, add the publisher to the updater options so
verification turns on (must match the certificate's exact Common Name):

```js
setFeedURL({ provider: "github", owner: …, repo: …, publisherName: ["<Cert CN>"] })
```

## 4. Exact delta to our code

### `macos/src/main.cjs`

1. **Platform gate** in `configureAutoUpdates()` (line ~157):

   ```js
   // before
   if (!app.isPackaged || process.platform !== "darwin") return false;
   // after
   if (!app.isPackaged || (process.platform !== "darwin" && process.platform !== "win32")) return false;
   ```

2. **Feed options** (line ~162): unchanged today; when signing lands, pass
   `publisherName: ["<Cert CN>"]` on win32 (harmless to pass on mac, but keep
   it win32-only for clarity).

3. **Install invocation** in the `update-downloaded` handler (line ~207):
   `quitAndInstall()` defaults to `(isSilent=false, isForceRunAfter=false)`,
   which on Windows pops the NSIS UI and does not relaunch. Change to:

   ```js
   if (result && result.response === 0 && typeof autoUpdater.quitAndInstall === "function") {
     autoUpdater.quitAndInstall(true, true); // silent install, relaunch app
   }
   ```

   (No-op semantic change on macOS — Squirrel.Mac restarts regardless.)

4. **Copy fixes:** the interactive "unconfigured" dialog (line ~223) says
   "Updates run in packaged macOS builds" → "packaged macOS and Windows
   builds". The `update-available` detail says "signed update" — accurate on
   mac and, once §3 lands, on Windows.

Nothing else changes: `checkForMiaUpdate`, the Help → "Check for Updates…"
menu item (line ~1440), startup check (line ~1820), and
`MIAOS_UPDATE_FEED_URL` generic-provider override all work as-is on win32
(the generic provider will look for `latest.yml` under the same URL).

### `macos/scripts/package-win.cjs`

- Add `installer.nsi` invocation + `writeUpdateFeed()` per §2a/2b, exporting
  `writeUpdateFeed` from `module.exports` like the mac script does, so
  `package-mac.test.cjs`-style tests can cover the yml shape.
- `buildInstaller()` stdout should print the installer path and `latest.yml`
  path (mac prints dmg + zip), so CI logs show the exact assets.

### Release checklist additions

Per release version `vX.Y.Z` (one release, all platforms — see the §1 gotcha):

1. Bump `macos/package.json` version; move CHANGELOG *Unreleased* under
   `## [X.Y.Z] — date` (Keep a Changelog / semver conventions already in use).
2. Build mac as today. Trigger the Windows CI build (tag `vX.Y.Z-win` or
   `workflow_dispatch`); download `Mia-Setup-X.Y.Z-x64.exe`, `latest.yml`
   (and the portable zip if kept) from the run artifacts.
3. Publish everything on the **single** `vX.Y.Z` release:

   ```
   gh release create vX.Y.Z \
     Mia-X.Y.Z-arm64.dmg Mia-X.Y.Z-arm64-mac.zip latest-mac.yml \
     Mia-Setup-X.Y.Z-x64.exe latest.yml
   ```

   Delete any `vX.Y.Z-win` *release* GitHub auto-created from the CI tag
   (keep the tag; assets must not live there — semver treats `-win` as a
   prerelease and updaters skip it, and split releases would 404 the other
   platform's channel file).
4. Verify: `latest.yml`'s `url:` matches the uploaded asset name exactly;
   sha512 in the yml matches `openssl dgst -sha512 -binary file | base64`.
5. Point the miamultiplayer.com download link at the new installer.

## 5. Migration note: first Windows release

**Recommendation: ship NSIS from day one.** Do not do a zip-only v1.

Reasoning:

- There is **no installed base to migrate** — day one is the only free
  moment to pick the update channel. Choosing NSIS now costs nothing extra;
  choosing zip first creates a real migration later.
- A zip-only v1 **strands every early user permanently**: zip is not an
  update target on Windows (§1), so those installs contain an updater that
  can never fire. They would only ever leave v1 by manually downloading
  again — precisely the population least likely to do so. On macOS the first
  OTA-less release (≤0.2.5) was unavoidable; on Windows it is avoidable, so
  avoid it.
- The NSIS work is not the long pole. The `.nsi` contract in §2a is ~100
  lines, `makensis` is already on the CI runner, and the yml writer is a
  10-line clone of the mac one. Signing is the genuinely slow item (identity
  validation), and it is **orthogonal**: unsigned NSIS installs and unsigned
  OTA both work today (§3), so signing can land in v2 without changing the
  installer story.
- Keep the portable zip as a **secondary** artifact for users who refuse
  installers, clearly labeled "no automatic updates", if at all.

Sequencing: v1(win) = unsigned NSIS + `latest.yml` + OTA enabled (main.cjs
gate opened in the same release). v2(win) = identical pipeline + Azure
Trusted Signing + `publisherName` in `setFeedURL`. Every Windows user from
the first installer onward then receives v2 over the air, including the
signature-verification tightening.
