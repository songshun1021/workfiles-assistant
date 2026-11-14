# Internal voice entry protocol v1 · activity-aware revision

The native feature is a managed child of the installed Harness bundle, not a preview server. Do not patch the running App, start a replacement DSH server, read browser authentication state or grant system permission on the user's behalf.

Transport is bounded UTF-8 JSON Lines on managed stdin/stdout; every message has `v:1`. Logs go to stderr. There is no network port or reusable secret. Unknown fields/types, stale UUIDs and oversized messages fail closed. Parent input loss releases capture, hotkey and window. The renderer has no Node or general IPC/file/URL/shell access.

## Host → native main

- `{v:1,type:'init',shortcut:string,title:string}` registers one validated owned accelerator, default `CommandOrControl+Shift+Space`. No bare typing/Esc or common destructive/system combinations; no unregister-all operation.
- `{v:1,type:'toggle'}` is the explicit record/shortcut-equivalent action. Both the Host voice button and physical accelerator use the same native decision path:
  - idle: new armed activation UUID;
  - recording: stop and submit once;
  - preparing/transcribing/working: reveal that same task, without cancel, new UUID or microphone rearm.
- `{v:1,type:'show',activationId:string,capture:boolean}` remains compatible, but current Host inspection/peek uses `capture:false`. Peek only reveals any existing visible activation, including listening and completed feedback; it must not cancel or replace a recording. Programmatic verification must not arm audio.
- `{v:1,type:'state',activationId:string,phase:'ready'|'preparing'|'listening'|'transcribing'|'working'|'question'|'done'|'error',message?:string,detail?:string,listen?:boolean,canPrepare?:boolean,progress?:number}`. Text ≤1000 chars, progress 0..1. Only an already user-armed activation in `listening` can capture; state cannot arm by itself. A question is display/TTS-only and never automatically reopens audio. A legacy `listen:true` question is parsed but not granted by the controller.
- `{v:1,type:'hide',activationId?:string}` stops audio/speech and hides. A stale supplied UUID cannot hide a newer activation.
- `{v:1,type:'configure',shortcut:string,configurationId?:string}` requests validated idle-only registration. The optional UUID supports old logs while the current Host requires a matching acknowledgement. Failed registration preserves the old owned accelerator. Unconfirmed/cancelled requests are not persisted; inspect actual status after an ambiguous timeout.
- `{v:1,type:'shutdown'}` disposes the owned child.

## Native main → Host

- `{v:1,type:'ready',shortcut:string,registered:boolean,platform:string,electronVersion:string,configurationId?:string}` reports actual registration, not a physical-key test. Configure succeeds only with matching UUID, requested accelerator and `registered:true`; unrelated or late ready messages cannot complete a different request.
- `{v:1,type:'activated',activationId:string,source:'shortcut'|'panel'|'host',capture:boolean}` is emitted once per fresh activation. Explicit gestures arm; peek, preparation and startup do not. Cancel is a separate action; Esc/Cmd-W is handled only by the focused owned window.
- `{v:1,type:'audio',activationId:string,utteranceId:string,wavBase64:string}` carries one final mono PCM16 WAV. Never send partial ASR as a prompt. Header/duration/≤2 MiB decoded size are checked; max JSON line 3 MiB. Default duration cap 20 seconds, no-speech timeout 8 seconds, endpoint silence about 1.1 seconds. Raw audio remains in memory.
- `{v:1,type:'text',activationId:string,utteranceId:string,text:string}` is explicit typed fallback, ≤2000 chars, not an automatic submission from another editor.
- `{v:1,type:'action',activationId:string,name:'prepare'|'retry'|'cancel'|'dismiss'}` is from a validated owned renderer. Preparing a model is not a future recording grant. Cancel stops admitted/pending Agent work as well as capture.
- `{v:1,type:'capture',activationId:string,active:boolean}` reports actual capture facts, never audio or document metadata.
- `{v:1,type:'notice'|'fatal',code:string,message:string}` is bounded/redacted diagnostics.
- `{v:1,type:'closed',activationId?:string}` reports lifecycle closure.

## Two-stage focus and optional current cue

1. Native creates the recording activation in non-listening `preparing`, showing the window **inactive**. It does not focus before Host capture of the original work context.
2. Host checks policy, optionally awaits `captureCurrentContext(signal)` (≤2000ms coordinator budget; the current controller uses 1800ms), then publishes the first state. Optional failure returns no cue and must not break ordinary file search.
3. That first Host state is the one-time native reveal/focus boundary. Ordinary later state/progress updates do not steal focus.
4. Voice Session admission receives only `session.run(finalText,{signal,utteranceId,contextToken})`; the opaque cue token never crosses native IPC/status, is not added to the transcript and is not a hidden system prompt.
5. The adapter binds it to the actual dedicated Session before the normal user prompt. The Model must explicitly call `workfiles_history` to receive a normal auditable Tool result. Completion/cancel revokes the token **before** settling the caller's result, even if an uncancellable admission is still draining. Retire, prepare, clear, revocation, TTL and unload also release unused/late cues.

The cue is selected-app-only, metadata-only, in memory for ≤120 seconds and ≤16 entries. Approved roots and metadata are revalidated. App-only query does not fetch document metadata. It supplements, never replaces, the independent automatic ledger.

## Native renderer bridge

Expose only `window.workfilesVoice`:

- `onState(callback): disposer` receives flat `{activationId,capture,visible,phase,listen,message,detail,canPrepare,progress,signal?,signalId?}`; no Electron object, ledger record or cue token.
- `ready(): Promise<state>` is called after listeners install.
- `audio({activationId,utteranceId,wavBase64})`, `text({activationId,utteranceId,text})`, `action({activationId,name})`, `capture({activationId,active})` are the only writes.

Stop-submit is a monotonic signal, consumed once before capture is revoked. Retry creates a new user-armed UUID in main; no duplicate action forwarding. Validate sender, main frame, exact owned origin and generation for every IPC. Media permission is audio-only for the explicit visible armed current window; never display/video or arbitrary origins. Keyboard mode stops recording and cannot automatically rearm it.

Real UI resources are [the document](<./voice-ui/index.html>), [panel controller](<./voice-ui/panel.js>), [styles](<./voice-ui/panel.css>), [audio owner](<./voice-ui/audio.js>) and [presentation policy](<./voice-ui/view-state.js>). They are served only through the controlled local feature protocol, not an iframe or new HTTP server. [The Client half](<./client.js>) remains ordinary Harness Slots: sidebar footer, composer fallback and one shared settings overlay.

## Agent, cancellation and settings authority

One dedicated ordinary Agent/Session uses inspected public `tools.restrict()` plus a scoped guard, not a custom LLM loop. The exact allowed globals are `workfiles_search`, `workfiles_inspect`, `workfiles_open`, `workfiles_context`, `workfiles_history`; a same-name scoped replacement is rejected. Recognized final text is normal prompt admission; no development conversation is copied. Admissions serialize, utterance IDs dedupe through committed records, and timeout/cancel clears owned queues and late admission, not just the waiting Promise.

Delivery is `{status:'done'|'clarify'|'not_found'|'error',say:string}`. Clarification is not a microphone grant. Not-found/long/read feedback stays; only short one-line success can auto-dismiss. The initial armed readiness lease is 8 seconds; downloading, preparation, expiration and clock reversal require a fresh gesture. `open_requested` means accepted OS handoff, not a visible-window claim, and an already accepted open cannot reliably be undone.

[The Human settings receiver](<./lib/activity-rpc.js>) is a real public Cordis Service carrying `this.ctx.invocation`. It accepts only an actual `owner` peer with `interactions:'answer'`, uses strict Typert input/result codecs, and needs no Agent/Session. Caller JSON cannot spoof privilege. Recording, app selection, clearing, folders, permission-setting navigation and shortcut persistence are not Model tools. No private Gateway dispatch, raw browser auth or config write from the restricted voice Agent.

## Independent local ledger

[Host composition](<./lib/activity-host.js>), [ledger](<./lib/activity-ledger.js>), [controller](<./lib/activity-controller.js>) and [static native reader](<./native/context-reader.js>) own a separate default-off `local_workfiles_activity` per-record StorageDomain. They never create an Agent/model turn for collection. Only selected Word/PowerPoint/WPS are eligible; no backfill, Edge, browsing history, bodies, selected text, AX tree traversal, keystrokes, clipboard, screenshots or audio.

Foreground snapshots are about 4 seconds apart and can miss brief transitions. App-level cues work without AX; document fields additionally require manual permission and canonical approved-file validation **before title read**. Retention is rolling 7 days and ≤1000 records, including dedup-cursor expiry; paused maintenance continues while Harness runs and startup purges after downtime. Pausing file search and pausing automatic recording are independent. Removing apps deletes their entries; root revocation removes document fields. Clear requires Human confirmation, clears current capabilities and suppresses immediate same-foreground refill, but does not stop future recording or erase existing conversations/model-service data.

`workfiles_history` defaults to app-only fields and a bounded local aggregate, not document names/paths. Documents/all are for actual document requests and yield fresh same-session candidate IDs only after scope/identity revalidation. Historical `observedAt` is not file mtime or proof of reading/editing/saving. Counts are observations, not opens or duration. Metadata/transcripts requested by a task may enter the configured model conversation; local collection is not a claim of wholly offline tasks.
