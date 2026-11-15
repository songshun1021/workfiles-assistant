// Workfiles Voice wire protocol v1. No Electron or third-party dependencies.
// All validators return a fresh, frozen, shallow record or throw ProtocolError.
export const MAX_LINE_BYTES = 3 * 1024 * 1024;
export const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
export const PHASES = Object.freeze(['ready', 'preparing', 'listening', 'transcribing', 'working', 'question', 'done', 'error']);
export const ACTIONS = Object.freeze(['prepare', 'retry', 'cancel', 'dismiss']);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const own = (value, key) => Object.hasOwn(value, key);

export class ProtocolError extends Error {
  constructor(code, message) { super(message); this.name = 'ProtocolError'; this.code = code; }
}
function fail(message, code = 'INVALID_MESSAGE') { throw new ProtocolError(code, message); }
function text(value, label, max, { nonempty = true, controls = false } = {}) {
  if (typeof value !== 'string' || value.length > max || (nonempty && !value.trim()) || (!controls && /[\u0000-\u001f\u007f]/u.test(value))) fail(`Invalid ${label}`);
}
function id(value, label = 'activationId') {
  text(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)) fail(`Invalid ${label}`);
}
function bool(value, label) { if (typeof value !== 'boolean') fail(`Invalid ${label}`); }
function record(input) {
  let value = input;
  if (input instanceof Uint8Array) {
    if (input.byteLength > MAX_LINE_BYTES) fail('JSON line exceeds limit', 'LINE_TOO_LARGE');
    try { value = decoder.decode(input); } catch { fail('Invalid UTF-8', 'INVALID_UTF8'); }
  }
  if (typeof value === 'string') {
    if (encoder.encode(value).byteLength > MAX_LINE_BYTES) fail('JSON line exceeds limit', 'LINE_TOO_LARGE');
    try { value = JSON.parse(value); } catch { fail('Invalid JSON', 'INVALID_JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('Expected a plain message record');
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) if (!own(descriptor, 'value')) fail('Message accessors are not permitted');
  if (value.v !== 1 || typeof value.type !== 'string') fail('Unsupported protocol version or message type');
  return value;
}
function fields(value, required, optional = []) {
  const allowed = new Set(['v', 'type', ...required, ...optional]);
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !allowed.has(key))) fail('Unknown message field');
  if (required.some(key => !own(value, key))) fail('Missing message field');
  for (const key of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !own(descriptor, 'value')) fail('Message accessors are not permitted');
  }
}
function finish(value) {
  const result = { ...value };
  if (encoder.encode(JSON.stringify(result)).byteLength > MAX_LINE_BYTES) fail('JSON line exceeds limit', 'LINE_TOO_LARGE');
  return Object.freeze(result);
}
function optionalText(value, key, max) { if (own(value, key)) text(value[key], key, max, { nonempty: false, controls: true }); }

/** Conservative global accelerators: never steal bare typing, Escape, or common destructive/system keys. */
export function validateShortcut(value) {
  text(value, 'shortcut', 128);
  if (value.trim() !== value) fail('Invalid global shortcut', 'UNSAFE_SHORTCUT');
  const parts = value.split('+');
  const aliases = { commandorcontrol: 'primary', cmdorctrl: 'primary', command: 'command', cmd: 'command', control: 'control', ctrl: 'control', alt: 'alt', option: 'alt', shift: 'shift', super: 'super', meta: 'super' };
  const key = parts.pop()?.toUpperCase();
  const modifiers = parts.map(part => aliases[part.toLowerCase()]);
  const unique = new Set(modifiers);
  if (!key || !/^(?:[A-Z0-9]|SPACE|F(?:[1-9]|1[0-9]|2[0-4]))$/u.test(key) || modifiers.some(part => !part) || unique.size !== modifiers.length ||
      !modifiers.some(part => part !== 'shift') || unique.has('primary') && (unique.has('command') || unique.has('control'))) fail('Unsafe global shortcut', 'UNSAFE_SHORTCUT');
  if (/^[A-Z0-9]$/u.test(key) && modifiers.length < 2) fail('Global typing shortcuts require two modifiers', 'UNSAFE_SHORTCUT');
  const primary = ['primary', 'command', 'control', 'super'].some(part => unique.has(part));
  if (primary && (['Q', 'W'].includes(key) || key === 'SPACE' && modifiers.length === 1 || ['3', '4', '5'].includes(key) && unique.has('shift'))) fail('Reserved global shortcut', 'UNSAFE_SHORTCUT');
  return value;
}

export function parseHostMessage(input) {
  const m = record(input);
  switch (m.type) {
    case 'init':
      fields(m, ['shortcut', 'title']); validateShortcut(m.shortcut); text(m.title, 'title', 120); break;
    case 'toggle': fields(m, []); break;
    case 'show':
      fields(m, ['activationId', 'capture']); id(m.activationId); bool(m.capture, 'capture'); break;
    case 'state':
      fields(m, ['activationId', 'phase'], ['message', 'detail', 'listen', 'canPrepare', 'progress', 'items']); id(m.activationId);
      if (!PHASES.includes(m.phase)) fail('Invalid phase');
      optionalText(m, 'message', 1000); optionalText(m, 'detail', 1000);
      if (own(m, 'items')) {
        // Display-only rows for the panel. They carry no id and no path authority, so the
        // renderer can show what was found without ever holding an open capability.
        if (!Array.isArray(m.items) || m.items.length > 5) fail('Invalid items');
        for (const item of m.items) {
          if (!item || typeof item !== 'object' || Array.isArray(item) || Object.getPrototypeOf(item) !== Object.prototype) fail('Invalid items');
          for (const key of Reflect.ownKeys(item)) {
            if (!['name', 'folder', 'modifiedAt', 'type', 'copy', 'copyKind'].includes(key)) fail('Unknown item field');
            if (!own(Object.getOwnPropertyDescriptor(item, key) || {}, 'value')) fail('Message accessors are not permitted');
          }
          text(item.name, 'items.name', 300);
          optionalText(item, 'folder', 4096);
          optionalText(item, 'modifiedAt', 64);
          // Presentation only: a short type chip and the exact text a copy button writes.
          // Neither is a capability — the renderer can display them, not open anything.
          optionalText(item, 'type', 8);
          optionalText(item, 'copy', 4096);
          if (own(item, 'copyKind') && item.copyKind !== 'path' && item.copyKind !== 'link') fail('Invalid copy kind');
        }
      }
      if (own(m, 'listen')) bool(m.listen, 'listen');
      if (own(m, 'canPrepare')) bool(m.canPrepare, 'canPrepare');
      if (own(m, 'progress') && (typeof m.progress !== 'number' || !Number.isFinite(m.progress) || m.progress < 0 || m.progress > 1)) fail('Invalid progress');
      if (m.listen === true && !['listening', 'question'].includes(m.phase)) fail('Listening is only valid in listening/question phase');
      break;
    case 'hide': fields(m, [], ['activationId']); if (own(m, 'activationId')) id(m.activationId); break;
    case 'configure': fields(m, ['shortcut'], ['configurationId']); validateShortcut(m.shortcut); if (own(m, 'configurationId')) id(m.configurationId, 'configurationId'); break;
    case 'shutdown': fields(m, []); break;
    default: fail('Unknown Host message type');
  }
  return finish(m);
}

export function parseHelperMessage(input) {
  const m = record(input);
  switch (m.type) {
    case 'ready':
      fields(m, ['shortcut', 'registered', 'platform', 'electronVersion'], ['configurationId']); text(m.shortcut, 'shortcut', 128); bool(m.registered, 'registered');
      text(m.platform, 'platform', 32); text(m.electronVersion, 'electronVersion', 64); if (own(m, 'configurationId')) id(m.configurationId, 'configurationId'); break;
    case 'activated':
      fields(m, ['activationId', 'source', 'capture']); id(m.activationId); bool(m.capture, 'capture');
      if (!['shortcut', 'panel', 'host'].includes(m.source)) fail('Invalid activation source'); break;
    case 'audio': {
      fields(m, ['activationId', 'utteranceId', 'wavBase64']); id(m.activationId); id(m.utteranceId, 'utteranceId');
      if (typeof m.wavBase64 !== 'string' || !m.wavBase64.length || m.wavBase64.length > 4 * Math.ceil(MAX_AUDIO_BYTES / 3) || m.wavBase64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(m.wavBase64)) fail('Invalid bounded base64 audio');
      const padding = m.wavBase64.endsWith('==') ? 2 : m.wavBase64.endsWith('=') ? 1 : 0;
      if (m.wavBase64.length / 4 * 3 - padding > MAX_AUDIO_BYTES) fail('Audio exceeds limit');
      // Require canonical padding bits as well as an alphabet check. Header/duration
      // validation remains the Host's mandatory check before any ASR request.
      if (typeof Buffer !== 'undefined' && Buffer.from(m.wavBase64, 'base64').toString('base64') !== m.wavBase64) fail('Non-canonical base64 audio');
      break;
    }
    case 'text':
      fields(m, ['activationId', 'utteranceId', 'text']); id(m.activationId); id(m.utteranceId, 'utteranceId');
      text(m.text, 'text', 2000, { controls: true }); break;
    case 'action':
      fields(m, ['activationId', 'name']); id(m.activationId); if (!ACTIONS.includes(m.name)) fail('Invalid action'); break;
    case 'capture':
      fields(m, ['activationId', 'active']); id(m.activationId); bool(m.active, 'active'); break;
    case 'notice': case 'fatal':
      fields(m, ['code', 'message']); text(m.code, 'code', 64); text(m.message, 'message', 1000, { controls: true }); break;
    case 'closed': fields(m, [], ['activationId']); if (own(m, 'activationId')) id(m.activationId); break;
    default: fail('Unknown helper message type');
  }
  return finish(m);
}

export function encodeMessage(input) {
  const value = ['init', 'show', 'toggle', 'state', 'hide', 'configure', 'shutdown'].includes(input?.type) ? parseHostMessage(input) : parseHelperMessage(input);
  return `${JSON.stringify(value)}\n`;
}

// Byte-bounded incremental framing: unlike readline, a missing newline cannot
// allocate an unbounded string. Errors are terminal; no payload is echoed.
export function createLineDecoder({ parse = parseHostMessage, onMessage, onError }) {
  let chunks = [], bytes = 0, failed = false;
  const reject = error => { failed = true; chunks = []; bytes = 0; onError(error); };
  return Object.freeze({
    push(chunk) {
      if (failed) return;
      if (!(chunk instanceof Uint8Array)) { reject(new ProtocolError('INVALID_CHUNK', 'Expected transport bytes')); return; }
      let start = 0;
      for (let index = 0; index <= chunk.byteLength; index++) {
        if (index !== chunk.byteLength && chunk[index] !== 10) continue;
        const piece = chunk.subarray(start, index);
        if (bytes + piece.byteLength > MAX_LINE_BYTES) { reject(new ProtocolError('LINE_TOO_LARGE', 'JSON line exceeds limit')); return; }
        if (piece.byteLength) { chunks.push(piece); bytes += piece.byteLength; }
        if (index !== chunk.byteLength) {
          try {
            const line = new Uint8Array(bytes); let offset = 0;
            for (const part of chunks) { line.set(part, offset); offset += part.byteLength; }
            chunks = []; bytes = 0; onMessage(parse(line));
          } catch (error) { reject(error); return; }
        }
        start = index + 1;
      }
    },
    end() {
      if (!failed && bytes) reject(new ProtocolError('TRUNCATED_LINE', 'Transport ended inside a JSON line'));
      failed = true; chunks = []; bytes = 0;
    },
  });
}
