/* Static, read-only JXA entry; only lib/activity-native.js may invoke it.
 * No Apple Events, actions, screenshots, input hooks, text/body, selected text or clipboard reads.
 * Without separate context consent: AXDocument -> canonical local roots -> AXTitle, never AXChildren.
 * With consent: current focused window title + HTTPS metadata only. A role-only, bounded search may
 * locate AXWebArea/AXURL; it never reads control values, address-bar input, links or WebArea contents.
 * Bounds are best effort (AX/provider compatibility varies); the Host also enforces kill/join deadlines.
 */
ObjC.import('Cocoa');
ObjC.import('ApplicationServices');

// Suggestions/install facts only, NOT a sampling whitelist or an implicit discovery operation.
var KNOWN_APPS = [
  { id: 'com.microsoft.Word', name: 'Microsoft Word' },
  { id: 'com.microsoft.Powerpoint', name: 'Microsoft PowerPoint' },
  { id: 'com.kingsoft.wpsoffice.mac', name: 'WPS Office' }
];
// Keep in sync with lib/documents.js FILE_KINDS. Only file metadata is inspected here.
var EXTENSIONS = ['doc', 'docx', 'ppt', 'pptx', 'rtf', 'xlsx', 'xls', 'csv', 'pdf', 'txt', 'md', 'html', 'htm'];
var MAX_APPLICATIONS = 128, MAX_REQUEST_BYTES = 131072, MAX_OUTPUT_BYTES = 32768;
var DISCOVERY_SCAN_LIMIT = 1024, DISCOVERY_MS = 900;
var AX_TOTAL_MS = 900, AX_TIMEOUT_SECONDS = 0.3;
var WEB_MAX_NODES = 48, WEB_MAX_DEPTH = 5, WEB_MAX_MS = 450;
// Never descend text controls, toolbars/address bars, links, lists/tables, or a WebArea's page contents.
var WEB_CONTAINERS = ['AXWindow', 'AXGroup', 'AXSplitGroup', 'AXScrollArea', 'AXTabGroup', 'AXLayoutArea', 'AXBrowser'];
function exactKeys(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.keys(value).every(function (key) { return names.indexOf(key) !== -1; });
}
function safeString(value, maximum) {
  // Unicode mode matches lone surrogates only; normal non-BMP names/emoji remain valid.
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value);
}
function cleanText(value, maximum) {
  if (typeof value !== 'string') return '';
  // The second pass removes a surrogate split by the UTF-16 length cap.
  return value.replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu, '').trim().slice(0, maximum)
    .replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu, '').trim();
}
function validApplicationId(value) {
  return safeString(value, 255) && value === value.trim() && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(value);
}
function unique(values) {
  for (var i = 0; i < values.length; i++) if (values.indexOf(values[i]) !== i) return false;
  return true;
}
function selectedApplications(values) {
  return Array.isArray(values) && values.length <= MAX_APPLICATIONS && unique(values) && values.every(validApplicationId);
}
function positiveInteger(value) { return isFinite(value) && value >= 1 && value <= 9007199254740991 && Math.floor(value) === value; }
var fallbackClock = Date.now;
function clockNow() {
  // Monotonic local uptime keeps a wall-clock adjustment from extending AX/discovery work.
  try {
    var uptime = Number($.NSProcessInfo.processInfo.systemUptime);
    if (isFinite(uptime) && uptime >= 0) return uptime * 1000;
  } catch (_) { /* unavailable bridge still has the outer managed-process deadline */ }
  return fallbackClock();
}
function utf8Bytes(value) {
  var count = 0;
  for (var i = 0; i < value.length; i++) {
    var code = value.charCodeAt(i);
    if (code < 128) count++;
    else if (code < 2048) count += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { count += 4; i++; }
    else count += 3;
  }
  return count;
}
function canonicalPath(value) {
  if (!safeString(value, 8192) || value.charAt(0) !== '/') return null;
  try {
    var nativePath = $(value).stringByStandardizingPath.stringByResolvingSymlinksInPath;
    var resolved = ObjC.unwrap(nativePath);
    return safeString(resolved, 8192) && resolved.charAt(0) === '/' ? resolved : null;
  } catch (_) { return null; }
}
function within(root, target) { return target === root || target.indexOf(root + '/') === 0; }
function outputSample(app, document, windowHint, reason) {
  var result = { v: 1, observedAt: new Date().toISOString(), app: app };
  if (document) result.document = document;
  if (windowHint) result.window = windowHint;
  if (reason) result.reason = reason;
  var encoded = JSON.stringify(result);
  if (utf8Bytes(encoded) > MAX_OUTPUT_BYTES) {
    // Even unusually long canonical paths/Unicode labels cannot break the private pipe budget.
    return JSON.stringify({ v: 1, observedAt: result.observedAt, app: app, reason: 'DOCUMENT_NOT_AVAILABLE' });
  }
  return encoded;
}
function installedApplications() {
  return KNOWN_APPS.map(function (app) {
    var installed = null;
    try { installed = !$.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier($(app.id)).isNil(); }
    catch (_) { /* unknown is not installed=false */ }
    return { id: app.id, name: app.name, installed: installed };
  });
}
function status() {
  var trusted = Boolean($.AXIsProcessTrusted()); // Deliberately NOT a permission-requesting API.
  var result = { v: 1, platform: 'darwin', source: 'jxa-applicationservices', available: true,
    accessibilityTrusted: trusted, applications: installedApplications() };
  if (!trusted) result.reason = 'accessibility_required_for_documents';
  return JSON.stringify(result);
}
function arrayCount(value) {
  if (Array.isArray(value)) return value.length;
  try { var count = Number(value.count); if (isFinite(count) && count >= 0 && Math.floor(count) === count) return count; } catch (_) { /* CF fallback */ }
  try { return Number($.CFArrayGetCount(value)); } catch (_) { return -1; }
}
function arrayItem(value, index) {
  if (Array.isArray(value)) return value[index];
  // CFArray/NSArray toll-free bridging avoids a recursive/deep unwrap of any AX tree.
  return value.objectAtIndex(index);
}
function discoverApplications() {
  // Explicit Human refresh only. Never call AX, read foreground state, titles, URLs or history here.
  var started = clockNow(), running = $.NSWorkspace.sharedWorkspace.runningApplications;
  var count = arrayCount(running);
  if (!isFinite(count) || count < 0 || Math.floor(count) !== count) throw new Error('unavailable');
  var truncated = count > DISCOVERY_SCAN_LIMIT, byId = Object.create(null);
  for (var i = 0; i < Math.min(count, DISCOVERY_SCAN_LIMIT); i++) {
    if (clockNow() - started >= DISCOVERY_MS) { truncated = true; break; }
    try {
      var candidate = arrayItem(running, i), policy = Number(candidate.activationPolicy);
      if (policy !== 0 && policy !== 1 || Boolean(candidate.terminated)) continue; // regular or accessory GUI apps
      var id = ObjC.unwrap(candidate.bundleIdentifier);
      if (!validApplicationId(id)) continue;
      var name = id;
      try { name = cleanText(ObjC.unwrap(candidate.localizedName), 256) || id; } catch (_) { /* identity still usable */ }
      // regular (0) = has Dock/window presence and can become the frontmost app with
      // context; accessory (1) = menu-bar/system agent. Both stay selectable, but the
      // Host/UI can label the latter and hide them from the default candidate list.
      var foreground = policy === 0;
      if (!byId[id] || name < byId[id].name) byId[id] = { id: id, name: name, installed: true, running: true, foreground: foreground };
    } catch (_) { /* an app may exit during explicit discovery */ }
  }
  var found = Object.keys(byId).sort().map(function (id) { return byId[id]; });
  if (found.length > MAX_APPLICATIONS) truncated = true;
  var result = { v: 1, platform: 'darwin', source: 'jxa-applicationservices', applications: [], truncated: truncated };
  // Reserve the longer "false" spelling. 128 long Unicode labels must not overflow private stdout.
  var bytes = utf8Bytes(JSON.stringify({ v: 1, platform: 'darwin', source: 'jxa-applicationservices', applications: [], truncated: false }));
  for (var j = 0; j < found.length; j++) {
    var added = utf8Bytes(JSON.stringify(found[j])) + (result.applications.length ? 1 : 0);
    if (result.applications.length >= MAX_APPLICATIONS || bytes + added > MAX_OUTPUT_BYTES) { result.truncated = true; break; }
    result.applications.push(found[j]); bytes += added;
  }
  return JSON.stringify(result);
}
function attributeText(value, maximum) {
  if (!value) return null;
  try {
    var text = ObjC.unwrap(value);
    if (typeof text !== 'string' && typeof $.CFGetTypeID === 'function' && $.CFGetTypeID(value) === $.CFURLGetTypeID()) {
      text = ObjC.unwrap($.CFURLGetString(value));
    }
    return safeString(text, maximum) ? text : null;
  } catch (_) { return null; }
}
function metadataUrl(value) {
  // Conservative JXA equivalent; the Host applies normalizeActivityUrl again with WHATWG URL/IP parsing.
  var text = attributeText(value, 2048);
  if (!text || text !== text.trim() || text.indexOf('\\') !== -1) return null;
  var match = /^https:\/\/([^/?#]+)([^?#]*)(?:\?[^#]*)?(?:#.*)?$/i.exec(text);
  if (!match || /[@%\[\]]/.test(match[1])) return null;
  var authority = /^([^:]+)(?::([0-9]{1,5}))?$/.exec(match[1]);
  if (!authority) return null;
  var hostname = authority[1].toLowerCase().replace(/\.$/, '');
  var labels = hostname.split('.'), last = labels[labels.length - 1];
  if (hostname.length > 253 || labels.length < 2 || hostname === 'localhost' || /\.(?:localhost|local)$/.test(hostname) ||
      !labels.every(function (label) { return label === label.trim() && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label); }) ||
      /^(?:[0-9]+|0x[0-9a-f]+)$/i.test(last)) return null; // all numeric/hex IPv4 forms, plus IPv6 above
  var port = authority[2] ? Number(authority[2]) : null;
  if (port !== null && (!isFinite(port) || port < 1 || port > 65535)) return null;
  var pathname = match[2] || '/';
  try { var decoded = decodeURIComponent(pathname); if (!safeString(decoded, 8192)) return null; } catch (_) { return null; }
  var result = 'https://' + hostname + (port !== null && port !== 443 ? ':' + port : '') + pathname;
  return safeString(result, 2048) ? result : null; // query/hash never enter IPC or storage
}
function documentPath(value, roots) {
  var text = attributeText(value, 24576);
  if (!text || !/^file:\/\//i.test(text) || /%(?:00|2f|5c)/i.test(text)) return { reason: 'DOCUMENT_NOT_AVAILABLE' };
  try {
    var url = $.NSURL.URLWithString($(text));
    if (url.isNil() || !Boolean(url.isFileURL)) return { reason: 'DOCUMENT_NOT_AVAILABLE' };
    var host = ObjC.unwrap(url.host);
    if (host && host !== 'localhost') return { reason: 'DOCUMENT_NOT_AVAILABLE' };
    var path = canonicalPath(ObjC.unwrap(url.path));
    if (!path) return { reason: 'DOCUMENT_NOT_AVAILABLE' };
    // No title or file stat outside canonical approved roots, even if independent window consent exists.
    if (!roots.some(function (root) { return within(root, path); })) return { reason: 'DOCUMENT_OUT_OF_SCOPE' };
    var extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    if (EXTENSIONS.indexOf(extension) === -1) return { reason: 'DOCUMENT_NOT_AVAILABLE' };
    var isDirectory = Ref();
    if (!$.NSFileManager.defaultManager.fileExistsAtPathIsDirectory($(path), isDirectory) || Boolean(isDirectory[0])) return { reason: 'DOCUMENT_NOT_AVAILABLE' };
    var attributes = $.NSFileManager.defaultManager.attributesOfItemAtPathError($(path), Ref());
    if (attributes.isNil() || ObjC.unwrap(attributes.objectForKey($.NSFileType)) !== ObjC.unwrap($.NSFileTypeRegular)) return { reason: 'DOCUMENT_NOT_AVAILABLE' };
    return { path: path };
  } catch (_) { return { reason: 'DOCUMENT_NOT_AVAILABLE' }; }
}
function axCall(element, budget, invoke) {
  if (budget.failed || budget.expired) return false;
  var remaining = budget.deadline - clockNow();
  if (remaining <= 0) { budget.expired = true; return false; }
  try {
    // Every getter/count/slice is individually bounded; never fall back to an unbounded getter.
    if (Number($.AXUIElementSetMessagingTimeout(element, Math.min(AX_TIMEOUT_SECONDS, remaining / 1000))) !== 0) { budget.failed = true; return false; }
    var code = Number(invoke());
    if (clockNow() >= budget.deadline) { budget.expired = true; return false; }
    if (code !== 0) {
      // Unsupported/absent OPTIONAL metadata is normal, not proof of an empty/complete tree.
      // Not-implemented, attribute-unsupported and no-value are normal for OPTIONAL
      // attributes on many apps; cannot-complete/invalid-element stay fatal.
      if (code !== -25205 && code !== -25211 && code !== -25212) budget.failed = true;
      return false;
    }
    return true;
  } catch (_) { budget.failed = true; return false; }
}
// Real JXA replaces the $() placeholder with the bridged value; some bridges (and
// the VM test double) hand back an array whose [0] is the value. Accept both.
function outValue(holder) { return Array.isArray(holder) ? holder[0] : holder; }
function copyAttribute(element, name, budget) {
  // Object out-parameters must use the $() placeholder: Ref()[0] is not the
  // AXUIElement on this JXA build (every later read then fails with -25201).
  var value = $();
  return axCall(element, budget, function () { return $.AXUIElementCopyAttributeValue(element, $(name), value); }) ? outValue(value) : null;
}
function childCount(element, budget) {
  var count = Ref();
  if (!axCall(element, budget, function () { return $.AXUIElementGetAttributeValueCount(element, $('AXChildren'), count); })) return 0;
  var result = Number(count[0]);
  if (!isFinite(result) || result < 0 || Math.floor(result) !== result) { budget.incomplete = true; return 0; }
  return result;
}
function children(element, count, budget) {
  var value = $();
  if (!axCall(element, budget, function () { return $.AXUIElementCopyAttributeValues(element, $('AXChildren'), 0, count, value); })) { budget.incomplete = true; return []; }
  var slice = outValue(value), received = arrayCount(slice);
  if (!isFinite(received) || received < 0 || received !== count) { budget.incomplete = true; return []; }
  var result = [];
  try { for (var i = 0; i < received; i++) result.push(arrayItem(slice, i)); }
  catch (_) { budget.incomplete = true; return []; }
  return result;
}
function webAreaUrl(window, budget) {
  var deadline = Math.min(clockNow() + WEB_MAX_MS, budget.deadline - AX_TIMEOUT_SECONDS * 1000);
  var queue = [{ element: window, depth: 0 }], visited = [], nodes = 0;
  while (queue.length) {
    if (clockNow() >= deadline || nodes >= WEB_MAX_NODES || budget.failed || budget.expired) { budget.incomplete = true; break; }
    var next = queue.shift();
    // Identity check bounds repeated/cyclic native references without reading any extra AX attributes.
    if (visited.indexOf(next.element) !== -1) { budget.incomplete = true; continue; }
    visited.push(next.element); nodes++;
    var role = attributeText(copyAttribute(next.element, 'AXRole', budget), 64);
    if (clockNow() >= deadline) { budget.incomplete = true; break; }
    if (!role) { budget.incomplete = true; continue; }
    if (role === 'AXWebArea') {
      var url = metadataUrl(copyAttribute(next.element, 'AXURL', budget));
      if (clockNow() >= deadline) { budget.incomplete = true; break; }
      if (url) return url;
      continue; // NEVER descend page body nodes, even when its URL is absent/unsafe.
    }
    if (WEB_CONTAINERS.indexOf(role) === -1) continue;
    var available = childCount(next.element, budget);
    if (clockNow() >= deadline) { budget.incomplete = true; break; }
    if (!available) continue;
    if (next.depth >= WEB_MAX_DEPTH) { budget.incomplete = true; continue; }
    var remaining = WEB_MAX_NODES - nodes - queue.length;
    if (available > remaining) budget.incomplete = true;
    var take = Math.min(available, remaining);
    if (take <= 0) continue;
    var values = children(next.element, take, budget);
    if (clockNow() >= deadline) { budget.incomplete = true; break; }
    for (var i = 0; i < values.length; i++) queue.push({ element: values[i], depth: next.depth + 1 });
  }
  return null;
}
function currentIdentity(id, pid) {
  try {
    var current = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!current || current.isNil()) return 'changed';
    var currentId = ObjC.unwrap(current.bundleIdentifier);
    if (!validApplicationId(currentId)) return 'unavailable';
    if (currentId !== id) return 'changed'; // never read another app's localizedName/title
    var currentPid = Number(current.processIdentifier);
    if (!positiveInteger(currentPid)) return 'unavailable';
    return currentPid === pid ? 'same' : 'changed';
  } catch (_) { return 'unavailable'; }
}
function sample(request) {
  // NSWorkspace identity needs no AX permission. Do not read an unselected app's display name.
  var front, id, pid;
  try {
    front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    if (!front || front.isNil()) return outputSample(null, null, null, 'NO_FRONTMOST_APPLICATION');
    id = ObjC.unwrap(front.bundleIdentifier);
    if (!validApplicationId(id)) return outputSample(null, null, null, 'SOURCE_UNAVAILABLE');
  } catch (_) { return outputSample(null, null, null, 'SOURCE_UNAVAILABLE'); }
  if (request.applications.indexOf(id) === -1) return outputSample(null, null, null, 'APP_NOT_ALLOWED');
  try { pid = Number(front.processIdentifier); } catch (_) { return outputSample(null, null, null, 'SOURCE_UNAVAILABLE'); }
  if (!positiveInteger(pid)) return outputSample(null, null, null, 'SOURCE_UNAVAILABLE');
  var name = id;
  try { name = cleanText(ObjC.unwrap(front.localizedName), 256) || id; } catch (_) { /* identity still usable */ }
  var app = { id: id, name: name, pid: pid }, contextAllowed = request.contextApplications.indexOf(id) !== -1;
  // This branch is before ALL AX calls, including trust and AX element creation.
  if (!request.roots.length && !contextAllowed) return outputSample(app, null, null, 'NO_ALLOWED_ROOTS');
  try { if (!Boolean($.AXIsProcessTrusted())) return outputSample(app, null, null, 'accessibility_required_for_documents'); }
  catch (_) { return outputSample(app, null, null, 'SOURCE_UNAVAILABLE'); }
  var roots = request.roots.map(canonicalPath);
  if (roots.some(function (root, index) { return !root || root !== request.roots[index]; })) return outputSample(app, null, null, 'INVALID_SCOPE');
  var budget = { deadline: clockNow() + AX_TOTAL_MS, failed: false, expired: false, incomplete: false }, nativeApp;
  try { nativeApp = $.AXUIElementCreateApplication(pid); } catch (_) { return outputSample(app, null, null, 'DOCUMENT_NOT_AVAILABLE'); }
  if (!nativeApp) return outputSample(app, null, null, 'DOCUMENT_NOT_AVAILABLE');
  var window = copyAttribute(nativeApp, 'AXFocusedWindow', budget);
  if (!window) return outputSample(app, null, null, 'DOCUMENT_NOT_AVAILABLE');
  var rawDocument = copyAttribute(window, 'AXDocument', budget);
  var local = roots.length ? documentPath(rawDocument, roots) : { reason: 'NO_ALLOWED_ROOTS' };
  var document = local.path ? { path: local.path } : null, title = '';
  // Without independent consent, this is the first and ONLY title read, strictly after the local-file gate.
  if (document || contextAllowed) {
    try { title = cleanText(ObjC.unwrap(copyAttribute(window, 'AXTitle', budget)), 512); } catch (_) { /* optional */ }
    if (document && title) document.title = title;
  }
  var windowHint = null;
  if (contextAllowed) {
    var url = metadataUrl(rawDocument);
    if (!url) url = metadataUrl(copyAttribute(window, 'AXURL', budget));
    // A known file document needs no speculative WebArea search (including out-of-root local files).
    var rawText = attributeText(rawDocument, 24576);
    if (!url && (!rawText || !/^file:/i.test(rawText)) && !budget.failed && !budget.expired) url = webAreaUrl(window, budget);
    if (title || url) {
      windowHint = {};
      if (title) windowHint.title = title;
      if (url) windowHint.url = url;
    }
  }
  var identity = currentIdentity(id, pid);
  if (identity !== 'same') return outputSample(app, null, null, identity === 'changed' ? 'FOCUS_CHANGED' : 'SOURCE_UNAVAILABLE');
  // A deadline blowout is not trusted (ordering unknown), but an unsupported or
  // capped optional attribute must not discard a title that was already read from
  // the focused window we just re-verified: only the missing URL stays absent.
  if (budget.expired) return outputSample(app, null, null, 'DOCUMENT_NOT_AVAILABLE');
  if (document || windowHint) {
    var currentWindow = copyAttribute(nativeApp, 'AXFocusedWindow', budget), sameWindow = false;
    try { sameWindow = Boolean(currentWindow) && Boolean($.CFEqual(window, currentWindow)); } catch (_) { /* cannot confirm focus */ }
    if (!sameWindow || budget.failed || budget.expired) return outputSample(app, null, null, 'FOCUS_CHANGED');
    identity = currentIdentity(id, pid);
    if (identity !== 'same') return outputSample(app, null, null, identity === 'changed' ? 'FOCUS_CHANGED' : 'SOURCE_UNAVAILABLE');
  }
  return outputSample(app, document, windowHint, document || windowHint ? null : local.reason);
}
function validRoot(root) {
  if (!safeString(root, 8192) || root.charAt(0) !== '/' || root === '/' || root.charAt(root.length - 1) === '/') return false;
  return !root.split('/').some(function (part, index) { return index > 0 && (!part || part === '.' || part === '..'); });
}
function run(argv) {
  try {
    if (!Array.isArray(argv) || argv.length !== 1 || typeof argv[0] !== 'string' || utf8Bytes(argv[0]) > MAX_REQUEST_BYTES) throw new Error('invalid');
    var request = JSON.parse(argv[0]);
    if (!exactKeys(request, ['v', 'action', 'applications', 'contextApplications', 'roots']) || request.v !== 1) throw new Error('invalid');
    if (request.action === 'status' || request.action === 'applications') {
      if (Object.keys(request).length !== 2) throw new Error('invalid');
      return request.action === 'status' ? status() : discoverApplications();
    }
    if (request.action !== 'sample' || !selectedApplications(request.applications) || !Array.isArray(request.roots) || request.roots.length > 32 ||
        !unique(request.roots) || !request.roots.every(validRoot)) throw new Error('invalid');
    if (request.contextApplications === undefined) request.contextApplications = []; // backwards-compatible default is OFF
    if (!selectedApplications(request.contextApplications) || !request.contextApplications.every(function (id) { return request.applications.indexOf(id) !== -1; })) throw new Error('invalid');
    if (!request.applications.length) return outputSample(null, null, null, 'NO_SELECTED_APPLICATIONS');
    return sample(request);
  } catch (_) {
    // Never copy a native exception, real title, URL, filename, name or request argument into stderr.
    return JSON.stringify({ v: 1, error: 'SOURCE_UNAVAILABLE' });
  }
}
