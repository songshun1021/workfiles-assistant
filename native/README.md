# Harness-managed native voice helper

This is the real feature component, not a web overlay or mock preview. No server,
HTTP port, browser profile, authentication token or generic renderer IPC is used.
The Host owns the child through stdin/stdout and must cancel admitted Agent work
when it receives `action:cancel`, `action:dismiss` or the current `closed` event.

## Build / install contract

Run from a **real plugin package copy**, after `native/` and the five required real
`voice-ui/` resources have been included in that package:

```sh
# This exact non-FileProvider cache was explicitly approved by the user:
node native/build-helper.mjs --output-root '/Users/sean/Library/Caches/DeepSeekHarness/WorkfilesVoice'
# Default remains the package's own .native (fails on this FileProvider volume).
# Optional verified installed runtime override, combinable with --output-root:
node native/build-helper.mjs --source-executable '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness' --output-root '/Users/sean/Library/Caches/DeepSeekHarness/WorkfilesVoice'
```

The builder also works under the installed Electron's Node mode. It does not run
Electron's GUI/main feature, register a key, display a page, ask for permissions,
or open a microphone during the build. It verifies the source as an installed
Harness Electron runtime and refuses incompatible fuses instead of changing them.

Output is confined to the package's own `.native/` or the one exact user-approved
cache `/Users/sean/Library/Caches/DeepSeekHarness/WorkfilesVoice`. Other paths,
namespace/cache-root symlinks, unknown owners and non-empty unowned output roots
are rejected. No fallback directory is selected silently.

A successful build publishes `helper.json` inside its artifact root and a matching
locator at the source package's `.native/helper.json`; no new manifest is published
on failure. The record includes:

- `executable`: absolute launch path;
- `artifactRoot`: the validated absolute output root;
- `buildRoot`: `<artifactRoot>/<24-hex-buildId>.nosync`;
- `executableRelativeBase: 'artifactRoot'`;
- `executableRelative`: **relative to artifactRoot**, not to bundleRoot;
- `bundleRoot`: the real source plugin root, not the cache directory;
- `sourceExecutable`, `sourceExecutableHash`, `sourceRuntimeHash`, exact versions;
- `buildId`, input `resourceHashes`, copied framework size, and validation facts.

The executable is `<artifactRoot>/<24-hex-buildId>.nosync/Workfiles Voice Helper.app/Contents/MacOS/DeepSeek Harness`.
Use the manifest path; do not guess it. The original executable basename is
retained solely for Electron's platform subprocess lookup. The helper and its
copied subprocesses have distinct `local.workfiles.voice.*` bundle identifiers.

The entire Electron framework and three companion frameworks must be copied
inside the owned app. The external-framework-symlink experiment was rejected by
`codesign --verify --strict` (`invalid destination for symbolic link in bundle`).
Framework copies retain their existing vendor signatures. Only copied helper
wrappers and the new top-level app are ad-hoc signed, separately, **without
`--deep`**. Source app files and signatures are never modified. No new Electron
package is downloaded or installed.

On this machine, Documents is FileProvider-managed. It synthesizes empty
`com.apple.FinderInfo` on new `.app` / `.framework` directories even under a
`.nosync` ancestor; native code signing rejects this metadata. The builder only
clears FinderInfo/ResourceFork on individually verified owned real output paths,
never follows a link or clears quarantine/provenance/FileProvider/security flags.
The user explicitly approved only the exact WorkfilesVoice cache above to recover
from this boundary. The cache build has now passed owned app/helper signing,
all four copied vendor framework signature checks, source signature/hash checks
and the copied executable's Node-mode probe. Do not launch unsigned workspace
experiments or generalize this approval to other Library/Caches/temporary paths.
Build failure is not a reason to bypass signing, change OS settings, grant
permissions, accept the Xcode license, or re-sign the source app.

The builder performs no recursive deletion or move. Content-addressed builds do
not replace a running executable. An old failed build may be removed manually
only after successful cache validation and verification of its exact absolute
path, ownership markers and contained links. Never remove the whole source
package, an unrecognized output, or a link target. Do not package every
experimental output; retain only the validated runtime and its locator.

## Launch contract

Spawn argv **`[manifest.executable]`**, cwd the corresponding plugin package root,
stdin/stdout pipes. Do not pass a script argument or use `open -a`, which loses the
managed pipes. stderr is diagnostics only; collect it with a bound (e.g. 64 KiB).
Use a minimal environment such as HOME/TMPDIR/LANG/LC_CTYPE/LC_ALL,
`__CF_USER_TEXT_ENCODING` and a fixed OS PATH. Do not inherit
`ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS`, `DYLD_*`, Electron debug/security switches,
credentials or arbitrary parent environment variables at actual feature launch.

Send the protocol `init` JSON line. `ready.registered` reports real registration
facts, not a physical key-press test. Startup is hidden with no renderer or capture.
A user shortcut / trusted record button creates an armed activation; Host `show`
with `capture:false` is a non-recording peek. Host `state listen:true` cannot arm
an activation. Close/stdin loss/shutdown destroy the owned renderer and release
only owned key registrations, not all application/global accelerators.

A copied manifest alone is insufficient. Keep the complete app/relative internal
framework symlinks, sibling owned runtime directories and matching product UI.
Resolve `executableRelative` against the explicitly allowed `artifactRoot`, never
against a caller-supplied arbitrary root. The cache locator is machine-local and
not portable: copying the source package does not relocate its cache runtime.
Validate the allowed root, exact build/executable path, ownership, resources,
hashes and signatures before launching. The source version/hashes are retained
for update detection: rebuild against an
updated installed Harness/Electron rather than silently keeping an obsolete copy.
The local ad-hoc build is neither Developer-ID-notarized nor a portable release.

## Renderer and wire interfaces

`protocol.mjs` exports `parseHostMessage`, `parseHelperMessage`, `encodeMessage`,
`MAX_LINE_BYTES` (3 MiB), plus a byte-bounded JSON Lines decoder. Parsers return a
fresh frozen record or throw. Unknown fields/types, invalid UTF-8, excessive sizes,
non-finite progress and unsafe listen phases are rejected. Optional absent fields
must be omitted, not supplied as `undefined`. Host must still validate decoded
mono PCM16 WAV headers/duration before ASR; native does not treat partial audio as
an Agent prompt.

The sandbox preload exposes only `window.workfilesVoice` with the six protocol
methods. Every main IPC checks the exact owned WebContents, main frame, document
URL and current activation. The fixed local feature origin is
`workfiles-voice://panel`, document `/index.html`; only `index.html`, `panel.js`,
`panel.css`, `audio.js`, `view-state.js` and the optional `icon.svg` can be served.
The pure display-state module is a same-origin static asset, not a new bridge or
permission surface. The existing restrictive CSP remains unchanged: script-src
self, no network connections, workers, frames, remote URLs or generic file access.

`ready()` returns the same flat snapshot delivered by `onState`:

```js
{ activationId, capture, visible, phase, listen, message,
  detail?, canPrepare, progress?, signal?: 'stop-submit', signalId?: number }
```

Install listeners before calling `ready()`. The second key press while listening
(or awaiting a mic grant) emits `capture:false`, `listen:false`,
`signal:'stop-submit'` and a monotonic integer `signalId`. UI must handle that
signal **before** treating ordinary capture:false as cancellation, dedupe the
activation/signalId pair, and submit at most one complete final audio. Native
retains precisely that submission permission; cancel/hide/closed reject it.
A trusted `retry` creates a fresh `activated(source:'panel',capture:true)` and does
not double-forward a retry action. First-use preparation disarms the old activation.
Working/preparing/transcribing key presses only reveal the existing task, without
canceling, rearming or creating concurrent work. Cancellation is separate; Esc is
local to the focused panel. Clarification does not automatically reopen audio.
Cancel/dismiss/no-speech cancellation closes the owned renderer; it is not
merely a hidden page that could retain a track or pending permission request.

Audio permissions require a visible current armed/listening feature main frame,
exact origin, and audio-only request. Video, display capture, devices and other
permissions are denied. There is no proactive macOS mic/Accessibility/screen
permission request. User permission prompts and any actual recording remain
explicit user actions; programmatic inspection must use capture:false.

## Verified versions / licensing / boundaries

Read-only source probe on this installation: Harness **0.2.2-rc.2**, Electron
**44.7.0**, Chromium **152.0.7977.130**, Node **24.21.0**, **arm64**. The Electron
v1 fuse wire was `101100011`: `embeddedAsarIntegrityValidation` and
`onlyLoadAppFromAsar` are disabled, so a separate owned `Resources/app` entry is
supported without modifying source fuses. The copied framework tree measured
about **286 MiB logical bytes** in the local experiment (final manifest is exact).

No third-party npm dependency was added. Electron's MIT license is preserved in
`LICENSE.Electron`, from the exact upstream version. Chromium and companion
frameworks retain their upstream/vendor licenses and signed runtime content;
this local runtime reuse is not a claim that all third-party notices required
for a separate portable distribution have been assembled.

References:
- https://www.electronjs.org/docs/latest/tutorial/application-distribution
- https://www.electronjs.org/docs/latest/tutorial/fuses
- https://github.com/electron/electron/blob/v44.7.0/build/fuses/fuses.json5
- https://github.com/electron/electron/blob/v44.7.0/LICENSE

Validated cache build: `1a75261979d664aed3f987fe`, containing 298,985,427 framework
bytes in 243 framework files. The completed build directory measured 299,945,979
logical bytes, 278 files and 14 validated internal relative links before GUI use.
The previous `6ac389544aafa862d5d81f91` cache was confirmed fully stopped and
unreferenced, ownership/link-checked and removed; only this new cache build remains. `codeSignVerify`, `copiedFrameworkSignatures`,
`sourceSignaturesAfterBuild` and `copiedRuntimeNodeMode` are true;
`guiLaunched` and `microphoneOpened` are false. The frozen product panel,
view-state and audio hashes match the UI teammate's final resources.

Pure tests: `node --test test/voice-native.test.js` (28 tests at implementation
handoff). These exercise parsers, bounded framing, lifecycle/key policy, stale and
late submissions, permission gates, exact sender/resource restrictions, preload
surface and build safety. They do **not** prove real OS key delivery, multi-display
focus, native page rendering, mic/TCC behavior, audio input, local TTS playback,
or Host subprocess integration. A final signed build's Node-mode probe proves
launcher/dyld/runtime resolution only. The first real UI preview must be launched
by the installed plugin, not a mock/script, and must not open a microphone as a test.
