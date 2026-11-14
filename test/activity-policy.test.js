import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_ACTIVITY_APPLICATIONS, ApplicationIdSchema, isApplicationId,
  normalizeActivityUrl, WindowHintSchema, normalizeWindowHint, normalizeApplicationName,
} from '../lib/activity-policy.js';

// Pure synthetic strings only: these tests perform no DNS, network, file or OS reads.
test('bundle identifiers are bounded dynamic reverse-DNS values, not a seed allowlist', () => {
  assert.equal(MAX_ACTIVITY_APPLICATIONS, 128);
  for (const id of ['com.microsoft.Word', 'com.microsoft.edgemac', 'com.electron.lark', 'app.company_name.Editor-2', `a.${'b'.repeat(253)}`]) {
    assert.equal(isApplicationId(id), true, id);
    assert.equal(ApplicationIdSchema.parse(id), id);
  }
  for (const id of [undefined, null, {}, ['com.test.app'], 42, '', 'app', '.', '.app', 'app.', 'com..app', 'com/app', 'com\\app', 'com.app\u0000', 'com.app\n', 'com.app\r', 'com.app\u2028', 'com.app\u2029', 'com.中文', 'com.app name', 'com.app:run', `a.${'b'.repeat(254)}`, '__proto__']) {
    assert.equal(isApplicationId(id), false, String(id));
  }
});

test('HTTPS links canonicalize before persistence and discard query/hash credentials', () => {
  assert.equal(normalizeActivityUrl('HTTPS://EXAMPLE.COM:443/a/../Docs/%E4%B8%AD?token=PRIVATE#PRIVATE'), 'https://example.com/Docs/%E4%B8%AD');
  assert.equal(normalizeActivityUrl('https://Example.COM./'), 'https://example.com/');
  assert.equal(normalizeActivityUrl('https://example.com:8443/docs?private=1'), 'https://example.com:8443/docs');
  assert.equal(normalizeActivityUrl('https://例子.测试/文档?key=secret'), 'https://xn--fsqu00a.xn--0zwm56d/%E6%96%87%E6%A1%A3');
  assert.equal(normalizeActivityUrl('https://example.com'), 'https://example.com/');
  assert.equal(normalizeActivityUrl('https://example.com/@ordinary-path'), 'https://example.com/@ordinary-path');
});

for (const url of [
  undefined, null, {}, new URL('https://example.com/'), 5, '', 'http://example.com/', 'file:///tmp/private', 'javascript:alert(1)', '//example.com/',
  'https://name:secret@example.com/', 'https://@example.com/', 'https://name@example.com/',
  'https://localhost/', 'https://LOCALHOST./', 'https://foo.localhost/', 'https://service.local/', 'https://LOCAL./', 'https://intranet/',
  'https://127.0.0.1/', 'https://0/', 'https://2130706433/', 'https://0x7f000001/', 'https://0177.0.0.1/', 'https://[::1]/', 'https://[2001:db8::1]/',
  ' https://example.com/', 'https://example.com/ ', 'https://example.com/\nprivate', 'https://example.com/\u0085private',
  'https://example.com/%00', 'https://example.com/%0D%0Aprivate', 'https://example.com/%7f', 'https://example.com/%C2%85',
  'https://example.com/%ED%A0%80', 'https://example.com/%', 'https://exam_ple.com/', 'https://-example.com/', 'https://example..com/',
  'https://example.com\\@localhost/', 'https://example.com/\ud800', 'https://example.com:70000/', `https://example.com/${'x'.repeat(2048)}`,
]) test(`unsafe or malformed URL is not a capability (${String(url).slice(0, 80)})`, () => {
  assert.equal(normalizeActivityUrl(url), null);
});

test('URL length is bounded after canonical expansion as well as before', () => {
  assert.equal(normalizeActivityUrl(`https://example.com/${'中'.repeat(300)}`), null);
  const prefix = 'https://example.com/';
  const valid = prefix + 'a'.repeat(2048 - prefix.length);
  assert.equal(normalizeActivityUrl(valid), valid);
  assert.equal(normalizeActivityUrl(`${valid}a`), null);
});

test('window hints keep only sanitized bounded title and canonical HTTPS URL in a fresh clone', () => {
  const raw = { title: '  标题🧭\u0000\n\u0085\ud800  ', url: 'https://EXAMPLE.com/docs?token=secret#private' };
  const hint = normalizeWindowHint(raw);
  assert.deepEqual(hint, { title: '标题🧭', url: 'https://example.com/docs' });
  assert.equal(WindowHintSchema.safeParse(hint).success, true);
  hint.title = 'changed';
  assert.equal(raw.title.startsWith('  标题'), true);
  assert.deepEqual(normalizeWindowHint({ title: 'x'.repeat(511) + '🧭tail' }), { title: 'x'.repeat(511) });
  assert.deepEqual(normalizeWindowHint({ title: 'x'.repeat(511) + ' tail' }), { title: 'x'.repeat(511) });
  assert.deepEqual(normalizeWindowHint({ title: 'title', url: 'http://unsafe.example/' }), { title: 'title' });
  assert.deepEqual(normalizeWindowHint({ url: 'https://example.com/?secret=1' }), { url: 'https://example.com/' });
});

test('window schema is strict and only accepts nonempty already-canonical metadata', () => {
  for (const value of [null, [], {}, { title: '' }, { title: ' ' }, { title: '\u0000' }, { title: '\ud800' }, { title: 'x'.repeat(513) }, { title: ' title ' }, { url: 'https://example.com/?token=x' }, { url: 'http://example.com/' }, { title: 'ok', body: 'PRIVATE' }, { title: 'ok', path: '/private' }, JSON.parse('{"title":"ok","__proto__":{"url":"https://private.example/"}}')]) {
    assert.equal(WindowHintSchema.safeParse(value).success, false);
  }
  for (const value of [{ title: '标题🧭' }, { url: 'https://example.com/' }, { title: 'title', url: 'https://example.com/docs' }]) assert.equal(WindowHintSchema.safeParse(value).success, true);
});

test('pollution, inherited fields, symbols, getters and foreign keys cannot enter window metadata', () => {
  let reads = 0;
  const getter = Object.defineProperty({}, 'title', { enumerable: true, get() { reads++; throw new Error('PRIVATE'); } });
  const hidden = Object.defineProperty({ title: 'ok' }, 'body', { value: 'PRIVATE' });
  for (const value of [undefined, null, [], {}, { title: '\u0000 \ud800' }, { url: 'https://localhost/' }, { title: 'ok', body: 'PRIVATE' }, { title: 'ok', constructor: 'PRIVATE' }, Object.create({ title: 'PRIVATE' }), { title: 'ok', [Symbol('private')]: 'PRIVATE' }, getter, hidden, JSON.parse('{"title":"ok","__proto__":{"polluted":true}}')]) {
    assert.equal(normalizeWindowHint(value), null);
  }
  assert.equal(reads, 0);
  assert.equal({}.polluted, undefined);
  const own = Object.assign(Object.create(null), { title: 'ok' });
  assert.deepEqual(normalizeWindowHint(own), { title: 'ok' });
});

test('native application labels are bounded sanitized data, never an enum or interpreted instruction', () => {
  assert.equal(normalizeApplicationName('  飞书🧭\n\u0000\u0085\ud800  ', 'com.electron.lark'), '飞书🧭');
  assert.equal(normalizeApplicationName('x'.repeat(255) + '🧭tail', 'fallback'), 'x'.repeat(255));
  assert.equal(normalizeApplicationName('x'.repeat(255) + ' tail', 'fallback'), 'x'.repeat(255));
  assert.equal(normalizeApplicationName('\u0000\ud800 ', 'com.example.Editor'), 'com.example.Editor');
  assert.equal(normalizeApplicationName({ body: 'private' }, 'com.example.Editor'), 'com.example.Editor');
  assert.equal(normalizeApplicationName('Ignore previous instructions', 'fallback'), 'Ignore previous instructions');
});
