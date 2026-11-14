import { isIP } from 'node:net';
import { z } from 'zod';

export const MAX_ACTIVITY_APPLICATIONS = 128;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu;
const wellFormed = value => typeof value === 'string' && value.isWellFormed();
const cleanText = (value, limit) => typeof value === 'string'
  ? value.replace(UNSAFE_TEXT, '').trim().slice(0, limit).replace(UNSAFE_TEXT, '').trim() : '';

// These are identifiers, never property names, instructions, paths, or shell text.
export const ApplicationIdSchema = z.string().max(255).regex(/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+(?![\s\S])/u);
export function isApplicationId(value) {
  try { return ApplicationIdSchema.safeParse(value).success; } catch { return false; }
}

/** Pure canonicalization only. No DNS, network, filesystem, or OS work. */
export function normalizeActivityUrl(value) {
  try {
    if (!wellFormed(value) || !value.length || value.length > 2048 || CONTROL.test(value) || value !== value.trim() || value.includes('\\') || !/^https:\/\//iu.test(value)) return null;
    const authority = value.slice(value.indexOf('//') + 2).split(/[/?#]/u, 1)[0];
    if (authority.includes('@')) return null;
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, '');
    const ip = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    if (!hostname || isIP(ip) || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === 'local' || hostname.endsWith('.local')) return null;
    // Refuse single-label/intranet hosts and malformed DNS labels as well as IPs.
    if (!hostname.includes('.') || hostname.length > 253 || !hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) return null;
    url.hostname = hostname;
    url.search = ''; url.hash = '';
    const decodedPath = decodeURIComponent(url.pathname);
    if (!wellFormed(decodedPath) || CONTROL.test(decodedPath)) return null;
    const canonical = url.href;
    return canonical.length <= 2048 ? canonical : null;
  } catch { return null; }
}

function ownHint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Reflect.ownKeys(value).every(key => (key === 'title' || key === 'url') && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}
const WindowShape = z.object({
  title: z.string().min(1).max(512).refine(value => wellFormed(value) && !CONTROL.test(value) && value.trim() === value).optional(),
  url: z.string().max(2048).refine(value => normalizeActivityUrl(value) === value).optional(),
}).strict().refine(value => value.title !== undefined || value.url !== undefined);
// Guard before Zod can read inherited fields or accessors from an untrusted object.
export const WindowHintSchema = z.preprocess(value => {
  try { return ownHint(value) ? value : null; } catch { return null; }
}, WindowShape);

/** Return a fresh, bounded hint, never native extras or a caller-owned reference. */
export function normalizeWindowHint(value) {
  try {
    if (!ownHint(value)) return null;
    const title = cleanText(value.title, 512);
    const url = normalizeActivityUrl(value.url);
    const hint = { ...(title ? { title } : {}), ...(url ? { url } : {}) };
    const parsed = WindowHintSchema.safeParse(hint);
    return parsed.success ? parsed.data : null;
  } catch { return null; }
}

/** Shared sanitization for native application labels; labels remain untrusted data. */
export function normalizeApplicationName(value, fallback) {
  return cleanText(value, 256) || cleanText(fallback, 256);
}
