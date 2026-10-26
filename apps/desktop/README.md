# Corch DSH desktop for Windows

English | [中文](README.zh.md)

Desktop startup resolves shipped plugins directly from the portable runtime; it does not create symbolic links or junctions in `data`. Administrator privileges and Windows Developer Mode are not required. Keep the existing `data` folder when replacing the program, including after a failed startup. Existing profile manifests, patches, credentials, sessions and additional plugin directories are preserved.


Copy controls can write links and invitation codes to the clipboard from the local workbench. Web pages receive no clipboard-read permission.


## Use the portable client

Windows 10/11 x64 is required. Extract the entire ZIP into a writable folder, then double-click **Corch DSH.exe**. Node.js, Electron, the Web interface, the expert interview plugin and the patched better-sidebar provider are included; no system installation or pnpm download occurs at startup.

The client creates its own `data` folder beside the executable. It stores the Electron browser profile, DSH settings/credentials, sessions, a working directory and logs there. Keep this folder when replacing the program. Treat it as private; do not upload it with bug reports. Do not run multiple copies against the same data directory. `Corch DSH.exe --data-dir C:\absolute\private-folder` selects a separate profile. Do not point this option at an existing browser or DSH home.

Configure the question-generation model through the existing Models and credential services. Separately configure the Worker origin and its administrator-created publishing API Key under interview settings; the deployed service origin is `https://114.132.201.209`. The native process encrypts the Key for the current Windows account and sends it only as an Authorization header to the fixed upload endpoint. Remote pages cannot read the Key; browser persistence, URLs, share links and logs never store it. **发布并打开 SPA** uploads and opens immediately without another confirmation or administrator login. Missing, expired or revoked authorization produces an inline settings shortcut. Both Worker and HTTPS reverse proxy must support `/publish/api/`.

Closing the client stops its own local backend. Other DSH installations and services are unaffected. The local HTTP listener binds only `127.0.0.1`, uses an OS-assigned port on first start and retains that port for browser storage continuity. If another program occupies the saved port, startup fails with a log instead of adopting or closing that program. Startup logs are in `data/backend.log`; `data/startup-error.txt` records a launch failure. Microphone permission requires a native confirmation; hardware and real provider quality need separate acceptance.

The application is unsigned and has no automatic updater. Windows may display an unknown-publisher/SmartScreen warning. Electron and Node upstream licenses are included. Obtain updates as complete packages from the operator; verify the published SHA256 before extraction.

## Build reference

Use Windows x64, a supported Node.js release, pnpm11.7.0 and Windows PowerShell/tar. Run the normal repository build, then:

```powershell
pnpm --filter @polus-ai/corch-dsh-desktop run package:win --out C:\build\Corch-DSH
```

The output directory must not exist. The builder verifies pinned official Electron44.7.2 and Node24.18.0 archives, installs production dependencies from the frozen pnpm lockfile in a publication-only workspace mirror under the repository's private `.tmp` directory, outside the output tree, and materializes workspace packages into the portable closure. Payload checks reject symlinks, private configuration, source maps and compiler state. The builder emits a ZIP, SHA256 and per-file build manifest. Generated package-manager launchers, installation metadata and debug path labels are excluded so build-machine paths are not shipped. `--cache` selects an archive cache; `--closure` accepts a previously verified frozen desktop closure for offline assembly. That option still checks required built artifacts and scans the payload; the operator must supply the closure from the matching source/lockfile.

`node --test apps/desktop/policy.test.mjs apps/desktop/publisher.test.mjs apps/desktop/publisher-vault.test.mjs` checks popup restrictions, environment isolation and navigation. Desktop acceptance must launch the actual packaged executable with a separate data directory, load the real plugin, exercise the Models page and native publication against an isolated Worker, and verify backend shutdown. A loopback provider fixture verifies routing/credential plumbing only; it does not establish real model quality or microphone acceptance.

The [desktop decision](../../.agents/notes/implemented/feature/2026-10-14-windows-desktop-client.md) owns lifecycle and packaging rationale. The desktop adds no model prompt or tool behavior; existing bundles own those effects.
