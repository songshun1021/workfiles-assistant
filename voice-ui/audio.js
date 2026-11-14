// Browser-only audio at runtime; the DSP and lifecycle are independently testable in Node.
// Nothing is captured when this module is imported. No network, files, remote ASR or TTS.
export const AUDIO_LIMITS = Object.freeze({
  sampleRate: 16000,
  maxDurationMs: 20000,
  noSpeechMs: 8000,
  silenceMs: 1100,
  minSpeechMs: 120,
  voiceThreshold: 0.015,
  permissionTimeoutMs: 15000,
});

// Host state is permission to listen, never permission to arm. Both are mandatory.
export function isCaptureIntent(state) {
  return Boolean(state && state.activationId && state.capture === true && state.listen === true
    && state.visible !== false && (state.phase === 'listening' || state.phase === 'question'));
}

function sampleRate(value) {
  if (!Number.isInteger(value) || value < 1 || value > 384000) throw new RangeError('Invalid sample rate');
  return value;
}

function finiteSample(value) {
  return Number.isFinite(value) ? value : 0;
}

export function downmixMono(channels) {
  if (!Array.isArray(channels) || !channels.length || channels.length > 32) throw new TypeError('Invalid audio channels');
  const length = channels[0].length;
  if (!channels.every(channel => channel && channel.length === length)) throw new RangeError('Audio channel lengths differ');
  const mono = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channels) sum += finiteSample(channel[i]);
    mono[i] = sum / channels.length;
  }
  return mono;
}

export function rmsLevel(samples) {
  if (!samples.length) return 0;
  let squareSum = 0;
  for (const value of samples) squareSum += finiteSample(value) ** 2;
  return Math.sqrt(squareSum / samples.length);
}

// Area averaging for downsampling avoids point-sampling aliasing. Upsampling uses linear
// interpolation. This is a small speech resampler, not a studio-quality band-limited filter.
export function resampleMono(samples, fromRate, toRate = AUDIO_LIMITS.sampleRate) {
  sampleRate(fromRate);
  sampleRate(toRate);
  const length = Math.round(samples.length * toRate / fromRate);
  const output = new Float32Array(length);
  if (!length) return output;
  if (fromRate === toRate) {
    for (let i = 0; i < length; i++) output[i] = finiteSample(samples[i]);
    return output;
  }
  const ratio = fromRate / toRate;
  if (ratio < 1) {
    for (let i = 0; i < length; i++) {
      const at = Math.min(i * ratio, samples.length - 1);
      const left = Math.floor(at);
      const fraction = at - left;
      output[i] = finiteSample(samples[left]) * (1 - fraction)
        + finiteSample(samples[Math.min(left + 1, samples.length - 1)]) * fraction;
    }
  } else {
    for (let i = 0; i < length; i++) {
      const start = i * ratio;
      const end = Math.min((i + 1) * ratio, samples.length);
      let sum = 0;
      for (let at = Math.floor(start); at < Math.ceil(end); at++) {
        const weight = Math.max(0, Math.min(end, at + 1) - Math.max(start, at));
        sum += finiteSample(samples[at]) * weight;
      }
      output[i] = end > start ? sum / (end - start) : 0;
    }
  }
  return output;
}

export function joinPcm(chunks, maximumSamples = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(maximumSamples) || maximumSamples < 0) throw new RangeError('Invalid audio limit');
  let length = 0;
  for (const chunk of chunks) length = Math.min(maximumSamples, length + chunk.length);
  const joined = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    const count = Math.min(chunk.length, length - offset);
    if (count <= 0) break;
    joined.set(chunk.subarray ? chunk.subarray(0, count) : chunk.slice(0, count), offset);
    offset += count;
  }
  return joined;
}

export function encodePcm16Wav(samples, rate = AUDIO_LIMITS.sampleRate) {
  sampleRate(rate);
  const dataBytes = samples.length * 2;
  if (!Number.isSafeInteger(dataBytes) || dataBytes > 0xffffffff - 36) throw new RangeError('Audio is too large');
  const wav = new Uint8Array(44 + dataBytes);
  const view = new DataView(wav.buffer);
  const tag = (at, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  tag(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // Linear PCM, not float/compressed audio.
  view.setUint16(22, 1, true); // Mono.
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  tag(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, finiteSample(samples[i])));
    view.setInt16(44 + i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true);
  }
  return wav;
}

export function wavToBase64(wav) {
  const parts = [];
  for (let offset = 0; offset < wav.length; offset += 0x8000) {
    parts.push(String.fromCharCode(...wav.subarray(offset, offset + 0x8000)));
  }
  return globalThis.btoa(parts.join(''));
}

export function createEndpointState() {
  return { elapsedMs: 0, speechRunMs: 0, hasSpeech: false, lastSpeechMs: 0, reason: null };
}

// A terminal endpoint is immutable; a noise impulse alone must not qualify as speech.
export function advanceEndpoint(state, rms, durationMs, limits = AUDIO_LIMITS) {
  if (state.reason) return state;
  if (!Number.isFinite(durationMs) || durationMs < 0) throw new RangeError('Invalid audio duration');
  const elapsedMs = state.elapsedMs + durationMs;
  const voiced = Number.isFinite(rms) && rms >= limits.voiceThreshold;
  const speechRunMs = voiced ? state.speechRunMs + durationMs : 0;
  const hasSpeech = state.hasSpeech || speechRunMs >= limits.minSpeechMs;
  const lastSpeechMs = voiced ? elapsedMs : state.lastSpeechMs;
  let reason = null;
  if (elapsedMs >= limits.maxDurationMs) reason = 'max-duration';
  else if (!hasSpeech && elapsedMs >= limits.noSpeechMs) reason = 'no-speech';
  else if (hasSpeech && elapsedMs - lastSpeechMs >= limits.silenceMs) reason = 'silence';
  return { elapsedMs, speechRunMs, hasSpeech, lastSpeechMs, reason };
}

export function selectLocalVoice(voices, language = 'zh-CN') {
  const local = Array.from(voices || []).filter(voice => voice.localService === true);
  const preferred = language.toLowerCase();
  const family = preferred.split('-')[0];
  return local.find(voice => String(voice.lang).toLowerCase() === preferred)
    || local.find(voice => String(voice.lang).toLowerCase().split('-')[0] === family)
    || null; // A missing local language is a text question, never a cloud fallback.
}

export class CaptureError extends Error {
  constructor(code) {
    super(code);
    this.name = 'CaptureError';
    this.code = code;
  }
}

function stopTracks(stream) {
  let tracks;
  try { tracks = stream?.getTracks?.() || []; } catch { return; }
  for (const track of tracks) {
    try { track.stop(); } catch { /* Continue releasing the other tracks. */ }
  }
}

// One controller = one final utterance. finish/cancel are synchronous and idempotent.
// isAllowed is rechecked both before requesting permission and after every asynchronous
// boundary. In particular, a late getUserMedia grant is stopped without creating a context.
export function createPcmCapture({
  isAllowed = () => false,
  getUserMedia = constraints => globalThis.navigator.mediaDevices.getUserMedia(constraints),
  createContext = () => new globalThis.AudioContext({ latencyHint: 'interactive' }),
  now = () => globalThis.performance.now(),
  setTimer = (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimer = timer => globalThis.clearTimeout(timer),
  onActive = () => {},
  onLevel = () => {},
  onResult = () => {},
  onError = () => {},
  limits = AUDIO_LIMITS,
} = {}) {
  // Callers may lower limits for tests, but cannot accidentally raise product safety caps.
  limits = { ...AUDIO_LIMITS, ...limits };
  for (const key of ['maxDurationMs', 'noSpeechMs', 'silenceMs', 'minSpeechMs', 'permissionTimeoutMs']) {
    if (!Number.isFinite(limits[key]) || limits[key] <= 0 || limits[key] > AUDIO_LIMITS[key]) throw new RangeError(`Invalid ${key}`);
  }
  if (limits.sampleRate !== AUDIO_LIMITS.sampleRate) throw new RangeError('Capture output must be 16 kHz');
  if (!Number.isFinite(limits.voiceThreshold) || limits.voiceThreshold <= 0 || limits.voiceThreshold > 1) throw new RangeError('Invalid voice threshold');
  let state = 'new';
  let generation = 0;
  let stream;
  let context;
  let source;
  let processor;
  let mute;
  let permissionTimer;
  let watchdogTimer;
  let active = false;
  let startedAt = 0;
  let lastVoiceAt = 0;
  let endpoint = createEndpointState();
  let chunks = [];
  let capturedSamples = 0;
  let inputRate = 0;
  const endedListeners = [];
  const notify = (callback, value) => {
    try { callback(value); } catch { /* Consumer errors cannot leak microphone resources. */ }
  };
  const allowed = () => {
    try { return isAllowed() === true; } catch { return false; }
  };
  const clearTimers = () => {
    if (permissionTimer !== undefined) clearTimer(permissionTimer);
    if (watchdogTimer !== undefined) clearTimer(watchdogTimer);
    permissionTimer = watchdogTimer = undefined;
  };
  const release = () => {
    clearTimers();
    for (const [track, listener] of endedListeners.splice(0)) {
      try { track.removeEventListener?.('ended', listener); } catch { /* Continue releasing resources. */ }
    }
    if (processor) processor.onaudioprocess = null;
    for (const node of [source, processor, mute]) {
      try { node?.disconnect(); } catch { /* A partially initialized graph is valid here. */ }
    }
    source = processor = mute = undefined;
    stopTracks(stream);
    stream = undefined;
    const previousContext = context;
    context = undefined;
    if (previousContext) {
      try { Promise.resolve(previousContext.close()).catch(() => {}); } catch { /* Already closed. */ }
    }
    if (active) {
      active = false;
      notify(onActive, false);
    }
  };
  const terminate = () => {
    if (state === 'stopped') return false;
    state = 'stopped';
    generation++;
    release();
    return true;
  };
  const cancel = () => {
    if (terminate()) chunks = [];
  };
  const fail = error => {
    if (!terminate()) return;
    chunks = [];
    notify(onError, error);
  };
  const finish = (reason = 'manual') => {
    if (!terminate()) return;
    const pcmChunks = chunks;
    chunks = [];
    const durationMs = inputRate ? capturedSamples * 1000 / inputRate : 0;
    if (!endpoint.hasSpeech || !capturedSamples) {
      notify(onResult, { reason: 'no-speech', hasSpeech: false, durationMs });
      return;
    }
    try {
      const maximumSamples = Math.floor(inputRate * limits.maxDurationMs / 1000);
      const pcm = joinPcm(pcmChunks, maximumSamples);
      const resampled = resampleMono(pcm, inputRate, limits.sampleRate);
      // Rounding a resampling ratio must never yield a WAV beyond the product duration cap.
      const maxOutput = Math.floor(limits.sampleRate * limits.maxDurationMs / 1000);
      const wav = encodePcm16Wav(resampled.subarray(0, maxOutput), limits.sampleRate);
      notify(onResult, { reason, hasSpeech: true, durationMs, wav });
    } catch {
      notify(onError, new CaptureError('encoding-failed'));
    }
  };
  const watchdog = () => {
    watchdogTimer = undefined;
    if (state === 'stopped') return;
    if (!allowed()) { cancel(); return; }
    const elapsedMs = Math.max(0, now() - startedAt);
    if (elapsedMs >= limits.maxDurationMs) { finish('max-duration'); return; }
    if (!endpoint.hasSpeech && elapsedMs >= limits.noSpeechMs) { finish('no-speech'); return; }
    if (endpoint.hasSpeech && now() - lastVoiceAt >= limits.silenceMs) { finish('silence'); return; }
    watchdogTimer = setTimer(watchdog, 100);
  };
  const start = async () => {
    if (state !== 'new') return;
    if (!allowed()) { cancel(); return; }
    state = 'requesting';
    const requestGeneration = ++generation;
    permissionTimer = setTimer(() => fail(new CaptureError('permission-timeout')), limits.permissionTimeoutMs);
    try {
      const granted = await getUserMedia({
        video: false,
        audio: { channelCount: { ideal: 1 }, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (requestGeneration !== generation || state !== 'requesting' || !allowed()) {
        stopTracks(granted);
        if (requestGeneration === generation) cancel();
        return;
      }
      clearTimer(permissionTimer);
      permissionTimer = undefined;
      stream = granted;
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length || audioTracks.every(track => track.readyState === 'ended')) {
        fail(new CaptureError('input-unavailable'));
        return;
      }
      state = 'starting';
      active = true;
      startedAt = lastVoiceAt = now();
      notify(onActive, true);
      if (requestGeneration !== generation || !allowed()) { cancel(); return; }
      for (const track of audioTracks) {
        const listener = () => fail(new CaptureError('input-ended'));
        track.addEventListener?.('ended', listener, { once: true });
        endedListeners.push([track, listener]);
      }
      watchdogTimer = setTimer(watchdog, 100);
      context = createContext();
      const ownedContext = context;
      inputRate = sampleRate(ownedContext.sampleRate);
      source = ownedContext.createMediaStreamSource(stream);
      // ScriptProcessor remains a public Web Audio API supported by the installed Electron.
      // It avoids an extra worker resource/blob/eval permission in the tightly scoped panel.
      processor = ownedContext.createScriptProcessor(2048, 1, 1);
      mute = ownedContext.createGain();
      mute.gain.value = 0;
      processor.onaudioprocess = event => {
        if (state !== 'recording') return;
        if (!allowed()) { cancel(); return; }
        try {
          const channels = [];
          for (let i = 0; i < event.inputBuffer.numberOfChannels; i++) channels.push(event.inputBuffer.getChannelData(i));
          const mono = downmixMono(channels);
          const maximumSamples = Math.floor(inputRate * limits.maxDurationMs / 1000);
          const count = Math.min(mono.length, maximumSamples - capturedSamples);
          if (count <= 0) { finish('max-duration'); return; }
          const chunk = mono.slice(0, count);
          chunks.push(chunk);
          capturedSamples += count;
          const rms = rmsLevel(chunk);
          if (rms >= limits.voiceThreshold) lastVoiceAt = now();
          endpoint = advanceEndpoint(endpoint, rms, count * 1000 / inputRate, limits);
          notify(onLevel, { rms, elapsedMs: endpoint.elapsedMs, hasSpeech: endpoint.hasSpeech });
          if (state === 'stopped') return;
          if (capturedSamples >= maximumSamples) finish('max-duration');
          else if (endpoint.reason) finish(endpoint.reason);
        } catch {
          fail(new CaptureError('audio-processing-failed'));
        }
      };
      source.connect(processor);
      processor.connect(mute);
      mute.connect(ownedContext.destination);
      await ownedContext.resume();
      if (requestGeneration !== generation || state === 'stopped' || !allowed()) {
        // release() already closed this exact context if cancelled while resume was pending.
        if (requestGeneration === generation) cancel();
        return;
      }
      state = 'recording';
    } catch (error) {
      if (requestGeneration !== generation || state === 'stopped') return;
      const code = error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'permission-denied'
        : error?.name === 'NotFoundError' || error?.name === 'NotReadableError' ? 'input-unavailable'
          : 'capture-unavailable';
      fail(new CaptureError(code));
    }
  };
  return { start, finish, cancel, dispose: cancel, get state() { return state; } };
}
