import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AUDIO_LIMITS, advanceEndpoint, createEndpointState, createPcmCapture, downmixMono,
  encodePcm16Wav, isCaptureIntent, joinPcm, resampleMono, rmsLevel, selectLocalVoice, wavToBase64,
} from '../voice-ui/audio.js';

const pcm = (length, value = 0.25) => new Float32Array(length).fill(value);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function clock() {
  let time = 0, serial = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (callback, delay) => { const id = ++serial; timers.set(id, { at: time + delay, callback }); return id; },
    clearTimer: id => timers.delete(id),
    advance(milliseconds) {
      const until = time + milliseconds;
      let iterations = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, item]) => item.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        assert.ok(++iterations < 10000, 'timer loop is bounded');
        time = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
      }
      time = until;
    },
    get pending() { return timers.size; },
  };
}

function fakeTrack() {
  const listeners = new Set();
  return {
    readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; },
    addEventListener(name, listener) { if (name === 'ended') listeners.add(listener); },
    removeEventListener(name, listener) { if (name === 'ended') listeners.delete(listener); },
    endExternally() { this.readyState = 'ended'; for (const listener of [...listeners]) listener(); },
    get listeners() { return listeners.size; },
  };
}

// Pure in-memory fakes: these tests never instantiate browser APIs or request a microphone.
function harness(options = {}) {
  const timer = clock();
  const tracks = [fakeTrack(), ...(options.extraTrack ? [fakeTrack()] : [])];
  const stream = { getTracks: () => tracks, getAudioTracks: () => tracks };
  const permission = options.permission || { promise: Promise.resolve(stream) };
  const results = [], errors = [], active = [], levels = [], nodes = [];
  let mediaCalls = 0, contexts = 0, constraints, allowed = true;
  const node = () => {
    const item = { connected: false, disconnects: 0, connect() { this.connected = true; }, disconnect() { this.disconnects++; } };
    nodes.push(item);
    return item;
  };
  let processor;
  const context = {
    sampleRate: options.rate || 16000, destination: {}, closes: 0, resumes: 0,
    createMediaStreamSource(value) { assert.equal(value, stream); return node(); },
    createScriptProcessor(size, inputChannels, outputChannels) {
      assert.equal(size, 2048);
      assert.equal(inputChannels, 1);
      assert.equal(outputChannels, 1);
      processor = node();
      return processor;
    },
    createGain() { return Object.assign(node(), { gain: { value: 1 } }); },
    resume() { this.resumes++; return options.resume?.promise || Promise.resolve(); },
    close() { this.closes++; return Promise.resolve(); },
  };
  const capture = createPcmCapture({
    isAllowed: () => allowed,
    getUserMedia(value) { mediaCalls++; constraints = value; return permission.promise; },
    createContext() { contexts++; if (options.contextThrows) throw new Error('No context'); return context; },
    now: timer.now, setTimer: timer.setTimer, clearTimer: timer.clearTimer,
    onActive(value) { active.push(value); options.onActive?.(value); },
    onLevel(value) { levels.push(value); },
    onResult(value) { results.push(value); options.onResult?.(value); },
    onError(value) { errors.push(value); },
  });
  return {
    capture, timer, tracks, stream, context, nodes, results, errors, active, levels,
    setAllowed(value) { allowed = value; },
    pump(...channels) {
      assert.equal(typeof processor?.onaudioprocess, 'function', 'audio graph is connected');
      processor.onaudioprocess({ inputBuffer: { numberOfChannels: channels.length, getChannelData: index => channels[index] } });
    },
    get contexts() { return contexts; }, get mediaCalls() { return mediaCalls; }, get constraints() { return constraints; },
    get processor() { return processor; },
  };
}

function assertReleased(h, { contexts = 1, stops = 1 } = {}) {
  assert.equal(h.capture.state, 'stopped');
  for (const track of h.tracks) {
    assert.equal(track.stops, stops);
    assert.equal(track.listeners, 0);
  }
  assert.equal(h.context.closes, contexts);
  assert.equal(h.timer.pending, 0);
  for (const node of h.nodes) assert.equal(node.disconnects, 1);
  if (h.processor) assert.equal(h.processor.onaudioprocess, null);
}

function wavView(wav) { return new DataView(wav.buffer, wav.byteOffset, wav.byteLength); }

test('mono downmix and RMS are deterministic, finite and non-mutating', () => {
  const left = new Float32Array([1, -1, NaN, 0.5]);
  const right = new Float32Array([-1, 1, 0.5, 0.5]);
  assert.deepEqual([...downmixMono([left, right])], [0, 0, 0.25, 0.5]);
  assert.equal(left[0], 1);
  assert.equal(rmsLevel([1, -1, 1, -1]), 1);
  assert.equal(rmsLevel([NaN, Infinity]), 0);
  assert.equal(rmsLevel([]), 0);
  assert.throws(() => downmixMono([]), TypeError);
  assert.throws(() => downmixMono([[1], [1, 2]]), RangeError);
});

test('resampling preserves duration/DC, averages downsampling and interpolates upsampling', () => {
  const input = pcm(48000, 0.5);
  const output = resampleMono(input, 48000, 16000);
  assert.equal(output.length, 16000);
  assert.ok(output.every(value => value === 0.5));
  assert.deepEqual([...resampleMono([1, -1, 1, -1], 4, 2)], [0, 0]);
  assert.deepEqual([...resampleMono([0, 1], 2, 4)], [0, 0.5, 1, 1]);
  const equal = resampleMono(input, 48000, 48000);
  assert.notEqual(equal, input);
  assert.deepEqual(equal, input);
  assert.equal(resampleMono([], 44100).length, 0);
  assert.equal(resampleMono(pcm(44100), 44100).length, 16000);
  assert.throws(() => resampleMono([1], 0), RangeError);
  assert.throws(() => resampleMono([1], 48000.1), RangeError);
});

test('PCM chunks are truncated at the exact sample cap without mutating the original audio', () => {
  const first = new Float32Array([1, 2, 3]);
  const second = new Float32Array([4, 5, 6]);
  assert.deepEqual([...joinPcm([first, second], 4)], [1, 2, 3, 4]);
  assert.deepEqual([...first], [1, 2, 3]);
  assert.deepEqual([...second], [4, 5, 6]);
  assert.equal(joinPcm([first], 0).length, 0);
  assert.equal(joinPcm([]).length, 0);
  assert.throws(() => joinPcm([first], -1), RangeError);
});

test('WAV is complete mono little-endian PCM16 with safe clipping and a correct RIFF size', () => {
  const wav = encodePcm16Wav([-2, -1, -0.5, 0, 0.5, 1, 2, NaN, Infinity], 16000);
  const view = wavView(wav);
  const ascii = (offset, length) => String.fromCharCode(...wav.subarray(offset, offset + length));
  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(view.getUint32(4, true), wav.length - 8);
  assert.equal(ascii(8, 8), 'WAVEfmt ');
  assert.equal(view.getUint32(16, true), 16);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 16000);
  assert.equal(view.getUint32(28, true), 32000);
  assert.equal(view.getUint16(32, true), 2);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint32(40, true), 18);
  assert.deepEqual(Array.from({ length: 9 }, (_, i) => view.getInt16(44 + i * 2, true)), [-32768, -32768, -16384, 0, 16384, 32767, 32767, 0, 0]);
  assert.deepEqual(new Uint8Array(Buffer.from(wavToBase64(wav), 'base64')), wav);
  assert.throws(() => encodePcm16Wav([], -16000), RangeError);
});

test('twenty seconds at 16 kHz stays well inside the decoded and JSON transport bounds', () => {
  const wav = encodePcm16Wav(pcm(16000 * 20));
  assert.equal(wav.length, 640044);
  assert.ok(wav.length < 2 * 1024 * 1024);
  assert.ok(wavToBase64(wav).length + 512 < 3 * 1024 * 1024);
});

test('endpoint waits 8 seconds without speech and rejects isolated clicks as speech', () => {
  let endpoint = createEndpointState();
  endpoint = advanceEndpoint(endpoint, 0, 7900);
  assert.equal(endpoint.reason, null);
  endpoint = advanceEndpoint(endpoint, 0.5, 50);
  assert.equal(endpoint.hasSpeech, false);
  endpoint = advanceEndpoint(endpoint, 0, 50);
  assert.equal(endpoint.reason, 'no-speech');
  assert.equal(endpoint.elapsedMs, 8000);
  assert.equal(endpoint.hasSpeech, false);
  assert.equal(advanceEndpoint(endpoint, 0.5, 1000), endpoint);
});

test('endpoint needs sustained speech, ends after 1.1 seconds of silence and can resume before it', () => {
  let endpoint = createEndpointState();
  endpoint = advanceEndpoint(endpoint, 0.1, 60);
  assert.equal(endpoint.hasSpeech, false);
  endpoint = advanceEndpoint(endpoint, 0.1, 60);
  assert.equal(endpoint.hasSpeech, true);
  endpoint = advanceEndpoint(endpoint, 0, 1000);
  assert.equal(endpoint.reason, null);
  endpoint = advanceEndpoint(endpoint, 0.1, 100);
  endpoint = advanceEndpoint(endpoint, 0, 1099);
  assert.equal(endpoint.reason, null);
  endpoint = advanceEndpoint(endpoint, 0, 1);
  assert.equal(endpoint.reason, 'silence');
});

test('endpoint never exceeds its maximum duration, even for continuous speech', () => {
  const endpoint = advanceEndpoint(createEndpointState(), 0.2, 20000);
  assert.equal(endpoint.hasSpeech, true);
  assert.equal(endpoint.reason, 'max-duration');
  assert.throws(() => advanceEndpoint(createEndpointState(), 0, -1), RangeError);
});

test('TTS voice selection is strictly local and language-aware, with no remote/English fallback', () => {
  const remote = { lang: 'zh-CN', localService: false, default: true };
  const english = { lang: 'en-US', localService: true };
  const taiwan = { lang: 'zh-TW', localService: true };
  const chinese = { lang: 'zh-CN', localService: true };
  assert.equal(selectLocalVoice([remote, english]), null);
  assert.equal(selectLocalVoice([{ lang: 'zh-CN', localService: 'true' }]), null);
  assert.equal(selectLocalVoice([remote, taiwan]), taiwan);
  assert.equal(selectLocalVoice([remote, taiwan, chinese]), chinese);
  assert.equal(selectLocalVoice([]), null);
});

test('capture requires the current armed activation and an explicit Host listen grant', () => {
  const armed = { activationId: 'current', capture: true, listen: true, visible: true };
  for (const phase of ['ready', 'preparing', 'transcribing', 'working', 'done', 'error']) {
    assert.equal(isCaptureIntent({ ...armed, phase }), false, `${phase} never opens the microphone`);
  }
  for (const phase of ['listening', 'question']) {
    assert.equal(isCaptureIntent({ ...armed, phase }), true);
    assert.equal(isCaptureIntent({ ...armed, phase, capture: false }), false, 'Host cannot arm a peek');
    assert.equal(isCaptureIntent({ ...armed, phase, listen: false }), false, 'user arming alone is insufficient');
    assert.equal(isCaptureIntent({ ...armed, phase, visible: false }), false);
    assert.equal(isCaptureIntent({ ...armed, phase, activationId: '' }), false);
  }
  assert.equal(isCaptureIntent(undefined), false);
});

test('constructing the pipeline never captures, and a disallowed start cannot request permission', async () => {
  const h = harness();
  assert.equal(h.mediaCalls, 0);
  assert.equal(h.contexts, 0);
  h.setAllowed(false);
  await h.capture.start();
  assert.equal(h.mediaCalls, 0);
  assert.equal(h.contexts, 0);
  assert.equal(h.capture.state, 'stopped');
  assert.equal(h.timer.pending, 0);
});

test('manual finish emits exactly one complete mono WAV, after stopping every track and context', async () => {
  const h = harness({ extraTrack: true });
  await h.capture.start();
  assert.equal(h.constraints.video, false);
  assert.equal(h.constraints.audio.channelCount.ideal, 1);
  assert.equal(h.capture.state, 'recording');
  h.pump(pcm(2048, 0.5), pcm(2048, 1));
  assert.equal(h.results.length, 0, 'no partial audio is delivered');
  h.capture.finish();
  h.capture.finish();
  h.capture.cancel();
  h.capture.dispose();
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].reason, 'manual');
  assert.equal(h.results[0].hasSpeech, true);
  assert.equal(wavView(h.results[0].wav).getInt16(44, true), Math.round(0.75 * 32767));
  assert.deepEqual(h.active, [true, false]);
  assertReleased(h);
});

test('silence automatically produces the full utterance including its endpoint tail, never a partial', async () => {
  const h = harness();
  await h.capture.start();
  h.pump(pcm(2048));
  h.pump(pcm(16000, 0));
  assert.equal(h.results.length, 0);
  h.pump(pcm(1600, 0));
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].reason, 'silence');
  assert.equal(h.results[0].wav.length, 44 + (2048 + 17600) * 2);
  assertReleased(h);
});

test('oversized final input is truncated to twenty seconds before encoding', async () => {
  const h = harness({ rate: 48000 });
  await h.capture.start();
  h.pump(pcm(48000 * 21));
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].reason, 'max-duration');
  assert.equal(h.results[0].durationMs, 20000);
  assert.equal(h.results[0].wav.length, 640044);
  assertReleased(h);
});

test('8-second no-speech watchdog releases resources even when no audio callback arrives', async () => {
  const h = harness();
  await h.capture.start();
  h.timer.advance(7999);
  assert.equal(h.results.length, 0);
  h.timer.advance(1);
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].reason, 'no-speech');
  assert.equal(h.results[0].hasSpeech, false);
  assert.equal(h.results[0].wav, undefined);
  assertReleased(h);
});

test('wall-clock silence watchdog also releases a stalled graph after speech', async () => {
  const h = harness();
  await h.capture.start();
  h.pump(pcm(2048));
  h.timer.advance(1100);
  assert.equal(h.results.length, 1);
  assert.equal(h.results[0].reason, 'silence');
  assertReleased(h);
});

test('cancellation during permission leaves no stale grant, capture fact or final submission', async () => {
  const permission = deferred();
  const h = harness({ permission });
  const start = h.capture.start();
  assert.equal(h.mediaCalls, 1);
  h.capture.cancel();
  h.capture.cancel();
  h.capture.finish();
  permission.resolve(h.stream);
  await start;
  assert.equal(h.contexts, 0);
  assert.equal(h.results.length, 0);
  assert.equal(h.errors.length, 0);
  assert.deepEqual(h.active, []);
  assertReleased(h, { contexts: 0 });
});

test('an activation/Host gate change during permission stops the late stream immediately', async () => {
  const permission = deferred();
  const h = harness({ permission });
  const start = h.capture.start();
  h.setAllowed(false);
  permission.resolve(h.stream);
  await start;
  assert.equal(h.contexts, 0);
  assert.equal(h.results.length, 0);
  assertReleased(h, { contexts: 0 });
});

test('permission timeout reports one retryable error and still stops a later successful grant', async () => {
  const permission = deferred();
  const h = harness({ permission });
  const start = h.capture.start();
  h.timer.advance(AUDIO_LIMITS.permissionTimeoutMs);
  assert.deepEqual(h.errors.map(error => error.code), ['permission-timeout']);
  h.capture.dispose();
  permission.resolve(h.stream);
  await start;
  assert.equal(h.results.length, 0);
  assert.equal(h.contexts, 0);
  assertReleased(h, { contexts: 0 });
});

test('cancel while AudioContext.resume is pending closes it and cannot restart on late resolution', async () => {
  const resume = deferred();
  const h = harness({ resume });
  const start = h.capture.start();
  await Promise.resolve();
  assert.equal(h.capture.state, 'starting');
  h.capture.cancel();
  assertReleased(h);
  resume.resolve();
  await start;
  assertReleased(h);
  assert.equal(h.results.length, 0);
  assert.deepEqual(h.active, [true, false]);
});

test('an indefinitely suspended AudioContext also expires without leaking a track', async () => {
  const resume = deferred();
  const h = harness({ resume });
  const start = h.capture.start();
  await Promise.resolve();
  h.timer.advance(8000);
  assertReleased(h);
  assert.equal(h.results[0].hasSpeech, false);
  resume.resolve();
  await start;
  assertReleased(h);
});

test('recording cancelled by Host/visibility gate discards audio and releases on the watchdog', async () => {
  const h = harness();
  await h.capture.start();
  h.pump(pcm(2048));
  h.setAllowed(false);
  h.timer.advance(100);
  assertReleased(h);
  assert.equal(h.results.length, 0);
  assert.equal(h.errors.length, 0);
});

test('external microphone loss is retryable and releases the entire graph', async () => {
  const h = harness();
  await h.capture.start();
  h.tracks[0].endExternally();
  assert.deepEqual(h.errors.map(error => error.code), ['input-ended']);
  assert.equal(h.results.length, 0);
  assertReleased(h);
});

test('failed graph setup stops the granted microphone immediately', async () => {
  const h = harness({ contextThrows: true });
  await h.capture.start();
  assert.deepEqual(h.errors.map(error => error.code), ['capture-unavailable']);
  assertReleased(h, { contexts: 0 });
});

test('permission denial is not retried automatically and cannot emit final audio', async () => {
  const permission = deferred();
  const h = harness({ permission });
  const start = h.capture.start();
  const denied = new Error('OS details must not be reflected');
  denied.name = 'NotAllowedError';
  permission.reject(denied);
  await start;
  assert.deepEqual(h.errors.map(error => error.code), ['permission-denied']);
  assert.equal(h.results.length, 0);
  assert.equal(h.mediaCalls, 1);
  assert.equal(h.contexts, 0);
  assert.equal(h.timer.pending, 0);
  assert.equal(h.tracks[0].stops, 0, 'no stream was granted');
});

test('cancellation reentered from an active fact cannot create a context or submit audio', async () => {
  let capture;
  const h = harness({ onActive(active) { if (active) capture.cancel(); } });
  capture = h.capture;
  await capture.start();
  assert.equal(h.contexts, 0);
  assert.equal(h.results.length, 0);
  assert.deepEqual(h.active, [true, false]);
  assertReleased(h, { contexts: 0 });
});

test('one throwing track.stop does not prevent releasing other tracks and the AudioContext', async () => {
  const h = harness({ extraTrack: true });
  await h.capture.start();
  h.tracks[0].stop = function () { this.stops++; this.readyState = 'ended'; throw new Error('device already gone'); };
  h.capture.cancel();
  assertReleased(h);
  assert.equal(h.results.length, 0);
});

test('consumer exceptions and reentrant finish cannot leak resources or submit twice', async () => {
  let capture;
  const h = harness({ onResult() { capture.finish(); throw new Error('consumer'); } });
  capture = h.capture;
  await capture.start();
  h.pump(pcm(2048));
  capture.finish();
  assertReleased(h);
  assert.equal(h.results.length, 1);
  assert.equal(h.errors.length, 0);
});

test('real panel resources remain local, text-only at DOM sinks, and theme-adaptive', async () => {
  const [html, panelSource, audioSource, css] = await Promise.all(
    ['index.html', 'panel.js', 'audio.js', 'panel.css'].map(name => readFile(new URL(`../voice-ui/${name}`, import.meta.url), 'utf8')),
  );
  assert.deepEqual([...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(match => match[1]), ['./panel.css', './panel.js']);
  assert.deepEqual([...panelSource.matchAll(/^import .* from '([^']+)'/gm)].map(match => match[1]), ['./audio.js', './view-state.js']);
  assert.match(html, /connect-src 'none'/);
  assert.match(html, /id="text-form"[^>]*hidden/);
  assert.match(html, /maxlength="2000"/);
  assert.doesNotMatch(panelSource + audioSource, /\b(?:innerHTML|outerHTML|insertAdjacentHTML|XMLHttpRequest|WebSocket|localStorage)\b|\bfetch\s*\(/);
  assert.match(panelSource, /node\.textContent = value/);
  assert.match(css, /--dsw-alias-label-primary, CanvasText/);
  assert.match(css, /--dsw-alias-bg-base, Canvas/);
  assert.match(css, /prefers-reduced-motion/);
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|\brgba?\s*\(/i);
});

test('safety caps cannot be raised by a caller', () => {
  assert.throws(() => createPcmCapture({ limits: { maxDurationMs: 21000 } }), RangeError);
  assert.throws(() => createPcmCapture({ limits: { permissionTimeoutMs: Infinity } }), RangeError);
  assert.throws(() => createPcmCapture({ limits: { voiceThreshold: 0 } }), RangeError);
  assert.throws(() => createPcmCapture({ limits: { sampleRate: 96000 } }), RangeError);
});
