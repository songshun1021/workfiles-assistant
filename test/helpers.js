import path from 'node:path';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isInside } from '../lib/documents.js';

export const FIXTURE_ROOT = fileURLToPath(new URL('./fixtures/work/', import.meta.url));
const TEMP_ROOT = fileURLToPath(new URL('./.tmp/', import.meta.url));

export class LocalTestFilesystem {
  reads = []; listings = [];
  async resolve(input) {
    const absolute = path.resolve(input);
    const canonical = await fs.realpath(absolute).catch(error => { if (error.code === 'ENOENT') return absolute; throw error; });
    return { targetKey: canonical, displayPath: canonical };
  }
  processPath(target) { return target.targetKey; }
  processPathFromHostPath(value) { return value; }
  fileUrl(target) { return pathToFileURL(target.targetKey).href; }
  contains(parent, child) { return isInside(parent.targetKey, child.targetKey); }
  async stat(target) {
    const value = await fs.stat(target.targetKey).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!value) return undefined;
    return { type: value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other', size: value.size, version: `${value.dev}:${value.ino}:${value.mtimeMs}:${value.size}` };
  }
  async lstat(input) {
    const value = await fs.lstat(input).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!value) return undefined;
    return { type: value.isSymbolicLink() ? 'symlink' : value.isFile() ? 'file' : value.isDirectory() ? 'directory' : 'other', size: value.size, version: `${value.dev}:${value.ino}:${value.mtimeMs}:${value.size}` };
  }
  async listDir(target) {
    this.listings.push(target.targetKey);
    const entries = await fs.readdir(target.targetKey, { withFileTypes: true });
    const result = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) result.push({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', target: await this.resolve(path.join(target.targetKey, entry.name)) });
    return result;
  }
  async readBytes(target, signal, maxBytes) {
    signal?.throwIfAborted();
    const info = await fs.stat(target.targetKey);
    if (info.size > maxBytes) { const error = new Error('File too large'); error.code = 'FS_TOO_LARGE'; throw error; }
    this.reads.push(target.targetKey);
    const value = await fs.readFile(target.targetKey, { signal });
    if (value.length > maxBytes) throw new Error('File grew beyond cap');
    return value;
  }
}
export async function temporary(t) {
  await fs.mkdir(TEMP_ROOT, { recursive: true });
  const directory = await fs.mkdtemp(path.join(TEMP_ROOT, 'workfiles-'));
  t.after(async () => {
    const absolute = path.resolve(directory);
    // Never delete a computed/unverified path: cleanup is confined to this test's owned direct child.
    assert.equal(path.dirname(absolute), path.resolve(TEMP_ROOT));
    assert.ok(path.basename(absolute).startsWith('workfiles-'));
    await fs.rm(absolute, { recursive: true, force: true });
  });
  return directory;
}
export async function textFile(directory, name, text = 'fixture', when = '2026-11-10T10:00:00Z') {
  const file = path.join(directory, name); await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text); const time = new Date(when); await fs.utimes(file, time, time); return file;
}
