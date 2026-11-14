import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { extractOfficeText } from '../lib/extract-office.js';

const PML = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const DML = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const WML = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';
const esc = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Fixture generation only: production ZIP/XML parsing belongs to yauzl/saxes.
// All test packages stay in memory. No files, subprocesses, network, Office
// applications, global monkey-patches, or user documents are involved.
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function zipFixture(entries) {
  const locals = [];
  const directory = [];
  let offset = 0;
  for (const spec of entries) {
    const name = Buffer.from(spec.name, 'utf8');
    const comment = Buffer.from(spec.comment ?? '', 'utf8');
    const body = Buffer.isBuffer(spec.body) ? spec.body : Buffer.from(spec.body ?? '', 'utf8');
    const method = spec.method ?? 0;
    const data = method === 8 ? deflateRawSync(body) : body;
    const compressedSize = spec.claimedCompressedSize ?? data.length;
    const uncompressedSize = spec.claimedUncompressedSize ?? body.length;
    const flags = spec.flags ?? 0x800;
    const checksum = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressedSize, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(comment.length, 32);
    central.writeUInt32LE(spec.attributes ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    directory.push(central, name, comment);
    offset += local.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}
function documentXml(paragraphs) {
  return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${WML}"><w:body>${paragraphs}</w:body></w:document>`;
}
function paragraph(text) {
  return `<w:p><w:r><w:t>${esc(text)}</w:t></w:r></w:p>`;
}
function docx(text, extras = []) {
  return zipFixture([{ name: 'word/document.xml', body: documentXml(paragraph(text)) }, ...extras]);
}
function slideXml(text) {
  return `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="${PML}" xmlns:a="${DML}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${esc(text)}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;
}
function presentationXml(ids) {
  return `<?xml version="1.0"?><p:presentation xmlns:p="${PML}" xmlns:r="${REL}"><p:sldIdLst>${ids.map((id, i) => `<p:sldId id="${256 + i}" r:id="${esc(id)}"/>`).join('')}</p:sldIdLst></p:presentation>`;
}
function relationshipsXml(relations) {
  return `<Relationships xmlns="${PKG}">${relations.map((relation) => `<Relationship Id="${esc(relation.id)}" Type="${esc(relation.type ?? `${REL}/slide`)}" Target="${esc(relation.target)}"${relation.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
}
function pptxEntries(slides, { order = slides.map((slide) => slide.id), extra = [] } = {}) {
  return [
    // Deliberately put physical slide files before the metadata and permit
    // arbitrary ZIP order: neither ZIP order nor numeric filename order is the
    // presentation's authoritative page order.
    ...slides.filter((slide) => !slide.external).map((slide) => ({
      name: slide.name ?? `ppt/${slide.target}`,
      body: slide.xml ?? slideXml(slide.text ?? ''),
      method: slide.method ?? 0,
    })),
    { name: 'ppt/presentation.xml', body: presentationXml(order) },
    { name: 'ppt/_rels/presentation.xml.rels', body: relationshipsXml(slides) },
    ...extra,
  ];
}
const codeIs = (code) => (error) => error?.code === code;
const packageOrArchiveFailure = (error) => ['ERR_OFFICE_PACKAGE', 'ERR_OFFICE_ARCHIVE'].includes(error?.code);

test('PPTX follows presentation relationships, not filenames or ZIP order', async () => {
  const bytes = zipFixture(pptxEntries([
    { id: 'firstFile', target: 'slides/slide2.xml', text: 'Second slide' },
    { id: 'otherFile', target: 'slides/slide10.xml', text: '第一张：季度计划' },
  ], { order: ['otherFile', 'firstFile'] }));
  const result = await extractOfficeText(bytes);
  assert.equal(result.text, '第一张：季度计划\n\nSecond slide');
  assert.deepEqual(result.slides, [
    { number: 1, text: '第一张：季度计划' },
    { number: 2, text: 'Second slide' },
  ]);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.warnings, []);
});

test('PPTX decodes entities, joins runs and keeps paragraph/table text boundaries', async () => {
  const xml = `<p:sld xmlns:p="${PML}" xmlns:q="${DML}"><p:cSld><p:spTree><q:p><q:r><q:t>季度 &amp; </q:t></q:r><q:r><q:t>计划 &#x1F600;</q:t></q:r><q:br/><q:r><q:t>下一行</q:t></q:r></q:p><q:tbl><q:tr><q:tc><q:txBody><q:p><q:r><q:t>表格</q:t></q:r></q:p></q:txBody></q:tc></q:tr></q:tbl></p:spTree></p:cSld></p:sld>`;
  const result = await extractOfficeText(zipFixture(pptxEntries([
    { id: 'r1', target: 'slides/custom.xml', xml, method: 8 },
  ])));
  assert.equal(result.text, '季度 & 计划 😀\n下一行\n表格');
});

test('PPTX supports strict namespaces and package-absolute targets', async () => {
  const entries = pptxEntries([
    { id: 'r1', target: '/ppt/slides/custom.xml', name: 'ppt/slides/custom.xml', text: 'strict' },
  ]).map((entry) => ({
    ...entry,
    body: entry.body.replaceAll(PML, 'http://purl.oclc.org/ooxml/presentationml/main')
      .replaceAll(DML, 'http://purl.oclc.org/ooxml/drawingml/main')
      .replaceAll(REL, 'http://purl.oclc.org/ooxml/officeDocument/relationships'),
  }));
  assert.equal((await extractOfficeText(zipFixture(entries))).text, 'strict');
});

test('PPTX ignores external slide relationships without fetching them', async () => {
  const bytes = zipFixture(pptxEntries([
    { id: 'external', external: true, target: 'https://never.invalid/secret.xml' },
    { id: 'local', target: 'slides/local.xml', text: 'local only' },
  ]));
  const result = await extractOfficeText(bytes);
  assert.equal(result.text, 'local only');
  assert.deepEqual(result.slides, [{ number: 1, text: '' }, { number: 2, text: 'local only' }]);
  assert.match(result.warnings.join(' '), /external/i);
});

test('PPTX text budget is aggregate and includes inter-slide separators', async () => {
  const bytes = zipFixture(pptxEntries([
    { id: 'a', target: 'slides/a.xml', text: 'abc' },
    { id: 'b', target: 'slides/b.xml', text: 'def' },
  ]));
  const limited = await extractOfficeText(bytes, { maxCharacters: 6 });
  assert.equal(limited.text, 'abc\n\nd');
  assert.deepEqual(limited.slides, [{ number: 1, text: 'abc' }, { number: 2, text: 'd' }]);
  assert.equal(limited.truncated, true);
  assert.match(limited.warnings.join(' '), /truncated/);
  const exact = await extractOfficeText(bytes, { maxCharacters: 8 });
  assert.equal(exact.text.length, 8);
  assert.equal(exact.truncated, false);
});

test('empty slides keep their actual page number without consuming separator budget', async () => {
  const result = await extractOfficeText(zipFixture(pptxEntries([
    { id: 'empty', target: 'slides/empty.xml', text: '' },
    { id: 'full', target: 'slides/full.xml', text: 'abc' },
  ])), { maxCharacters: 3 });
  assert.equal(result.text, 'abc');
  assert.deepEqual(result.slides, [{ number: 1, text: '' }, { number: 2, text: 'abc' }]);
  assert.equal(result.truncated, false);
});

test('DOCX extracts body and table paragraphs, tabs, breaks and UTF-8 entities', async () => {
  const body = `<w:p><w:r><w:t>A &amp; </w:t><w:t>B</w:t><w:tab/><w:t>中文</w:t><w:br/><w:t>line</w:t></w:r></w:p><w:tbl><w:tr><w:tc>${paragraph('cell')}</w:tc></w:tr></w:tbl>`;
  const result = await extractOfficeText(zipFixture([
    { name: 'word/document.xml', body: documentXml(body), method: 8 },
    { name: 'word/header1.xml', body: documentXml(paragraph('not the body')) },
  ]), { kind: 'docx' });
  assert.equal(result.text, 'A & B\t中文\nline\ncell');
  assert.deepEqual(result.slides, []);
  assert.equal(result.truncated, false);
  assert.match(result.warnings.join(' '), /Headers/);
});

test('DOCX supports UTF-16LE and UTF-16BE XML', async () => {
  const xml = documentXml(paragraph('中文 😀')).replace('UTF-8', 'UTF-16');
  for (const bigEndian of [false, true]) {
    const body = Buffer.from(xml, 'utf16le');
    if (bigEndian) body.swap16();
    const bytes = zipFixture([{
      name: 'word/document.xml',
      body: Buffer.concat([Buffer.from(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]), body]),
    }]);
    assert.equal((await extractOfficeText(bytes, { kind: 'docx' })).text, '中文 😀');
  }
});

test('a text boundary does not emit a lone surrogate or skip ahead to later runs', async () => {
  const body = `<w:p><w:r><w:t>😀</w:t><w:t>x</w:t></w:r></w:p>`;
  const result = await extractOfficeText(zipFixture([
    { name: 'word/document.xml', body: documentXml(body) },
  ]), { kind: 'docx', maxCharacters: 1 });
  assert.equal(result.text, '');
  assert.equal(result.truncated, true);
  const exact = await extractOfficeText(docx('abc'), { kind: 'docx', maxCharacters: 3 });
  assert.equal(exact.text, 'abc');
  assert.equal(exact.truncated, false);
});

test('accepts Uint8Array views and snapshots caller-owned input before awaiting', async () => {
  const archive = docx('snapshot');
  const padded = Buffer.concat([Buffer.alloc(11), archive, Buffer.alloc(7)]);
  const view = new Uint8Array(padded.buffer, padded.byteOffset + 11, archive.length);
  const pending = extractOfficeText(view, { kind: 'docx' });
  padded.fill(0);
  assert.equal((await pending).text, 'snapshot');
});

test('rejects DTD/external-entity declarations rather than resolving them', async () => {
  const xml = `<!DOCTYPE w:document [<!ENTITY secret SYSTEM "file:///not-a-real-user-file">]>${documentXml(paragraph('&secret;')).replace(/^<\?xml[^?]+\?>/u, '')}`;
  await assert.rejects(extractOfficeText(zipFixture([
    { name: 'word/document.xml', body: xml },
  ]), { kind: 'docx' }), (error) => error.code === 'ERR_OFFICE_XML' && /DOCTYPE/u.test(error.message));
});

test('rejects malformed XML even after the output budget was reached', async () => {
  const malformed = documentXml(paragraph('longer than the output budget')).slice(0, -3);
  await assert.rejects(extractOfficeText(zipFixture([
    { name: 'word/document.xml', body: malformed },
  ]), { kind: 'docx', maxCharacters: 1 }), codeIs('ERR_OFFICE_XML'));
});

test('does not silently replace invalid UTF-8 bytes', async () => {
  const body = Buffer.concat([
    Buffer.from(`<w:document xmlns:w="${WML}"><w:body><w:p><w:r><w:t>`),
    Buffer.from([0xc3, 0x28]),
    Buffer.from('</w:t></w:r></w:p></w:body></w:document>'),
  ]);
  await assert.rejects(extractOfficeText(zipFixture([
    { name: 'word/document.xml', body },
  ]), { kind: 'docx' }), codeIs('ERR_OFFICE_XML'));
});

test('rejects archive encryption flags and unsupported compression', async () => {
  await assert.rejects(extractOfficeText(zipFixture([
    { name: 'word/document.xml', body: documentXml(paragraph('secret')), method: 8, flags: 0x801 },
  ]), { kind: 'docx' }), codeIs('ERR_OFFICE_UNSUPPORTED'));
  await assert.rejects(extractOfficeText(zipFixture([
    { name: 'word/document.xml', body: 'unsupported', method: 99 },
  ]), { kind: 'docx' }), codeIs('ERR_OFFICE_UNSUPPORTED'));
});

test('rejects duplicate ZIP parts, ZIP traversal names and symlink entries', async () => {
  await assert.rejects(extractOfficeText(zipFixture([
    { name: 'word/document.xml', body: documentXml(paragraph('one')) },
    { name: 'word/document.xml', body: documentXml(paragraph('two')) },
  ]), { kind: 'docx' }), codeIs('ERR_OFFICE_PACKAGE'));
  await assert.rejects(extractOfficeText(docx('safe', [
    { name: '../escape.xml', body: 'not extracted' },
  ]), { kind: 'docx' }), packageOrArchiveFailure);
  await assert.rejects(extractOfficeText(docx('safe', [
    { name: 'symlink', body: '/outside', attributes: (0xa000 << 16) >>> 0 },
  ]), { kind: 'docx' }), codeIs('ERR_OFFICE_PACKAGE'));
});

test('rejects relationship traversal and undeclared external targets', async () => {
  for (const target of ['../../outside.xml', '%2e%2e/%2e%2e/outside.xml', 'https://never.invalid/slide.xml']) {
    const entries = pptxEntries([{ id: 'r1', target, name: 'ppt/slides/safe.xml', text: 'safe' }]);
    await assert.rejects(extractOfficeText(zipFixture(entries)), codeIs('ERR_OFFICE_PACKAGE'));
  }
});

test('rejects missing parts, missing relationships, duplicate relationship ids and wrong roots', async () => {
  await assert.rejects(extractOfficeText(zipFixture([])), codeIs('ERR_OFFICE_PACKAGE'));
  const missing = pptxEntries([{ id: 'r1', target: 'slides/a.xml', text: 'a' }]);
  missing[2].body = relationshipsXml([]);
  await assert.rejects(extractOfficeText(zipFixture(missing)), codeIs('ERR_OFFICE_PACKAGE'));
  const duplicates = pptxEntries([{ id: 'r1', target: 'slides/a.xml', text: 'a' }]);
  duplicates[2].body = relationshipsXml([
    { id: 'r1', target: 'slides/a.xml' }, { id: 'r1', target: 'slides/a.xml' },
  ]);
  await assert.rejects(extractOfficeText(zipFixture(duplicates)), codeIs('ERR_OFFICE_PACKAGE'));
  await assert.rejects(extractOfficeText(zipFixture([
    { name: 'word/document.xml', body: '<document><body>wrong namespace</body></document>' },
  ]), { kind: 'docx' }), codeIs('ERR_OFFICE_PACKAGE'));
});

test('bounds ZIP comments/extra metadata as well as expanded payloads', async () => {
  await assert.rejects(extractOfficeText(docx('safe', [
    { name: 'oversized-comment', body: '', comment: 'x'.repeat(9000) },
  ]), { kind: 'docx' }), (error) => error.code === 'ERR_OFFICE_LIMIT' && /metadata/u.test(error.message));
  const extras = Array.from({ length: 180 }, (_, i) => ({
    name: `commented-${i}`, body: '', comment: 'x'.repeat(6000),
  }));
  await assert.rejects(extractOfficeText(docx('safe', extras), { kind: 'docx' }),
    (error) => error.code === 'ERR_OFFICE_LIMIT' && /metadata/u.test(error.message));
});

test('rejects excessive compression ratios before inflating an ignored entry', async () => {
  const bytes = docx('safe', [{ name: 'media/bomb', body: 'a'.repeat(200_000), method: 8 }]);
  await assert.rejects(extractOfficeText(bytes, { kind: 'docx' }), codeIs('ERR_OFFICE_LIMIT'));
});

test('rejects excess declared aggregate expansion without allocating expanded data', async () => {
  const claimed = [0, 1, 2].map((i) => ({
    name: `claimed-${i}.bin`, body: 'x', method: 8,
    claimedCompressedSize: 512 * 1024, claimedUncompressedSize: 55 * 1024 * 1024,
  }));
  // The physical archive is only ~513 KiB. Inconsistent header claims must be
  // rejected on budget alone, before any attempted 165 MiB decompression.
  const bytes = docx('safe', [...claimed, { name: 'padding.bin', body: Buffer.alloc(513 * 1024) }]);
  await assert.rejects(extractOfficeText(bytes, { kind: 'docx' }), (error) =>
    error.code === 'ERR_OFFICE_LIMIT' && /aggregate/u.test(error.message));
});

test('enforces archive entry count, XML depth and aggregate node bounds', async () => {
  const tooMany = zipFixture(Array.from({ length: 4097 }, (_, i) => ({ name: `part-${i}`, body: '' })));
  await assert.rejects(extractOfficeText(tooMany, { kind: 'docx' }), codeIs('ERR_OFFICE_LIMIT'));
  const nested = documentXml('<x>'.repeat(70) + paragraph('nested') + '</x>'.repeat(70));
  await assert.rejects(extractOfficeText(zipFixture([
    { name: 'word/document.xml', body: nested },
  ]), { kind: 'docx' }), (error) => error.code === 'ERR_OFFICE_LIMIT' && /depth/u.test(error.message));
  const manyNodes = documentXml('<x/>'.repeat(250_000));
  await assert.rejects(extractOfficeText(zipFixture([
    { name: 'word/document.xml', body: manyNodes },
  ]), { kind: 'docx' }), (error) => error.code === 'ERR_OFFICE_LIMIT' && /node/u.test(error.message));
});

test('enforces XML-part and input-byte bounds with bounded fixture memory', async () => {
  const tooLargeXml = zipFixture([{
    name: 'word/document.xml', body: Buffer.alloc(8 * 1024 * 1024 + 1, 0x20),
  }]);
  await assert.rejects(extractOfficeText(tooLargeXml, { kind: 'docx' }), codeIs('ERR_OFFICE_LIMIT'));
  await assert.rejects(extractOfficeText(Buffer.alloc(32 * 1024 * 1024 + 1), { kind: 'docx' }), codeIs('ERR_OFFICE_LIMIT'));
});

test('respects already-aborted and in-flight AbortSignals', async () => {
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(extractOfficeText(docx('safe'), { kind: 'docx', signal: aborted.signal }), { name: 'AbortError' });
  const controller = new AbortController();
  const bytes = zipFixture([{
    name: 'word/document.xml', body: documentXml(paragraph('a'.repeat(512 * 1024))),
  }]);
  const pending = extractOfficeText(bytes, { kind: 'docx', signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 0);
  try { await assert.rejects(pending, { name: 'AbortError' }); }
  finally { clearTimeout(timer); }
});

test('rejects invalid API arguments, corrupt ZIPs, and legacy non-ZIP Office bytes', async () => {
  await assert.rejects(extractOfficeText('not bytes'), TypeError);
  await assert.rejects(extractOfficeText(docx('x'), { kind: 'ppt' }), codeIs('ERR_OFFICE_UNSUPPORTED'));
  for (const maxCharacters of [0, -1, 1.5, 100_001, NaN]) {
    await assert.rejects(extractOfficeText(docx('x'), { kind: 'docx', maxCharacters }), RangeError);
  }
  await assert.rejects(extractOfficeText(docx('x'), { signal: {} }), TypeError);
  await assert.rejects(extractOfficeText(Buffer.from('not a ZIP')), codeIs('ERR_OFFICE_ARCHIVE'));
  await assert.rejects(extractOfficeText(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])), codeIs('ERR_OFFICE_ARCHIVE'));
});
