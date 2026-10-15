# Corch DSH desktop for Windows

English | [中文](README.zh.md)

## Use the portable client

Windows 10/11 x64 is required. Extract the entire ZIP into a writable folder, then double-click **Corch DSH.exe**. Node.js, Electron, the Web interface, the expert interview plugin and the patched better-sidebar provider are included; no system installation or pnpm download occurs at startup.

The client creates its own `data` folder beside the executable. It stores the Electron browser profile, DSH settings/credentials, sessions, a working directory and logs there. Keep this folder when replacing the program. Treat it as private; do not upload it with bug reports. Do not run multiple copies against the same data directory. `Corch DSH.exe --data-dir C:\absolute\private-folder` selects a separate profile. Do not point this option at an existing browser or DSH home.

Open **Settings → Models** to configure a provider and API key through the existing DSH model/credential services. No keys or provider account are included. The expert interview entry is built in; its Worker address is configured explicitly under interview settings. For the deployed service, enter `https://114.132.201.209`. Publication opens a desktop popup on the Worker's origin, requires your own management login and explicit confirmation, then validates the receipt before marking the version published.

Closing the client stops its own local backend. Other DSH installations and services are unaffected. The local HTTP listener binds only `127.0.0.1`, uses an OS-assigned port on first start and retains that port for browser storage continuity. If another program occupies the saved port, startup fails with a log instead of adopting or closing that program. Startup logs are in `data/backend.log`; `data/startup-error.txt` records a launch failure. Microphone permission requires a native confirmation; hardware and real provider quality need separate acceptance.

The application is unsigned and has no automatic updater. Windows may display an unknown-publisher/SmartScreen warning. Electron and Node upstream licenses are included. Obtain updates as complete packages from the operator; verify the published SHA256 before extraction.

## Build reference

Use Windows x64, a supported Node.js release, pnpm11.7.0 and Windows PowerShell/tar. Run the normal repository build, then:

```powershell
pnpm --filter @polus-ai/corch-dsh-desktop run package:win --out C:\build\Corch-DSH
```

The output directory must not exist. The builder verifies pinned official Electron44.7.2 and Node24.18.0 archives, installs production dependencies from the frozen pnpm lockfile in a publication-only workspace mirror and materializes workspace packages into the portable closure, refuses symlinks and private configuration in the payload, and emits a ZIP, SHA256 and per-file build manifest. Generated package-manager launchers and installation metadata are excluded so build-machine paths are not shipped. `--cache` selects an archive cache; `--closure` accepts an previously verified frozen desktop closure for offline assembly. That option still checks required built artifacts and scans the payload; the operator must supply the closure from the matching source/lockfile.

`node --test apps/desktop/policy.test.mjs` checks popup restrictions, environment isolation and navigation. Desktop acceptance must launch the actual packaged executable with a separate data directory, load the real plugin, exercise the Models page and publish handshake against an isolated Worker, and verify backend shutdown. A loopback provider fixture verifies routing/credential plumbing only; it does not establish real model quality or microphone acceptance.

The [desktop decision](../../.agents/notes/implemented/feature/2026-10-14-windows-desktop-client.md) owns lifecycle and packaging rationale. The desktop adds no model prompt or tool behavior; existing bundles own those effects.
