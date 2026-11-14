import yauzl from 'yauzl';
import { SaxesParser } from 'saxes';
import { TextDecoder } from 'node:util';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToLoop } from 'node:timers/promises';

// These bounds are deliberately not caller-configurable. They bound work as well
// as returned text; maxCharacters alone is not a ZIP-bomb/XML-bomb defence.
const LIMITS = Object.freeze({
  archiveBytes: 32 * 1024 * 1024,
  entries: 4096,
  entryMetadataBytes: 8 * 1024,
  metadataBytes: 1024 * 1024,
  entryBytes: 64 * 1024 * 1024,
  declaredBytes: 128 * 1024 * 1024,
  compressionRatio: 200,
  xmlEntryBytes: 8 * 1024 * 1024,
  xmlTotalBytes: 32 * 1024 * 1024,
  xmlDepth: 64,
  xmlNodes: 250_000,
  slides: 512,
  relationships: 4096,
  characters: 100_000,
  milliseconds: 8000,
});
const XML_CHUNK_BYTES = 16 * 1024;
const PML = new Set([
  'http://schemas.openxmlformats.org/presentationml/2006/main',
  'http://purl.oclc.org/ooxml/presentationml/main',
]);
const DML = new Set([
  'http://schemas.openxmlformats.org/drawingml/2006/main',
  'http://purl.oclc.org/ooxml/drawingml/main',
]);
const WML = new Set([
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
]);
const OFFICE_REL = new Set([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  'http://purl.oclc.org/ooxml/officeDocument/relationships',
]);
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const SLIDE_REL_TYPES = new Set([...OFFICE_REL].map((uri) => `${uri}/slide`));
const NOOP = () => {};

function failure(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.name = 'OfficeExtractionError';
  error.code = code;
  return error;
}
function abortError(signal) {
  const error = new Error('Office text extraction was cancelled.', { cause: signal?.reason });
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}
function check(context) {
  if (context.signal?.aborted) throw abortError(context.signal);
  if (performance.now() > context.deadline) {
    throw failure('ERR_OFFICE_LIMIT', 'Office text extraction exceeded the time limit.');
  }
}
function isTag(tag, namespaces, local) {
  return tag?.local === local && namespaces.has(tag.uri);
}
function attribute(tag, local, namespaces) {
  for (const attr of Object.values(tag.attributes)) {
    if (attr.local === local && (namespaces ? namespaces.has(attr.uri) : !attr.uri)) {
      return attr.value;
    }
  }
  return undefined;
}
function limitedString(value, description, max = 2048) {
  if (typeof value !== 'string' || !value.length || value.length > max) {
    throw failure('ERR_OFFICE_PACKAGE', `Invalid ${description} in the Office package.`);
  }
  return value;
}
function addWarning(context, warning) {
  if (!context.warnings.includes(warning)) context.warnings.push(warning);
}

// A UTF-16 code-unit cap is used, matching JavaScript string.length. Do not emit
// half of an astral character when a cap falls between its surrogate pair.
function prefixWithin(value, length) {
  let end = Math.min(length, value.length);
  if (end > 0 && end < value.length) {
    const before = value.charCodeAt(end - 1);
    const after = value.charCodeAt(end);
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end--;
  }
  return value.slice(0, end);
}
function textCollector(limit) {
  const parts = [];
  let length = 0;
  let pendingBreak = false;
  let truncated = false;
  function appendRaw(value) {
    if (truncated) return;
    const remaining = Math.max(0, limit - length);
    const accepted = prefixWithin(value, remaining);
    if (accepted) {
      parts.push(accepted);
      length += accepted.length;
    }
    if (accepted.length < value.length) truncated = true;
  }
  return {
    append(value) {
      if (!value) return;
      if (pendingBreak) appendRaw('\n');
      pendingBreak = false;
      appendRaw(value);
    },
    lineBreak() {
      // Defer paragraph separators so a final newline alone does not make a
      // document whose text exactly fits its budget appear truncated.
      if (length) pendingBreak = true;
    },
    finish() {
      return { text: parts.join('').trim(), truncated };
    },
  };
}

async function indexArchive(zip, context) {
  if (!Number.isSafeInteger(zip.entryCount) || zip.entryCount > LIMITS.entries) {
    throw failure('ERR_OFFICE_LIMIT', 'The Office archive contains too many entries.');
  }
  const entries = new Map();
  let declaredBytes = 0;
  let metadataBytes = 0;
  for await (const entry of zip.eachEntry()) {
    check(context);
    // ZIP extra fields/comments can otherwise consume substantial memory even
    // without inflating a single payload. yauzl parses one entry at a time.
    const entryMetadataBytes = entry.fileNameLength + entry.extraFieldLength + entry.fileCommentLength;
    metadataBytes += entryMetadataBytes;
    if (entryMetadataBytes > LIMITS.entryMetadataBytes || metadataBytes > LIMITS.metadataBytes) {
      throw failure('ERR_OFFICE_LIMIT', 'Office archive metadata exceeds its size limit.');
    }
    const name = entry.fileName;
    const components = typeof name === 'string' ? name.split('/') : [];
    if (!name || name.length > 1024 || /[\u0000-\u001f\u007f]/u.test(name)
      || components.some((part, i) => part === '.' || part === '..'
        || (!part && i !== components.length - 1))) {
      throw failure('ERR_OFFICE_PACKAGE', 'The Office archive contains an invalid part name.');
    }
    if (entries.has(name)) {
      throw failure('ERR_OFFICE_PACKAGE', 'Duplicate part names are not allowed in an Office archive.');
    }
    if ((entry.generalPurposeBitFlag & (0x1 | 0x40 | 0x2000)) !== 0) {
      throw failure('ERR_OFFICE_UNSUPPORTED', 'Encrypted Office archives are not supported.');
    }
    if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
      throw failure('ERR_OFFICE_UNSUPPORTED', 'This ZIP compression method is not supported.');
    }
    if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) {
      throw failure('ERR_OFFICE_PACKAGE', 'Symbolic-link entries are not allowed in an Office archive.');
    }
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0
      || !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) {
      throw failure('ERR_OFFICE_PACKAGE', 'Invalid Office archive entry sizes.');
    }
    if (entry.uncompressedSize > LIMITS.entryBytes
      || entry.compressedSize > context.archiveBytes
      || entry.uncompressedSize > Math.max(1, entry.compressedSize) * LIMITS.compressionRatio) {
      throw failure('ERR_OFFICE_LIMIT', 'An Office archive entry exceeds the size or inflation-ratio limit.');
    }
    declaredBytes += entry.uncompressedSize;
    if (declaredBytes > LIMITS.declaredBytes || entries.size >= LIMITS.entries) {
      throw failure('ERR_OFFICE_LIMIT', 'The Office archive exceeds its aggregate expansion or entry limit.');
    }
    entries.set(name, entry);
  }
  return entries;
}

function decoderFor(prefix) {
  // OOXML normally uses UTF-8, but UTF-16 parts occur in valid packages too.
  if ((prefix[0] === 0xff && prefix[1] === 0xfe && prefix[2] === 0 && prefix[3] === 0)
    || (prefix[0] === 0 && prefix[1] === 0 && prefix[2] === 0xfe && prefix[3] === 0xff)
    || (prefix[0] === 0 && prefix[1] === 0 && prefix[2] === 0 && prefix[3] === 0x3c)
    || (prefix[0] === 0x3c && prefix[1] === 0 && prefix[2] === 0 && prefix[3] === 0)) {
    throw failure('ERR_OFFICE_UNSUPPORTED', 'UTF-32 Office XML is not supported.');
  }
  let encoding = 'utf-8';
  if ((prefix[0] === 0xff && prefix[1] === 0xfe)
    || (prefix[0] === 0x3c && prefix[1] === 0 && prefix[3] === 0)) encoding = 'utf-16le';
  else if ((prefix[0] === 0xfe && prefix[1] === 0xff)
    || (prefix[0] === 0 && prefix[1] === 0x3c && prefix[2] === 0)) encoding = 'utf-16be';
  return { decoder: new TextDecoder(encoding, { fatal: true }), encoding };
}

async function readXml(zip, entry, context, handlers = {}) {
  check(context);
  if (entry.uncompressedSize > LIMITS.xmlEntryBytes) {
    throw failure('ERR_OFFICE_LIMIT', 'An Office XML part exceeds the size limit.');
  }
  const stack = [];
  const parser = new SaxesParser({ xmlns: true });
  let decoding;
  let prefix = Buffer.alloc(0);
  let actualBytes = 0;
  function countNode() {
    if (++context.xmlNodes > LIMITS.xmlNodes) {
      throw failure('ERR_OFFICE_LIMIT', 'Office XML exceeds the aggregate node limit.');
    }
  }
  parser.on('error', (cause) => {
    throw failure('ERR_OFFICE_XML', 'An Office XML part is not well-formed.', cause);
  });
  parser.on('doctype', () => {
    throw failure('ERR_OFFICE_XML', 'DOCTYPE declarations are not allowed in Office XML.');
  });
  parser.on('xmldecl', (declaration) => {
    if (!declaration.encoding) return;
    const encoding = declaration.encoding.toLowerCase().replaceAll('-', '');
    if (!['utf8', 'utf16', 'utf16le', 'utf16be'].includes(encoding)) {
      throw failure('ERR_OFFICE_UNSUPPORTED', 'The Office XML declares an unsupported encoding.');
    }
    if ((encoding === 'utf8') !== (decoding.encoding === 'utf-8')
      || (encoding === 'utf16le' && decoding.encoding !== 'utf-16le')
      || (encoding === 'utf16be' && decoding.encoding !== 'utf-16be')) {
      throw failure('ERR_OFFICE_XML', 'The Office XML encoding declaration does not match its bytes.');
    }
  });
  parser.on('attribute', countNode);
  parser.on('opentag', (tag) => {
    countNode();
    if (stack.length >= LIMITS.xmlDepth) {
      throw failure('ERR_OFFICE_LIMIT', 'Office XML exceeds the nesting-depth limit.');
    }
    stack.push(tag);
    handlers.open?.(tag, stack);
  });
  parser.on('closetag', (tag) => {
    handlers.close?.(tag, stack);
    stack.pop();
  });
  const onText = (value) => {
    countNode();
    handlers.text?.(value, stack);
  };
  parser.on('text', onText);
  parser.on('cdata', onText);
  parser.on('comment', countNode);
  parser.on('processinginstruction', countNode);

  const stream = await zip.openReadStreamPromise(entry);
  // Async iteration observes stream errors; this also protects the short gap
  // between cancellation and installing the iterator's listeners.
  stream.on('error', NOOP);
  const onAbort = () => stream.destroy(abortError(context.signal));
  context.signal?.addEventListener('abort', onAbort, { once: true });
  if (context.signal?.aborted) onAbort();
  try {
    for await (const chunk of stream) {
      check(context);
      actualBytes += chunk.length;
      context.xmlBytes += chunk.length;
      if (actualBytes > LIMITS.xmlEntryBytes || context.xmlBytes > LIMITS.xmlTotalBytes
        || actualBytes > Math.max(1, entry.compressedSize) * LIMITS.compressionRatio) {
        throw failure('ERR_OFFICE_LIMIT', 'Office XML exceeds its actual expansion limit.');
      }
      for (let offset = 0; offset < chunk.length; offset += XML_CHUNK_BYTES) {
        check(context);
        let bytes = chunk.subarray(offset, offset + XML_CHUNK_BYTES);
        if (!decoding) {
          const amount = Math.min(4 - prefix.length, bytes.length);
          prefix = Buffer.concat([prefix, bytes.subarray(0, amount)]);
          bytes = bytes.subarray(amount);
          if (prefix.length < 4) continue;
          decoding = decoderFor(prefix);
          parser.write(decoding.decoder.decode(prefix, { stream: true }));
        }
        if (bytes.length) parser.write(decoding.decoder.decode(bytes, { stream: true }));
        // This is necessary for AbortSignal/timers to run even for stored XML
        // backed entirely by the caller's in-memory Buffer.
        await yieldToLoop();
      }
    }
    check(context);
    if (!decoding) {
      decoding = decoderFor(prefix);
      parser.write(decoding.decoder.decode(prefix, { stream: true }));
    }
    parser.write(decoding.decoder.decode());
    parser.close();
    check(context);
  } catch (cause) {
    if (context.signal?.aborted) throw abortError(context.signal);
    if (cause?.name === 'OfficeExtractionError' || cause?.name === 'AbortError') throw cause;
    throw failure('ERR_OFFICE_XML', 'An Office XML part could not be decoded or decompressed.', cause);
  } finally {
    context.signal?.removeEventListener('abort', onAbort);
    stream.destroy();
  }
}

function requiredPart(entries, name) {
  const entry = entries.get(name);
  if (!entry || name.endsWith('/')) {
    throw failure('ERR_OFFICE_PACKAGE', `The Office package is missing its required ${name} part.`);
  }
  return entry;
}

// Resolve only in-package OPC paths. No URL is opened and no filesystem path is
// ever constructed. Dot segments may move up inside the package, never above it.
function resolvePartTarget(source, target) {
  limitedString(target, 'relationship target');
  let decoded;
  try { decoded = decodeURIComponent(target); }
  catch (cause) { throw failure('ERR_OFFICE_PACKAGE', 'An Office relationship has an invalid URI.', cause); }
  if (/[\\\u0000-\u0020\u007f?#]/u.test(decoded) || decoded.startsWith('//')
    || /^[a-z][a-z\d+.-]*:/iu.test(decoded)) {
    throw failure('ERR_OFFICE_PACKAGE', 'Only safe in-package Office relationship targets are supported.');
  }
  const parts = decoded.startsWith('/') ? [] : source.split('/').slice(0, -1);
  for (const part of decoded.replace(/^\//u, '').split('/')) {
    if (part === '..') {
      if (!parts.length) throw failure('ERR_OFFICE_PACKAGE', 'An Office relationship escapes its package.');
      parts.pop();
    } else if (part !== '.' && part !== '') parts.push(part);
  }
  const name = parts.join('/');
  if (!name || !name.endsWith('.xml')) {
    throw failure('ERR_OFFICE_PACKAGE', 'An Office slide relationship does not name an XML part.');
  }
  return name;
}

async function extractPptx(zip, entries, context) {
  const orderedIds = [];
  const seenIds = new Set();
  await readXml(zip, requiredPart(entries, 'ppt/presentation.xml'), context, {
    open(tag, stack) {
      if (stack.length === 1 && !isTag(tag, PML, 'presentation')) {
        throw failure('ERR_OFFICE_PACKAGE', 'The PPTX presentation part has the wrong root element.');
      }
      if (stack.length === 3 && isTag(tag, PML, 'sldId') && isTag(stack[1], PML, 'sldIdLst')) {
        const id = limitedString(attribute(tag, 'id', OFFICE_REL), 'slide relationship id', 256);
        if (seenIds.has(id)) throw failure('ERR_OFFICE_PACKAGE', 'Duplicate PPTX slide relationship ids.');
        if (orderedIds.length >= LIMITS.slides) throw failure('ERR_OFFICE_LIMIT', 'The PPTX contains too many slides.');
        seenIds.add(id);
        orderedIds.push(id);
      }
    },
  });
  const relationships = new Map();
  await readXml(zip, requiredPart(entries, 'ppt/_rels/presentation.xml.rels'), context, {
    open(tag, stack) {
      if (stack.length === 1 && !(tag.local === 'Relationships' && tag.uri === PACKAGE_REL)) {
        throw failure('ERR_OFFICE_PACKAGE', 'The PPTX relationship part has the wrong root element.');
      }
      if (stack.length !== 2 || tag.local !== 'Relationship' || tag.uri !== PACKAGE_REL) return;
      if (relationships.size >= LIMITS.relationships) {
        throw failure('ERR_OFFICE_LIMIT', 'The PPTX contains too many relationships.');
      }
      const id = limitedString(attribute(tag, 'Id'), 'relationship id', 256);
      if (relationships.has(id)) throw failure('ERR_OFFICE_PACKAGE', 'Duplicate PPTX relationship ids.');
      const type = limitedString(attribute(tag, 'Type'), 'relationship type');
      const target = limitedString(attribute(tag, 'Target'), 'relationship target');
      const mode = attribute(tag, 'TargetMode');
      if (mode && !['internal', 'external'].includes(mode.toLowerCase())) {
        throw failure('ERR_OFFICE_PACKAGE', 'Invalid Office relationship target mode.');
      }
      relationships.set(id, { type, target, external: mode?.toLowerCase() === 'external' });
    },
  });
  const slides = [];
  const texts = [];
  let characters = 0;
  for (const [index, id] of orderedIds.entries()) {
    check(context);
    const relation = relationships.get(id);
    if (!relation || !SLIDE_REL_TYPES.has(relation.type)) {
      throw failure('ERR_OFFICE_PACKAGE', 'A PPTX slide has no matching slide relationship.');
    }
    if (relation.external) {
      addWarning(context, 'An external slide relationship was ignored.');
      slides.push({ number: index + 1, text: '' });
      continue;
    }
    const part = resolvePartTarget('ppt/presentation.xml', relation.target);
    const separatorSize = texts.length ? 2 : 0;
    const collector = textCollector(context.truncated ? 0
      : Math.max(0, context.maxCharacters - characters - separatorSize));
    await readXml(zip, requiredPart(entries, part), context, {
      open(tag, stack) {
        if (stack.length === 1 && !isTag(tag, PML, 'sld')) {
          throw failure('ERR_OFFICE_PACKAGE', 'A PPTX slide part has the wrong root element.');
        }
        if (isTag(tag, DML, 'br') && stack.some((parent) => isTag(parent, PML, 'cSld'))) collector.lineBreak();
      },
      close(tag, stack) {
        if (isTag(tag, DML, 'p') && stack.some((parent) => isTag(parent, PML, 'cSld'))) collector.lineBreak();
      },
      text(value, stack) {
        if (isTag(stack.at(-1), DML, 't') && stack.some((parent) => isTag(parent, PML, 'cSld'))) collector.append(value);
      },
    });
    const result = collector.finish();
    if (result.truncated) context.truncated = true;
    slides.push({ number: index + 1, text: result.text });
    if (result.text) {
      texts.push(result.text);
      characters += result.text.length + separatorSize;
    }
  }
  if ([...entries.keys()].some((name) => name.startsWith('ppt/notesSlides/'))) {
    addWarning(context, 'Speaker notes are not extracted.');
  }
  if ([...entries.keys()].some((name) => /^ppt\/(?:charts|embeddings|media)\//u.test(name))) {
    addWarning(context, 'Image text, separate chart parts and embedded objects are not extracted.');
  }
  return { text: texts.join('\n\n'), slides };
}

async function extractDocx(zip, entries, context) {
  const collector = textCollector(context.maxCharacters);
  let hasBody = false;
  let inBody = false;
  await readXml(zip, requiredPart(entries, 'word/document.xml'), context, {
    open(tag, stack) {
      if (stack.length === 1 && !isTag(tag, WML, 'document')) {
        throw failure('ERR_OFFICE_PACKAGE', 'The DOCX document part has the wrong root element.');
      }
      if (stack.length === 2 && isTag(tag, WML, 'body')) {
        if (hasBody) throw failure('ERR_OFFICE_PACKAGE', 'The DOCX contains more than one document body.');
        hasBody = true;
        inBody = true;
      }
      if (!inBody || !stack.some((parent) => isTag(parent, WML, 'p'))) return;
      if (isTag(tag, WML, 'tab')) collector.append('\t');
      if (isTag(tag, WML, 'br') || isTag(tag, WML, 'cr')) collector.lineBreak();
    },
    close(tag, stack) {
      if (inBody && isTag(tag, WML, 'p')) collector.lineBreak();
      if (stack.length === 2 && isTag(tag, WML, 'body')) inBody = false;
    },
    text(value, stack) {
      if (inBody && isTag(stack.at(-1), WML, 't')
        && stack.some((parent) => isTag(parent, WML, 'p'))) collector.append(value);
    },
  });
  if (!hasBody) throw failure('ERR_OFFICE_PACKAGE', 'The DOCX document has no body.');
  if ([...entries.keys()].some((name) => /^word\/(?:header|footer|footnotes|endnotes|comments|media|embeddings)/u.test(name))) {
    addWarning(context, 'Headers, footers, notes, comments, images and embedded objects are not extracted.');
  }
  const result = collector.finish();
  context.truncated = result.truncated;
  return { text: result.text, slides: [] };
}

/**
 * Extract bounded text from already-authorized PPTX/DOCX bytes, using yauzl 3.4.0
 * and saxes 6.0.0. No paths, filesystem writes, networking or Office processes.
 *
 * PPTX uses presentation.xml + its relationships for actual slide order, not ZIP
 * entry order or slide filename numbering. Only slide XML text is read. DOCX
 * reads only body paragraphs in word/document.xml (including table paragraphs).
 * Standard transitional/strict OOXML namespaces and UTF-8/UTF-16 are supported.
 * Notes, OCR, separate charts, encrypted/legacy Office formats and full layout
 * reconstruction are intentionally outside this interface. yauzl does not CRC-
 * verify file data, so this is not an archive-integrity/authenticity verifier.
 *
 * Work limits: 32 MiB input; 4096 entries; ZIP name/extra/comment metadata
 * 8 KiB/entry and 1 MiB total; 64 MiB/entry and 128 MiB declared aggregate
 * expansion; 200x inflation; 8 MiB/XML part and 32 MiB XML read; depth
 * 64; 250,000 XML nodes/attributes; 512 slides; 8 seconds (cooperative). Output
 * defaults to 30,000 UTF-16 code units, with a hard maximum of 100,000.
 *
 * @param {Uint8Array} bytes Buffer or Uint8Array; copied before asynchronous use.
 * @param {{kind?: 'pptx'|'docx', maxCharacters?: number, signal?: AbortSignal}} options
 * @returns {Promise<{text: string, slides: {number: number, text: string}[], truncated: boolean, warnings: string[]}>}
 */
export async function extractOfficeText(bytes, { kind = 'pptx', maxCharacters = 30000, signal } = {}) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('Office input must be a Buffer or Uint8Array.');
  if (kind !== 'pptx' && kind !== 'docx') {
    throw failure('ERR_OFFICE_UNSUPPORTED', 'Only PPTX and DOCX text extraction is supported.');
  }
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 1 || maxCharacters > LIMITS.characters) {
    throw new RangeError(`maxCharacters must be an integer between 1 and ${LIMITS.characters}.`);
  }
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean'
    || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw new TypeError('signal must be an AbortSignal.');
  }
  const context = {
    signal, maxCharacters, deadline: performance.now() + LIMITS.milliseconds,
    archiveBytes: bytes.byteLength, xmlBytes: 0, xmlNodes: 0, truncated: false, warnings: [],
  };
  check(context);
  if (!bytes.byteLength || bytes.byteLength > LIMITS.archiveBytes) {
    throw failure('ERR_OFFICE_LIMIT', 'The Office archive must be nonempty and at most 32 MiB.');
  }
  // Snapshot caller-owned memory; subsequent caller mutation must not change a
  // previously indexed ZIP while its XML parts are being read.
  const snapshot = Buffer.from(bytes);
  let zip;
  try {
    zip = await yauzl.fromBufferPromise(snapshot, {
      lazyEntries: true, autoClose: false, decodeStrings: true,
      validateEntrySizes: true, strictFileNames: true,
    });
    zip.on('error', NOOP);
    check(context);
    const entries = await indexArchive(zip, context);
    const result = kind === 'pptx'
      ? await extractPptx(zip, entries, context)
      : await extractDocx(zip, entries, context);
    check(context);
    if (context.truncated) addWarning(context, 'Extracted text was truncated at maxCharacters.');
    return { ...result, truncated: context.truncated, warnings: context.warnings };
  } catch (cause) {
    if (signal?.aborted) throw abortError(signal);
    if (cause?.name === 'OfficeExtractionError' || cause?.name === 'AbortError'
      || cause instanceof RangeError || cause instanceof TypeError) throw cause;
    throw failure('ERR_OFFICE_ARCHIVE', 'The Office ZIP archive is invalid or unsupported.', cause);
  } finally {
    zip?.close();
  }
}
