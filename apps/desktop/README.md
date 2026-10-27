# Corch DSH desktop client

English | [中文](README.zh.md)

Desktop startup resolves shipped plugins directly from the portable runtime; it does not create symbolic links or junctions in its data directory. Keep the existing data directory when replacing the program, including after a failed startup. Existing profile manifests, patches, credentials, sessions and additional plugin directories are preserved.


Copy controls can write links and invitation codes to the clipboard from the local workbench. Web pages receive no clipboard-read permission.


## Use the portable client

The supported builds are Windows 10/11 x64 and macOS 13.5 or newer on Apple silicon. Extract the entire ZIP before launching **Corch DSH.exe** or **Corch DSH.app**. Node.js, Electron, the Web interface, the expert interview plugin and the patched better-sidebar provider are included; no system installation or pnpm download occurs at startup.

Windows creates `data` beside the executable. macOS stores data under `~/Library/Application Support/Corch DSH`. The directory contains the Electron browser profile, DSH settings and credentials, sessions, a working directory and logs. Keep it when replacing the program, treat it as private and do not upload it with bug reports. Do not run multiple copies against the same data directory. `--data-dir <absolute-path>` selects a separate profile; do not point it at an existing browser or DSH home.

Configure the question-generation model through the existing Models and credential services. Separately configure the Worker origin and its administrator-created publishing API Key under interview settings; the deployed service origin is `https://114.132.201.209`. The native process encrypts the Key for the current OS account and sends it only as an Authorization header to the fixed upload endpoint. Remote pages cannot read the Key; browser persistence, URLs, share links and logs never store it. **发布并打开 SPA** uploads and opens immediately without another confirmation or administrator login. Missing, expired or revoked authorization produces an inline settings shortcut. Both Worker and HTTPS reverse proxy must support `/publish/api/`.

Closing the client stops its own local backend. Other DSH installations and services are unaffected. The local HTTP listener binds only `127.0.0.1`, uses an OS-assigned port on first start and retains that port for browser storage continuity. If another program occupies the saved port, startup fails with a log instead of adopting or closing that program. Startup logs are in `data/backend.log`; `data/startup-error.txt` records a launch failure. Microphone permission requires a native confirmation; hardware and real provider quality need separate acceptance.

The Windows executable is unsigned. By default, macOS packaging uses an ad-hoc signature for internal distribution. Finder may require each user to choose **Open** on first launch, and Keychain can request access again after an update. Neither build has an automatic updater. Electron and Node upstream licenses are included. Obtain updates as complete packages from the operator and verify the published SHA256 before extraction.

## Build reference

Use a supported Node.js release and pnpm 11.7.0. Run the normal repository build, then package on the target OS:

```powershell
pnpm --filter @polus-ai/corch-dsh-desktop run package:win --out C:\build\Corch-DSH
```

```sh
pnpm --filter @polus-ai/corch-dsh-desktop run package:mac -- --out /tmp/Corch-DSH-arm64.app
```

Windows packaging requires Windows x64. macOS packaging targets ARM64 and supports either macOS host architecture. The output directory must not exist. The default command applies and verifies an ad-hoc signature for internal distribution. When a Developer ID Application certificate and a `notarytool` keychain profile are available, provide both `--sign-identity 'Developer ID Application: Organization (TEAMID)' --notary-profile corch-dsh-notary`; the builder then signs with the hardened runtime, submits the application for notarization, staples the accepted ticket and assesses the result. The builder verifies pinned official Electron 44.7.2 and Node 24.18.0 archives, installs target production dependencies from the frozen pnpm lockfile in a publication-only workspace mirror and materializes workspace packages into the portable closure. Payload checks reject private configuration and links outside Electron's macOS framework bundle. It emits a ZIP, SHA256 and per-file build manifest. Generated package-manager launchers, source maps, compiler state and generated debug path labels are omitted. `--cache` selects an archive cache; `--closure` accepts a previously verified frozen desktop closure for offline assembly. The operator must supply a target-compatible closure from the matching source and lockfile.

`node --test apps/desktop/policy.test.mjs apps/desktop/publisher.test.mjs apps/desktop/publisher-vault.test.mjs` checks popup restrictions, environment isolation and navigation. Desktop acceptance must launch the actual packaged executable with a separate data directory, load the real plugin, exercise the Models page and native publication against an isolated Worker, and verify backend shutdown. A loopback provider fixture verifies routing/credential plumbing only; it does not establish real model quality or microphone acceptance.

The [Windows desktop decision](../../.agents/notes/implemented/feature/2026-10-14-windows-desktop-client.md) and [macOS ARM64 decision](../../.agents/notes/implemented/feature/2026-10-26-macos-arm64-desktop-client.md) own lifecycle and packaging rationale. The desktop adds no model prompt or tool behavior; existing bundles own those effects.
