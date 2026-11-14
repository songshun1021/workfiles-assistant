// Shared, dependency-free policy used by the real Electron main and its tests.
export const FEATURE_SCHEME = 'workfiles-voice';
export const FEATURE_ORIGIN = `${FEATURE_SCHEME}://panel`;
export const FEATURE_URL = `${FEATURE_ORIGIN}/index.html`;
export const RESOURCE_TYPES = Object.freeze({
  'index.html': 'text/html; charset=utf-8',
  'panel.js': 'text/javascript; charset=utf-8',
  'panel.css': 'text/css; charset=utf-8',
  'audio.js': 'text/javascript; charset=utf-8',
  'view-state.js': 'text/javascript; charset=utf-8',
  'icon.svg': 'image/svg+xml',
});
export const CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; media-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'none'; frame-ancestors 'none'";

// Exact matching deliberately disallows credentials, queries, fragments, ports,
// percent-encoded paths and every origin/path outside the six controlled UI resources.
export function resourceForURL(value) {
  if (typeof value !== 'string') return null;
  for (const name of Object.keys(RESOURCE_TYPES)) if (value === `${FEATURE_ORIGIN}/${name}`) return name;
  return null;
}
export function isFeatureOrigin(value) { return value === FEATURE_ORIGIN || value === `${FEATURE_ORIGIN}/`; }
export function isTrustedSender({ sender, senderFrame }, webContents) {
  if (!webContents || webContents.isDestroyed() || sender !== webContents || !senderFrame) return false;
  return senderFrame === webContents.mainFrame && senderFrame.parent === null && senderFrame.url === FEATURE_URL && webContents.getURL() === FEATURE_URL;
}

export function allowAudioPermission({ kind, permission, origin, details = {}, webContents, window, controller }) {
  if (permission !== 'media' || !webContents || !window || window.isDestroyed() || !window.isVisible() || webContents !== window.webContents || webContents.isDestroyed()) return false;
  if (webContents.getURL() !== FEATURE_URL || webContents.mainFrame?.url !== FEATURE_URL || webContents.mainFrame?.parent !== null || details.isMainFrame !== true) return false;
  if (details.requestingUrl !== FEATURE_URL || controller?.mayCapture() !== true) return false;
  if (kind === 'check') return isFeatureOrigin(origin) && details.mediaType === 'audio';
  if (kind === 'request') return Array.isArray(details.mediaTypes) && details.mediaTypes.length === 1 && details.mediaTypes[0] === 'audio';
  return false;
}
