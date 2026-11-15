import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SOURCE = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
// This one external location was explicitly approved by the user. No arbitrary
// --output-root, HOME-derived cache location, or fallback temporary directory.
export const APPROVED_CACHE_ROOT = path.join(os.homedir(), 'Library/Caches/DeepSeekHarness/WorkfilesVoice');
const OWNER = 'workfiles-voice-native-v1';
const APP_ID = 'local.workfiles.voice';
const APP_NAME = 'Workfiles Voice Helper.app';
const NATIVE_FILES = ['main.mjs', 'preload.cjs', 'protocol.mjs', 'security.mjs', 'controller.mjs', 'motion.mjs', 'LICENSE.Electron'];
const UI_FILES = ['index.html', 'panel.js', 'panel.css', 'audio.js', 'view-state.js'];
const FRAMEWORKS = ['Electron Framework.framework', 'Mantle.framework', 'ReactiveObjC.framework', 'Squirrel.framework'];
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function plist(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n${Object.entries(entries).map(([key, value]) => `<key>${xml(key)}</key>${typeof value === 'boolean' ? `<${value}/>` : `<string>${xml(value)}</string>`}`).join('\n')}\n</dict></plist>\n`;
}
async function fileHash(file) { const digest = createHash('sha256'); for await (const bytes of createReadStream(file)) digest.update(bytes); return digest.digest('hex'); }
async function optionalStat(file) { try { return await fs.lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function plainFile(file, max = 512 * 1024) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error(`Expected a bounded, real source file: ${file}`);
  return fs.readFile(file);
}

// The build and probe never inherit runtime injection flags, tokens or credentials.
export function buildEnvironment(source = process.env) {
  const result = {};
  for (const key of ['HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', '__CF_USER_TEXT_ENCODING']) if (typeof source[key] === 'string') result[key] = source[key];
  result.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return result;
}
async function command(executable, argv, env, maxBuffer = 65536) {
  try { return await exec(executable, argv, { env, timeout: 30000, maxBuffer, encoding: 'utf8' }); }
  catch (error) {
    // Report bounded diagnostics, never the environment or caller's secrets.
    throw new Error(`${path.basename(executable)} exited ${error.code ?? 'unsuccessfully'}: ${String(error.stderr || error.message).slice(0, 1000)}`);
  }
}

export async function readFuseWire(file) {
  const sentinel = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX');
  let overlap = Buffer.alloc(0), found = null;
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) {
    const bytes = Buffer.concat([overlap, chunk]);
    const index = bytes.indexOf(sentinel);
    if (index !== -1 && index + sentinel.length + 11 <= bytes.length) {
      const start = index + sentinel.length;
      if (found) throw new Error('Ambiguous Electron fuse layout');
      found = { version: bytes[start], length: bytes[start + 1], wire: bytes.subarray(start + 2, start + 2 + bytes[start + 1]).toString('ascii') };
    }
    overlap = bytes.subarray(Math.max(0, bytes.length - 128));
  }
  if (!found || found.version !== 1 || found.length !== 9 || !/^[01r]{9}$/u.test(found.wire)) throw new Error('Unsupported Electron fuse layout; original app is never patched');
  if (found.wire[0] !== '1' || found.wire[4] !== '0' || found.wire[5] !== '0') throw new Error('Installed Electron disallows a separate unpacked helper; original fuses will not be changed');
  return found;
}

export function resolveBuildOutputRoot(bundleRoot, requested = path.join(bundleRoot, '.native')) {
  if (typeof requested !== 'string' || !requested) throw new Error('Expected an approved output root');
  const resolved = path.resolve(bundleRoot, requested);
  if (resolved !== path.join(bundleRoot, '.native') && resolved !== APPROVED_CACHE_ROOT) throw new Error('Output root is not explicitly approved');
  return resolved;
}
export function parseBuildArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index] === '--source-executable' ? 'sourceExecutable' : args[index] === '--output-root' ? 'outputRoot' : null;
    const value = args[index + 1];
    if (!key || Object.hasOwn(options, key) || typeof value !== 'string' || !value || value.startsWith('--')) throw new Error('Usage: node native/build-helper.mjs [--source-executable PATH] [--output-root APPROVED_PATH]');
    options[key] = value;
  }
  return options;
}
async function prepareOwnedOutputRoot(root, bundleRoot) {
  resolveBuildOutputRoot(bundleRoot, root);
  if (root === APPROVED_CACHE_ROOT) {
    const cacheParent = path.join(os.homedir(), 'Library/Caches');
    const parentStat = await fs.lstat(cacheParent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await fs.realpath(cacheParent) !== cacheParent) throw new Error('Approved cache ancestor is not a real directory');
    const namespace = path.dirname(APPROVED_CACHE_ROOT);
    const namespaceStat = await optionalStat(namespace);
    if (!namespaceStat) await fs.mkdir(namespace, { mode: 0o700 });
    else if (!namespaceStat.isDirectory() || namespaceStat.isSymbolicLink() || await fs.realpath(namespace) !== namespace) throw new Error('Approved cache namespace cannot be a symlink');
  }
  const stat = await optionalStat(root);
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('Refusing a non-owned output path');
  if (!stat) await fs.mkdir(root, { mode: 0o700 });
  if (await fs.realpath(root) !== root) throw new Error('Output root cannot resolve outside its approved path');
  const marker = path.join(root, '.owner.json');
  if (await optionalStat(marker)) {
    const owner = JSON.parse((await plainFile(marker)).toString());
    if (owner.owner !== OWNER || owner.v !== 1 || (owner.bundleRoot !== undefined && owner.bundleRoot !== bundleRoot)) throw new Error('Unrecognized output ownership marker');
  } else {
    if ((await fs.readdir(root)).length) throw new Error('Existing output directory has no ownership marker; refusing to touch it');
    await writeOwned(root, marker, JSON.stringify({ owner: OWNER, v: 1, bundleRoot }) + '\n');
  }
}
async function publishManifest(manifest, outputRoot, bundleRoot) {
  const locatorRoot = path.join(bundleRoot, '.native');
  await prepareOwnedOutputRoot(locatorRoot, bundleRoot);
  const bytes = JSON.stringify(manifest, null, 2) + '\n';
  await writeOwned(outputRoot, path.join(outputRoot, 'helper.json'), bytes);
  if (locatorRoot !== outputRoot) await writeOwned(locatorRoot, path.join(locatorRoot, 'helper.json'), bytes);
}
async function ownedDirectory(root, directory) {
  if (!isInside(root, directory)) throw new Error('Build target is outside the owned output');
  const relative = path.relative(root, directory);
  let current = root;
  for (const segment of relative ? relative.split(path.sep) : []) {
    current = path.join(current, segment);
    const stat = await optionalStat(current);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error(`Refusing non-directory or symlink in owned output: ${current}`);
    if (!stat) await fs.mkdir(current, { mode: 0o700 });
  }
}
async function writeOwned(root, file, bytes, mode = 0o644) {
  if (!isInside(root, file) || file === root) throw new Error('Invalid owned output file');
  await ownedDirectory(root, path.dirname(file));
  const stat = await optionalStat(file);
  if (stat && (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)) throw new Error(`Refusing to overwrite a non-regular or linked output: ${file}`);
  await fs.writeFile(file, bytes, { mode });
  if (mode === 0o755) await fs.chmod(file, mode);
}
async function copyFramework(root, source, target, sourceRoot = source) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) {
    const link = await fs.readlink(source);
    if (path.isAbsolute(link) || !isInside(sourceRoot, await fs.realpath(source))) throw new Error('Installed framework has an external symlink; refusing to copy');
    await ownedDirectory(root, path.dirname(target));
    const existing = await optionalStat(target);
    if (existing) {
      if (!existing.isSymbolicLink() || await fs.readlink(target) !== link) throw new Error('Unexpected owned framework link');
    } else await fs.symlink(link, target);
    return { bytes: 0, files: 0 };
  }
  if (stat.isDirectory()) {
    await ownedDirectory(root, target);
    const total = { bytes: 0, files: 0 };
    for (const entry of await fs.readdir(source)) {
      const result = await copyFramework(root, path.join(source, entry), path.join(target, entry), sourceRoot);
      total.bytes += result.bytes; total.files += result.files;
    }
    return total;
  }
  if (!stat.isFile()) throw new Error('Unexpected special source framework file');
  await ownedDirectory(root, path.dirname(target));
  const existing = await optionalStat(target);
  if (existing && (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)) throw new Error('Unexpected owned framework file');
  await fs.copyFile(source, target);
  await fs.chmod(target, stat.mode & 0o777);
  return { bytes: stat.size, files: 1 };
}
async function checkTree(directory, appRoot = directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const link = await fs.readlink(file);
      if (path.isAbsolute(link) || !isInside(appRoot, path.resolve(path.dirname(file), link)) || !isInside(appRoot, await fs.realpath(file))) throw new Error('Unexpected external link in owned app; refusing to sign');
    } else if (entry.isDirectory()) await checkTree(file, appRoot);
    else if (!entry.isFile()) throw new Error('Unexpected special file in owned app');
  }
}
async function cleanOwnedDetritus(file, outputRoot, env) {
  // FileProvider can re-add empty FinderInfo while a slow recursive xattr runs.
  // First verify/collect owned real paths, then clear each attribute in one
  // non-recursive batch immediately before signing. Never follow external links
  // or remove quarantine, provenance or another OS security attribute.
  const targets = [];
  async function collect(target) {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink()) return;
    if (!isInside(outputRoot, target) || await fs.realpath(target) !== target) throw new Error('Refusing metadata removal outside the owned output');
    if (stat.isDirectory()) for (const entry of await fs.readdir(target)) await collect(path.join(target, entry));
    targets.push(target);
  }
  await collect(file);
  const batches = [];
  for (let index = 0; index < targets.length; index += 64) batches.push(targets.slice(index, index + 64));
  // Clear package-directory Finder flags last, in one small non-recursive call.
  batches.push(targets.filter(target => /\.(app|framework)$/u.test(target)));
  for (const batch of batches) for (const attribute of ['com.apple.ResourceFork', 'com.apple.FinderInfo']) {
    if (!batch.length) continue;
    try { await exec('/usr/bin/xattr', ['-d', attribute, ...batch], { env, timeout: 5000, maxBuffer: 65536 }); }
    catch (error) {
      const lines = String(error.stderr).trim().split(/\r?\n/u).filter(Boolean);
      if (!(error.code === 1 && lines.length && lines.every(line => /No such xattr|does not exist/u.test(line)))) throw new Error('Could not clean owned build metadata');
    }
  }
}
async function signOwned(appPath, outputRoot, entitlements, env) {
  if (!isInside(outputRoot, appPath) || await fs.realpath(appPath) !== appPath) throw new Error('Refusing to sign anything outside the owned output');
  await checkTree(appPath);
  await cleanOwnedDetritus(appPath, outputRoot, env);
  // Deliberately no --deep: copied frameworks retain their vendor signatures.
  await command('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, '--timestamp=none', appPath], env);
  await command('/usr/bin/codesign', ['--verify', '--strict', appPath], env);
}

export async function buildHelper({ sourceExecutable = process.env.DSH_NODE_EXECUTABLE || DEFAULT_SOURCE, outputRoot: requestedOutputRoot } = {}) {
  if (process.platform !== 'darwin') throw new Error('This local helper builder currently supports macOS only');
  const bundleRoot = await fs.realpath(path.join(moduleDir, '..'));
  const outputRoot = resolveBuildOutputRoot(bundleRoot, requestedOutputRoot);
  const sourceExe = await fs.realpath(sourceExecutable);
  const sourceApp = path.resolve(sourceExe, '../../..');
  if (!sourceApp.endsWith('.app') || path.dirname(sourceExe) !== path.join(sourceApp, 'Contents/MacOS') || isInside(outputRoot, sourceExe)) throw new Error('Expected the installed Electron .app executable, not an output or arbitrary runtime');
  await plainFile(sourceExe, 16 * 1024 * 1024);
  const env = buildEnvironment();
  const probe = "const fs=require('node:fs');const p=JSON.parse(fs.readFileSync(require('node:path').join(require('node:path').dirname(process.execPath),'../Resources/app.asar/package.json'),'utf8'));console.log(JSON.stringify({electronVersion:process.versions.electron,nodeVersion:process.versions.node,chromeVersion:process.versions.chrome,architecture:process.arch,appVersion:p.version,appPackage:p.name}));";
  const { stdout } = await command(sourceExe, ['-e', probe], { ...env, ELECTRON_RUN_AS_NODE: '1' }, 8192);
  const runtime = JSON.parse(stdout.trim());
  if (!/^\d+\.\d+\.\d+/u.test(runtime.electronVersion ?? '') || runtime.appPackage !== '@deepseek-ai/dsh-desktop') throw new Error('Source did not verify as this installed Harness Electron runtime');
  const sourceFrameworks = path.join(sourceApp, 'Contents/Frameworks');
  const sourceFrameworkBinary = await fs.realpath(path.join(sourceFrameworks, 'Electron Framework.framework/Versions/A/Electron Framework'));
  if (!isInside(sourceApp, sourceFrameworkBinary)) throw new Error('Unexpected source framework outside the installed app');
  const fuses = await readFuseWire(sourceFrameworkBinary);
  const sourceExecutableHash = await fileHash(sourceExe), sourceRuntimeHash = await fileHash(sourceFrameworkBinary);
  await command('/usr/bin/codesign', ['--verify', '--strict', sourceApp], env);

  // Build refuses missing product UI resources; it never synthesizes a preview.
  const files = new Map();
  for (const name of NATIVE_FILES) files.set(`native/${name}`, await plainFile(path.join(bundleRoot, 'native', name)));
  for (const name of UI_FILES) files.set(`voice-ui/${name}`, await plainFile(path.join(bundleRoot, 'voice-ui', name)));
  if (await optionalStat(path.join(bundleRoot, 'voice-ui/icon.svg'))) files.set('voice-ui/icon.svg', await plainFile(path.join(bundleRoot, 'voice-ui/icon.svg')));
  const sourceName = path.basename(sourceExe);
  const helpers = [];
  for (const [suffix, role] of [['', 'utility'], [' (GPU)', 'gpu'], [' (Plugin)', 'plugin'], [' (Renderer)', 'renderer']]) {
    const name = `${sourceName} Helper${suffix}`;
    const helperRoot = path.join(sourceFrameworks, `${name}.app`);
    const executable = await plainFile(path.join(helperRoot, 'Contents/MacOS', name), 16 * 1024 * 1024);
    helpers.push({ name, role, executable, sourceHash: hash(executable) });
  }
  for (const name of FRAMEWORKS) {
    const real = await fs.realpath(path.join(sourceFrameworks, name));
    if (!isInside(sourceApp, real) || !(await fs.stat(real)).isDirectory()) throw new Error('Unexpected framework source');
  }
  const resourceHashes = Object.fromEntries([...files].map(([name, bytes]) => [name, hash(bytes)]));
  const buildId = hash(JSON.stringify({ sourceExe, sourceExecutableHash, sourceRuntimeHash, helpers: helpers.map(({ name, sourceHash }) => ({ name, sourceHash })), resourceHashes,
    builderHash: hash(await plainFile(fileURLToPath(import.meta.url))) })).slice(0, 24);
  await prepareOwnedOutputRoot(outputRoot, bundleRoot);
  const buildRoot = path.join(outputRoot, `${buildId}.nosync`), appPath = path.join(buildRoot, APP_NAME);
  await ownedDirectory(outputRoot, buildRoot);
  const buildOwner = path.join(buildRoot, '.owner.json');
  if (await optionalStat(buildOwner)) {
    if (JSON.parse((await plainFile(buildOwner)).toString()).buildId !== buildId) throw new Error('Unrecognized build directory ownership');
  } else {
    if ((await fs.readdir(buildRoot)).length) throw new Error('Build directory is not empty and not owned');
    await writeOwned(outputRoot, buildOwner, JSON.stringify({ owner: OWNER, buildId }) + '\n');
  }
  const completeFile = path.join(buildRoot, 'complete.json');
  if (await optionalStat(completeFile)) {
    const manifest = JSON.parse((await plainFile(completeFile)).toString());
    if (manifest.buildId !== buildId || manifest.owner !== OWNER || manifest.bundleRoot !== bundleRoot || manifest.artifactRoot !== outputRoot || manifest.buildRoot !== buildRoot || manifest.executableRelativeBase !== 'artifactRoot' || manifest.executable !== path.join(appPath, 'Contents/MacOS', sourceName)) throw new Error('Invalid completed helper manifest');
    await checkTree(appPath);
    if (await fileHash(manifest.executable) !== manifest.executableHash) throw new Error('Completed helper executable has changed; refusing to overwrite a running helper');
    for (const [relative, expected] of Object.entries(resourceHashes)) if (await fileHash(path.join(appPath, 'Contents/Resources/app', relative)) !== expected) throw new Error('Completed native resources have changed');
    await command('/usr/bin/codesign', ['--verify', '--strict', appPath], env);
    await publishManifest(manifest, outputRoot, bundleRoot);
    return manifest;
  }
  // Versioned build directories avoid replacing a running executable. No delete
  // or move (recursive or otherwise) is used anywhere in this builder.
  await ownedDirectory(outputRoot, appPath);
  await ownedDirectory(outputRoot, path.join(buildRoot, 'runtime/chromium'));
  await ownedDirectory(outputRoot, path.join(buildRoot, 'runtime/logs'));
  const contents = path.join(appPath, 'Contents');
  const executable = path.join(contents, 'MacOS', sourceName);
  await writeOwned(outputRoot, executable, await fs.readFile(sourceExe), 0o755);
  await writeOwned(outputRoot, path.join(contents, 'Info.plist'), plist({
    CFBundleDisplayName: 'Workfiles 语音助手', CFBundleExecutable: sourceName, CFBundleIdentifier: APP_ID,
    // Electron discovers its existing-named Helper.app executables via this name.
    CFBundleName: sourceName, CFBundlePackageType: 'APPL', CFBundleInfoDictionaryVersion: '6.0', CFBundleVersion: '1', CFBundleShortVersionString: '0.1.0',
    LSMinimumSystemVersion: '13.0', LSUIElement: true, NSHighResolutionCapable: true, NSPrincipalClass: 'AtomApplication',
    NSMicrophoneUsageDescription: '仅在你按语音快捷键或点击开始后，将本次语音在本机转写为工作资料检索指令。', NSSupportsAutomaticGraphicsSwitching: true,
  }));
  await writeOwned(outputRoot, path.join(contents, 'PkgInfo'), 'APPL????');
  const appSource = path.join(contents, 'Resources/app');
  await writeOwned(outputRoot, path.join(appSource, 'package.json'), JSON.stringify({ name: 'workfiles-voice-helper', productName: 'Workfiles Voice Helper', version: '0.1.0', private: true, type: 'module', main: 'native/main.mjs', license: 'MIT' }, null, 2) + '\n');
  for (const [relative, bytes] of files) await writeOwned(outputRoot, path.join(appSource, relative), bytes);
  let copiedFrameworkBytes = 0, copiedFrameworkFiles = 0;
  for (const name of FRAMEWORKS) {
    const result = await copyFramework(outputRoot, path.join(sourceFrameworks, name), path.join(contents, 'Frameworks', name));
    copiedFrameworkBytes += result.bytes; copiedFrameworkFiles += result.files;
  }
  const entitlements = path.join(buildRoot, 'entitlements.plist');
  await writeOwned(outputRoot, entitlements, plist({ 'com.apple.security.cs.allow-jit': true, 'com.apple.security.cs.allow-unsigned-executable-memory': true,
    'com.apple.security.cs.disable-library-validation': true, 'com.apple.security.device.audio-input': true }));
  for (const helper of helpers) {
    const helperPath = path.join(contents, 'Frameworks', `${helper.name}.app`);
    await writeOwned(outputRoot, path.join(helperPath, 'Contents/MacOS', helper.name), helper.executable, 0o755);
    await writeOwned(outputRoot, path.join(helperPath, 'Contents/Info.plist'), plist({ CFBundleDisplayName: `Workfiles Voice ${helper.role}`, CFBundleExecutable: helper.name,
      CFBundleIdentifier: `${APP_ID}.helper.${helper.role}`, CFBundleName: helper.name, CFBundlePackageType: 'APPL', CFBundleVersion: '1', LSUIElement: true,
      NSSupportsAutomaticGraphicsSwitching: true }));
    await writeOwned(outputRoot, path.join(helperPath, 'Contents/PkgInfo'), 'APPL????');
    await signOwned(helperPath, outputRoot, entitlements, env);
  }
  await signOwned(appPath, outputRoot, entitlements, env);
  if (await fileHash(path.join(contents, 'Frameworks/Electron Framework.framework/Versions/A/Electron Framework')) !== sourceRuntimeHash) throw new Error('Copied Electron framework does not match the source runtime');
  // Node mode proves copied launcher + owned dyld/framework resolution only;
  // intentionally do not launch BrowserWindow, global shortcuts or permissions.
  const verification = await command(executable, ['-e', "console.log(JSON.stringify({electronVersion:process.versions.electron,execPath:process.execPath}))"], { ...env, ELECTRON_RUN_AS_NODE: '1' }, 8192);
  if (JSON.parse(verification.stdout).electronVersion !== runtime.electronVersion) throw new Error('Copied helper resolved a different Electron runtime');
  if (await fileHash(sourceExe) !== sourceExecutableHash || await fileHash(sourceFrameworkBinary) !== sourceRuntimeHash) throw new Error('Installed runtime changed during build; rebuild against the current version');
  for (const name of FRAMEWORKS) {
    await command('/usr/bin/codesign', ['--verify', '--strict', path.join(contents, 'Frameworks', name)], env);
    await command('/usr/bin/codesign', ['--verify', '--strict', path.join(sourceFrameworks, name)], env);
  }
  await command('/usr/bin/codesign', ['--verify', '--strict', sourceApp], env);
  const manifest = {
    v: 1, owner: OWNER, buildId, executable, executableRelative: path.relative(outputRoot, executable), executableRelativeBase: 'artifactRoot', executableHash: await fileHash(executable),
    artifactRoot: outputRoot, buildRoot, appPath, bundleRoot, sourceExecutable: sourceExe, sourceExecutableHash, sourceRuntimeHash, sourceFrameworkBinary, sourceApp,
    electronVersion: runtime.electronVersion, nodeVersion: runtime.nodeVersion, chromeVersion: runtime.chromeVersion, architecture: runtime.architecture,
    sourceAppVersion: runtime.appVersion, fuses, resourceHashes, runtimeMode: 'copied-frameworks-owned-launchers', copiedFrameworkBytes, copiedFrameworkFiles, signed: 'ad-hoc-owned-only',
    validation: { codeSignVerify: true, copiedFrameworkSignatures: true, sourceSignaturesAfterBuild: true, copiedRuntimeNodeMode: true, guiLaunched: false, microphoneOpened: false },
    licenses: { electron: 'MIT', electronSource: `https://github.com/electron/electron/blob/v${runtime.electronVersion}/LICENSE`, chromium: 'BSD-3-Clause and other third-party licenses; copied from locally installed runtime, not a portable redistribution package' },
  };
  await writeOwned(outputRoot, completeFile, JSON.stringify(manifest, null, 2) + '\n');
  await publishManifest(manifest, outputRoot, bundleRoot);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const manifest = await buildHelper(parseBuildArguments(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
  } catch (error) { process.stderr.write(`Native helper build failed: ${error.message}\n`); process.exitCode = 1; }
}
