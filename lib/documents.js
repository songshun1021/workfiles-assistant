import path from 'node:path';
import os from 'node:os';
import { stat as hostStat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { spotlightCandidates } from './native.js';
import { extractOfficeText } from './extract-office.js';

export const FILE_KINDS = Object.freeze({
  presentation: ['pptx', 'ppt'],
  document: ['docx', 'doc', 'rtf'],
  spreadsheet: ['xlsx', 'xls', 'csv'],
  pdf: ['pdf'],
  // HTML belongs with plain text: a local page is a document the user may want to find,
  // open in the default app, or show in Finder. Content reading stays name-only for it.
  text: ['txt', 'md', 'html', 'htm'],
});
const ALL_EXTENSIONS = Object.values(FILE_KINDS).flat();
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', '.svn', '.hg', 'Library', '__pycache__', '.Trash', '.cache', '.venv', 'venv', '.pnpm-store']);
const DEFAULT_LIMITS = Object.freeze({ maxEntries: 20000, maxCandidates: 2500, maxDepth: 16, scanMs: 10000, maxContentFiles: 30, maxFileBytes: 32 * 1024 * 1024, maxContentBytes: 96 * 1024 * 1024 });

export class WorkfilesError extends Error {
  constructor(code, message) { super(message); this.name = 'WorkfilesError'; this.code = code; }
}
export function fail(code, message) { throw new WorkfilesError(code, message); }
export function normalizeText(value) { return String(value).normalize('NFKC').toLocaleLowerCase('zh-CN'); }
export function expandHome(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) fail('INVALID_PATH', '文件夹位置无效。');
  return value === '~' ? os.homedir() : value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : value;
}
export function termsFor(query = '') {
  if (typeof query !== 'string' || query.length > 512) fail('INVALID_QUERY', '请使用不超过 512 字的检索线索。');
  return [...new Set(normalizeText(query).split(/[\s,，;；、]+/u).filter(Boolean))].slice(0, 16);
}
export function extensionOf(filePath) { return path.extname(filePath).slice(1).toLowerCase(); }
export function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function skippedDirectory(name) {
  return name.startsWith('.') || SKIP_DIRECTORIES.has(name) || /\.(?:app|bundle|framework|photoslibrary|git)$/iu.test(name);
}
function dateBound(value, label) {
  if (value === undefined || value === '') return null;
  // A timezone is mandatory: relative/local dates are resolved by the Agent, not silently interpreted as UTC.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) fail('INVALID_DATE', `${label}需要包含时区的完整日期时间。`);
  return Date.parse(value);
}
function compareNewest(a, b) { return b._identity.mtimeMs - a._identity.mtimeMs || a.path.localeCompare(b.path, 'zh-CN'); }
export function rankDocuments(documents, query, sort = 'relevance', limit = 8) {
  const terms = termsFor(query);
  const phrase = normalizeText(query.trim());
  const scored = documents.map(doc => {
    const name = normalizeText(doc.name);
    const folder = normalizeText(doc.folder);
    const content = normalizeText(doc._content || '');
    const matched = terms.filter(term => name.includes(term) || folder.includes(term) || content.includes(term));
    const coverage = terms.length ? matched.length / terms.length : 1;
    const nameHits = terms.filter(term => name.includes(term)).length;
    const contentHits = terms.filter(term => content.includes(term)).length;
    return { ...doc, _score: coverage * 1000 + nameHits * 12 + (phrase && name.includes(phrase) ? 24 : 0), _coverage: coverage,
      match: { quality: coverage === 1 ? 'all_terms' : 'partial', matchedTerms: matched, sources: [...(nameHits ? ['name'] : []), ...(terms.some(term => folder.includes(term)) ? ['folder'] : []), ...(contentHits ? ['content'] : [])] } };
  }).filter(doc => !terms.length || doc._coverage > 0);
  // For "most recently modified", do not let a newer partial hit displace a fully matching document.
  const completeExists = scored.some(doc => doc._coverage === 1);
  const eligible = sort === 'modified' && completeExists ? scored.filter(doc => doc._coverage === 1) : scored;
  eligible.sort(sort === 'modified' ? compareNewest : (a, b) => b._score - a._score || compareNewest(a, b));
  return { items: eligible.slice(0, limit), total: eligible.length, partialOnly: terms.length > 0 && eligible.length > 0 && !completeExists };
}
export function publicCandidate(doc) {
  const { _content, _score, _coverage, ...candidate } = doc;
  return candidate;
}

/** All document reads/listings go through the mounted Harness filesystem provider. */
export function createDocumentEngine({ fs, runNative, roots: readRoots, enabled = () => true, platform = process.platform, limits = {}, now = Date.now }) {
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  function check(signal, allowPaused = false) { signal?.throwIfAborted(); const allowed = enabled(); signal?.throwIfAborted(); if (!allowed && !allowPaused) fail('PAUSED', '资料文件查找已暂停。请在资料助手面板恢复查找。'); }
  async function scope(folder, signal) {
    signal?.throwIfAborted();
    const approved = readRoots();
    if (!Array.isArray(approved) || approved.length > 8) fail('INVALID_SCOPE', '资料范围配置无效。');
    const available = []; const warnings = [];
    for (const input of approved) {
      try {
        const absolute = expandHome(input);
        if (!path.isAbsolute(absolute) || isInside(path.resolve(absolute), os.homedir())) fail('SCOPE_TOO_BROAD', '不能把整个电脑或整个个人目录作为资料范围。');
        const target = await fs.resolve(absolute, { signal });
        const processPath = fs.processPath(target);
        if (isInside(processPath, os.homedir())) fail('SCOPE_TOO_BROAD', '不能通过别名把整个电脑或个人目录作为资料范围。');
        if (fs.processPathFromHostPath(processPath) !== processPath) fail('LOCAL_MAC_REQUIRED', '此版本仅支持本机文件系统。');
        const info = await fs.stat(target, signal);
        if (info?.type !== 'directory') { warnings.push(`文件夹不可用：${input}`); continue; }
        if (!available.some(root => fs.contains(root.target, target))) available.push({ target, path: processPath, label: input });
      } catch (error) {
        if (signal?.aborted) throw error;
        warnings.push(`无法访问资料文件夹：${input}（${error.code || '访问失败'}）`);
      }
    }
    if (folder) {
      const absolute = expandHome(folder);
      if (!path.isAbsolute(absolute)) fail('INVALID_PATH', '限定文件夹需要完整位置。');
      const target = await fs.resolve(absolute, { signal });
      const root = available.find(item => fs.contains(item.target, target));
      if (!root) fail('OUTSIDE_SCOPE', '该文件夹不在你允许的资料范围内，请通过资料助手面板选择文件夹。');
      if ((await fs.stat(target, signal))?.type !== 'directory') fail('FOLDER_NOT_FOUND', '限定的文件夹不存在或无法访问。');
      return { roots: [{ target, path: fs.processPath(target), label: folder }], approvedRoots: available, warnings };
    }
    return { roots: available, approvedRoots: available, warnings };
  }
  async function metadata(input, roots, extensions, signal, allowPaused = false) {
    check(signal, allowPaused);
    const target = await fs.resolve(input, { signal });
    const root = roots.find(item => fs.contains(item.target, target));
    if (!root) fail('OUTSIDE_SCOPE', '文件已不在允许的资料范围内。');
    const canonical = fs.processPath(target);
    if (fs.processPathFromHostPath(canonical) !== canonical) fail('LOCAL_MAC_REQUIRED', '文件不在本机文件系统。');
    const relative = path.relative(root.path, canonical);
    if (relative.split(path.sep).some((part, i, parts) => i < parts.length - 1 && skippedDirectory(part))) fail('EXCLUDED_FILE', '文件位于排除的目录。');
    if (path.basename(canonical).startsWith('.') || path.basename(canonical).startsWith('~$')) fail('EXCLUDED_FILE', '忽略隐藏文件和临时锁定文件。');
    const extension = extensionOf(canonical);
    if (!extensions.includes(extension)) fail('UNSUPPORTED_TYPE', '此文件类型不在工作资料支持范围内。');
    const info = await fs.stat(target, signal);
    if (!info || info.type !== 'file') fail('FILE_NOT_FOUND', '文件不存在或不是普通文件。');
    // FsVersion stays opaque. Local stat supplies mtime; no version-string parsing or Office ZIP timestamps.
    const host = await hostStat(canonical);
    if (!host.isFile()) fail('FILE_NOT_FOUND', '文件不是普通文件。');
    check(signal, allowPaused);
    return {
      target,
      candidate: { id: `wf-${randomUUID()}`, name: path.basename(canonical), path: canonical, folder: path.dirname(canonical),
        root: root.path, relativePath: relative, extension, bytes: host.size, modifiedAt: host.mtime.toISOString(),
        _identity: { key: `${host.dev}:${host.ino}`, mtimeMs: host.mtimeMs, bytes: host.size, version: String(info.version) },
        snippet: null, contentStatus: 'not_read' },
    };
  }
  async function validate(candidate, signal) {
    if (!candidate || typeof candidate.id !== 'string' || typeof candidate.path !== 'string' || !candidate._identity) fail('UNKNOWN_CANDIDATE', '这份候选资料已不在当前对话中，请重新查找。');
    const selected = await scope(undefined, signal);
    const actual = await metadata(candidate.path, selected.roots, ALL_EXTENSIONS, signal);
    const previous = candidate._identity; const current = actual.candidate._identity;
    if (previous.key !== current.key || previous.mtimeMs !== current.mtimeMs || previous.bytes !== current.bytes || previous.version !== current.version) fail('STALE_CANDIDATE', '这份文件在查找后发生了变化，请刷新查找结果再打开。');
    return { ...actual, candidate: { ...actual.candidate, id: candidate.id } };
  }
  async function readContent(doc, signal) {
    const current = await validate(doc, signal);
    if (!['pptx', 'docx', 'txt', 'md', 'csv'].includes(doc.extension)) return { text: '', contentStatus: 'unsupported', warnings: ['此格式仅支持名称、目录和修改时间查找，尚未读取正文。'] };
    const bytes = await fs.readBytes(current.target, signal, bounds.maxFileBytes);
    check(signal);
    const result = ['pptx', 'docx'].includes(doc.extension)
      ? await extractOfficeText(bytes, { kind: doc.extension, maxCharacters: 30000, signal })
      : { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes).slice(0, 30000), slides: [], truncated: bytes.byteLength > 30000, warnings: [] };
    await validate(doc, signal);
    return { ...result, contentStatus: result.truncated ? 'partial' : 'read' };
  }
  async function observedFile(input, signal, allowPaused = false) {
    check(signal, allowPaused);
    if (typeof input !== 'string' || input.length > 4096 || !path.isAbsolute(input) || input.includes('\0')) fail('INVALID_PATH', '观察到的文档位置无效。');
    const selected = await scope(undefined, signal);
    // Native observations and persisted ledger paths are already canonical.
    // Do not even resolve a formerly authorized file outside today's roots.
    if (!selected.roots.some(root => isInside(root.path, input))) fail('OUTSIDE_SCOPE', '文档已不在允许的资料范围内。');
    const actual = await metadata(input, selected.roots, ALL_EXTENSIONS, signal, allowPaused);
    check(signal, allowPaused);
    return publicCandidate(actual.candidate);
  }
  return {
    async status(signal) {
      const selected = await scope(undefined, signal);
      return { roots: selected.approvedRoots.map(root => root.path), configuredRoots: [...readRoots()], warnings: selected.warnings, backgroundCollection: false, backgroundCollectionScope: 'document_search_only_not_activity_ledger', historyCoverage: 'this_conversation_only', platformSupported: platform === 'darwin' };
    },
    // Native observations are hints, never file authority. Reuse the same canonical
    // scope, ordinary-file, type and identity checks as a normal document search.
    observedCandidate: (input, signal) => observedFile(input, signal),
    async describeObservedDocument(input, signal) {
      // Recording consent is independent of pausing file search. This seam
      // returns metadata only, never an open capability or document contents.
      const candidate = await observedFile(input, signal, true);
      const kind = Object.keys(FILE_KINDS).find(key => FILE_KINDS[key].includes(candidate.extension));
      return { name: candidate.name, path: candidate.path, kind, modifiedAt: candidate.modifiedAt };
    },
    async search(args = {}, signal) {
      check(signal);
      const { query = '', kind = 'presentation', sort = 'relevance', folder, content = false, limit = 8, modifiedAfter, modifiedBefore } = args;
      if (!(kind === 'all' || Object.hasOwn(FILE_KINDS, kind))) fail('INVALID_KIND', '不支持这种资料类别。');
      if (!['relevance', 'modified'].includes(sort) || !Number.isInteger(limit) || limit < 1 || limit > 20 || typeof content !== 'boolean') fail('INVALID_SEARCH', '检索参数无效。');
      const terms = termsFor(query); const extensions = kind === 'all' ? ALL_EXTENSIONS : FILE_KINDS[kind];
      const after = dateBound(modifiedAfter, '起始时间'); const before = dateBound(modifiedBefore, '结束时间');
      if (after !== null && before !== null && after >= before) fail('INVALID_DATE', '起始时间必须早于结束时间。');
      const selected = await scope(folder, signal);
      if (!selected.roots.length) fail('NO_SCOPE', '还没有可用的资料文件夹。请在资料助手面板选择范围。');
      const warnings = [...selected.warnings]; const found = new Map(); const inspected = new Set();
      const started = now(); let visited = 0; let scanTruncated = false; let indexTruncated = false; let errors = 0;
      const accept = async input => {
        check(signal);
        if (found.size >= bounds.maxCandidates) { scanTruncated = true; return; }
        if (inspected.has(input)) return; inspected.add(input);
        try {
          const item = await metadata(input, selected.roots, extensions, signal);
          const when = item.candidate._identity.mtimeMs;
          if ((after !== null && when < after) || (before !== null && when >= before)) return;
          if (!found.has(item.candidate.path)) found.set(item.candidate.path, item.candidate);
        } catch (error) {
          if (signal?.aborted) throw error;
          if (!['EXCLUDED_FILE', 'UNSUPPORTED_TYPE', 'OUTSIDE_SCOPE', 'FILE_NOT_FOUND'].includes(error.code)) errors++;
        }
      };
      if (platform === 'darwin' && runNative) {
        const results = await Promise.all(selected.roots.map(async root => {
          try { return await spotlightCandidates(runNative, root.path, terms, extensions, signal); }
          catch (error) { if (signal?.aborted) throw error; warnings.push('部分系统索引暂不可用，已改用限定范围查找。'); return { paths: [], truncated: false }; }
        }));
        for (const result of results) {
          indexTruncated ||= result.truncated;
          for (const file of result.paths) { await accept(file); if (now() - started > bounds.scanMs) { scanTruncated = true; break; } }
        }
      }
      // Bounded breadth-first fallback includes all three roots fairly, even when Spotlight excludes a folder.
      const queue = selected.roots.map(root => ({ ...root, depth: 0 })); const walked = new Set();
      while (queue.length) {
        check(signal);
        if (visited >= bounds.maxEntries || found.size >= bounds.maxCandidates || now() - started > bounds.scanMs) { scanTruncated = true; break; }
        const directory = queue.shift();
        if (walked.has(directory.path)) continue; walked.add(directory.path);
        let entries;
        try { entries = await fs.listDir(directory.target, signal); }
        catch (error) { if (signal?.aborted) throw error; errors++; continue; }
        for (const entry of entries) {
          check(signal); visited++;
          if (visited > bounds.maxEntries || now() - started > bounds.scanMs) { scanTruncated = true; break; }
          if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
          const canonical = fs.processPath(entry.target);
          if (!selected.roots.some(root => fs.contains(root.target, entry.target))) continue;
          const raw = path.join(directory.path, entry.name);
          const pathInfo = await fs.lstat(raw, undefined, signal).catch(() => undefined);
          // No recursive symlink following, including links that happen to point back into an approved root.
          if (!pathInfo || pathInfo.type === 'symlink') continue;
          if (entry.type === 'directory') {
            if (skippedDirectory(entry.name)) continue;
            if (directory.depth >= bounds.maxDepth) { scanTruncated = true; continue; }
            queue.push({ target: entry.target, path: canonical, depth: directory.depth + 1 });
          } else if (entry.type === 'file' && extensions.includes(extensionOf(entry.name))) await accept(canonical);
        }
      }
      const documents = [...found.values()];
      let contentRead = 0; let contentBytes = 0; let contentFailed = 0;
      if (content) {
        const prioritized = [...documents].sort((a, b) => {
          const ah = terms.some(term => normalizeText(`${a.name} ${a.folder}`).includes(term));
          const bh = terms.some(term => normalizeText(`${b.name} ${b.folder}`).includes(term));
          return Number(bh) - Number(ah) || compareNewest(a, b);
        });
        for (const document of prioritized) {
          check(signal);
          if (contentRead >= bounds.maxContentFiles) break;
          if (!['pptx', 'docx', 'txt', 'md', 'csv'].includes(document.extension)) continue;
          if (document.bytes > bounds.maxFileBytes || contentBytes + document.bytes > bounds.maxContentBytes) { document.contentStatus = 'too_large'; continue; }
          contentRead++; contentBytes += document.bytes;
          try {
            const extracted = await readContent(document, signal);
            document._content = extracted.text; document.contentStatus = extracted.contentStatus;
            const text = extracted.text.replace(/\s+/gu, ' ').trim();
            const index = terms.map(term => normalizeText(text).indexOf(term)).find(index => index >= 0) ?? 0;
            document.snippet = text.slice(Math.max(0, index - 80), Math.max(0, index - 80) + 400);
          } catch (error) {
            if (signal?.aborted) throw error;
            document.contentStatus = 'unreadable'; contentFailed++;
          }
        }
        if (contentRead < documents.filter(doc => ['pptx', 'docx', 'txt', 'md', 'csv'].includes(doc.extension)).length) warnings.push(`正文仅检查了 ${contentRead} 份候选；未检查的文件仍可能相关。可以缩小文件夹或时间范围后再查。`);
      }
      if (scanTruncated || indexTruncated) warnings.push('本次查找达到时间或数量上限，结果不代表全部资料；可以缩小范围继续查找。');
      if (errors) warnings.push(`有 ${errors} 项无法读取元数据或文件夹，未将其视为不存在。`);
      if (contentFailed) warnings.push(`有 ${contentFailed} 份候选正文无法读取，仍可按文件名查找。`);
      const ranked = rankDocuments(documents, query, sort, limit);
      return {
        query, kind, sort, roots: selected.roots.map(root => root.path), candidates: ranked.items.map(publicCandidate),
        totalMatches: ranked.total, partialMatchesOnly: ranked.partialOnly,
        coverage: { indexUsed: platform === 'darwin' && !!runNative, entriesVisited: visited, documentCandidates: documents.length, scanComplete: !scanTruncated && !indexTruncated && !errors, contentRequested: content, contentFilesRead: contentRead, contentFailures: contentFailed },
        warnings: [...new Set(warnings)],
      };
    },
    async inspect(candidate, signal) {
      check(signal);
      const result = await readContent(candidate, signal);
      const text = result.text.slice(0, 8000);
      return { candidate: { ...candidate, contentStatus: result.contentStatus }, text, slides: (result.slides || []).slice(0, 10).map(slide => ({ number: slide.number, text: slide.text.slice(0, 1200) })), truncated: result.truncated || result.text.length > text.length || (result.slides?.length || 0) > 10, warnings: result.warnings || [], contentIsUntrustedData: true };
    },
    async open(candidate, signal) {
      check(signal);
      if (platform !== 'darwin') fail('LOCAL_MAC_REQUIRED', '当前版本的打开能力仅支持本机 Mac。');
      const actual = await validate(candidate, signal);
      check(signal);
      await runNative(['/usr/bin/open', actual.candidate.path], { signal, timeout: 8000, maxBytes: 8192 });
      return { status: 'open_requested', candidate: { ...candidate, ...actual.candidate }, requestedAt: new Date(now()).toISOString(), documentVisibleConfirmed: false, message: '已将文件交给系统默认应用打开；这只确认系统接受了请求，尚未确认文档窗口显示。' };
    },
    /** Reveal a still-validated candidate in Finder. Same identity/scope gate as open;
     * callers can never pass a folder path, only a candidate ID this Session already has. */
    async reveal(candidate, signal) {
      check(signal);
      if (platform !== 'darwin') fail('LOCAL_MAC_REQUIRED', '当前版本只在 Mac 上支持在访达中显示。');
      const actual = await validate(candidate, signal);
      check(signal);
      await runNative(['/usr/bin/open', '-R', actual.candidate.path], { signal, timeout: 8000, maxBytes: 8192 });
      return { status: 'reveal_requested', candidate: { ...candidate, ...actual.candidate }, folder: path.dirname(actual.candidate.path), requestedAt: new Date(now()).toISOString(), finderVisibleConfirmed: false, message: '已请求在访达中显示这个文件；只代表系统接受了请求，尚未确认访达窗口已出现在前台。' };
    },
    async validateDirectory(input, signal) {
      const absolute = expandHome(input);
      if (!path.isAbsolute(absolute) || isInside(path.resolve(absolute), os.homedir())) fail('SCOPE_TOO_BROAD', '请选择具体资料文件夹，不要选择整个电脑或个人目录。');
      const target = await fs.resolve(absolute, { signal });
      const canonical = fs.processPath(target);
      if (isInside(canonical, os.homedir())) fail('SCOPE_TOO_BROAD', '不能通过别名选择整个电脑或个人目录。');
      if (fs.processPathFromHostPath(canonical) !== canonical || (await fs.stat(target, signal))?.type !== 'directory') fail('INVALID_PATH', '这不是可访问的本机文件夹。');
      return canonical;
    },
  };
}
