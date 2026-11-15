import os from 'node:os';

/** Bounded, shell-free subprocess adapter using the Harness-owned process service. */
export function createNativeRunner(subprocess, { cwd = os.homedir(), timeoutMs = 5000 } = {}) {
  return async function run(argv, { signal, maxBytes = 512 * 1024, timeout = timeoutMs } = {}) {
    signal?.throwIfAborted();
    const deadline = AbortSignal.timeout(timeout);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const child = subprocess.spawn({
      argv,
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: os.homedir(), LANG: 'en_US.UTF-8', TMPDIR: os.tmpdir() },
      stdio: { stdin: 'ignore', stdout: { maxBytes }, stderr: { maxBytes: 8192 } },
      graceMs: 250,
      signal: combined,
    });
    try {
      const outcome = await child.done;
      combined.throwIfAborted();
      const stdout = child.collected.stdout?.readFrom(0);
      const stderr = child.collected.stderr?.readFrom(0);
      if (outcome.exitCode !== 0 || outcome.signal) {
        const error = new Error((stderr?.text || `Command failed (${outcome.exitCode ?? outcome.signal})`).slice(0, 1000));
        error.code = 'NATIVE_COMMAND_FAILED';
        throw error;
      }
      return { stdout: stdout?.text || '', truncated: stdout?.lossy === true };
    } finally {
      if (combined.aborted) {
        child.terminate();
        await child.waitForExit().catch(() => false);
      }
    }
  };
}

export function escapeSpotlightString(value) {
  // The query grammar is not a shell, but quotes, escapes and wildcards still need escaping.
  return String(value).replace(/[\\"*?]/gu, '\\$&').replace(/[\x00-\x1f\x7f]/gu, ' ');
}

export function spotlightQuery(terms, extensions) {
  const types = extensions.map(ext => `kMDItemFSName == "*.${escapeSpotlightString(ext)}"cd`).join(' || ');
  const names = terms.map(term => `kMDItemDisplayName == "*${escapeSpotlightString(term)}*"cd`).join(' || ');
  return `(${types})${names ? ` && (${names})` : ''}`;
}

export async function spotlightCandidates(run, root, terms, extensions, signal) {
  const response = await run(['/usr/bin/mdfind', '-0', '-onlyin', root, spotlightQuery(terms, extensions)], { signal });
  const parts = response.stdout.split('\0');
  // A bounded tail may begin/end in the middle of a path. Never admit either partial path.
  if (response.truncated) parts.shift();
  if (parts.at(-1) !== '') parts.pop();
  return { paths: parts.filter(Boolean).slice(0, 2000), truncated: response.truncated || parts.length > 2001 };
}

/** Same bounded mdfind contract, but matching the indexed document body instead of the
 * name. This is the only cheap way to reach files whose name says nothing about their
 * topic; it stays an accelerator — the caller still re-derives identity, scope and type
 * for every path it returns, and falls back to local extraction for unindexed files. */
export function spotlightContentQuery(terms, extensions) {
  const types = extensions.map(ext => `kMDItemFSName == "*.${escapeSpotlightString(ext)}"cd`).join(' || ');
  const texts = terms.map(term => `kMDItemTextContent == "*${escapeSpotlightString(term)}*"cd`).join(' || ');
  return `(${types}) && (${texts})`;
}

export async function spotlightContentCandidates(run, root, terms, extensions, signal) {
  const response = await run(['/usr/bin/mdfind', '-0', '-onlyin', root, spotlightContentQuery(terms, extensions)], { signal });
  const parts = response.stdout.split('\0');
  if (response.truncated) parts.shift();
  if (parts.at(-1) !== '') parts.pop();
  return { paths: parts.filter(Boolean).slice(0, 200), truncated: response.truncated || parts.length > 201 };
}

/** The indexed body text of one file, or null when Spotlight has none. Used as a
 * body-reading fallback for formats this plugin does not parse itself (PDF, legacy
 * Office), so no new binary dependency or home-grown parser is required. */
export async function indexedText(run, file, signal) {
  const response = await run(['/usr/bin/mdls', '-name', 'kMDItemTextContent', '-raw', file], { signal, maxBytes: 512 * 1024 });
  const text = String(response.stdout || '').trim();
  if (!text || text === '(null)' || text === 'null') return { text: '', truncated: response.truncated === true };
  return { text, truncated: response.truncated === true };
}

/** Convert a document to plain text with the macOS built-in textutil. Covers HTML and
 * RTF (and legacy Word) without bundling a parser. */
export async function convertedText(run, file, signal) {
  const response = await run(['/usr/bin/textutil', '-convert', 'txt', '-stdout', file], { signal, maxBytes: 512 * 1024, timeout: 8000 });
  return { text: String(response.stdout || ''), truncated: response.truncated === true };
}
