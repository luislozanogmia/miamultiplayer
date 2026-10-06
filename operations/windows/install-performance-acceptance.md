# Windows installation performance acceptance

Request: reduce the long, apparently stuck Windows installation reported on
multiple computers, including RTX, and identify the active installation stage.
Keep user data, antivirus settings, the atomic rollback algorithm, and macOS
packaging unchanged.

Source base: `8b4bbb25a39eec63d6674120a698007b59d2c75e`.
Candidate: `codex/windows-install-performance`, not a released build.

## Native fixture contract

The comparison on RTX uses the same previously prepared v0.2.13 payload as
the baseline and pruning input. It does **not** claim a fresh official artifact
from the candidate source. Both installers use a separate fixture app ID,
executable name and install directory, with app launch and shortcuts disabled.
The real installed Mia is not replaced. Windows remains unsigned as approved;
no signing or antivirus settings are changed.

| Criterion | Environment | Result |
| --- | --- | --- |
| Fewer loose files without removing Node dependencies | Staged Windows payload | Passed: 47,233 → 17,826 files; backend 33,529 → 4,122 files |
| Browser assets and licenses remain | Local regression; RTX backend | Passed: all published browser files retained; 37 Clerk JS and 171 UI chunks served |
| Missing required dependency fails before pruning | Local regression | Passed |
| Native backend remains loadable | Bundled Electron on RTX | Passed: SQLite query, backend module loads, server boot and static routes |
| Default installer/uninstaller compile | Pinned electron-builder 26.15.3 on RTX | Passed: both baseline and candidate EXE/blockmap builds |
| Progress preserves error state | Pinned native NSIS fixture | Passed: both incoming error flag states preserved |
| Long-path rollback remains intact | Native NSIS regression on RTX | Passed: update, uninstall, and expected locked-file rollback with original contents restored |
| Clean installation time | Isolated RTX fixture | Passed: baseline 615.451 s; candidate 187.962 s; both exit 0 |
| Replacement and uninstall | Isolated RTX fixture | Passed: candidate replacement 204.006 s; uninstall 10.223 s; both exit 0 |
| Stage text visible during native installation | Automated native window probe | Preparation, unpacking and copying observed; copying screenshot checked; not manual acceptance |
| Manual user installation flow | Target Windows desktop | Unverified; no computer-use tool available in this session |
| Official release and OTA | Production installed app | Not exercised by this comparison |

Payload bytes fall from 1,094,971,282 to 872,253,856. Backend bytes fall from
289,092,809 to 66,375,383. Staging/pruning time is excluded from installation
timings. The first upgrade from an old installation still has to remove its
old, larger file tree; later replacements can benefit from the smaller tree.

The clean-install comparison is one run per variant on the same RTX machine:
baseline silent installation followed by candidate visible installation. It is
not randomized or a cold-cache benchmark. The candidate took about 69% less
time in this run. Baseline uninstall completed in 18.257 s with exit 0.
The candidate's subsequent same-ID replacement completed in 204.006 s and
uninstall in 10.223 s, both with exit 0. The interactive task completed with
result 0. A first old-payload-to-candidate upgrade was not timed separately;
the replacement result is candidate-to-candidate, not an OTA test.
The brief finishing label was not captured by the 100 ms window-text probe;
its hook is compiled, but observation of that label remains manual acceptance.

The native compile caught an include-precedence regression during development:
changing the compiler directory selected NSIS's built-in `MultiUser.nsh` instead
of electron-builder's `multiUser.nsh`. Copying upstream root includes unchanged
preserves their precedence. Tests compare every untouched root include byte for
byte, and both full native fixture builds subsequently passed.

These measurements are a single-machine diagnostic comparison, not a guarantee
of installation time on other computers or proof of production OTA/sign-in.
