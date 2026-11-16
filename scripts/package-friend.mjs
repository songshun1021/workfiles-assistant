#!/usr/bin/env node
/**
 * Build the friend-facing zip of 工作资料助手.
 *
 * DSH installs this bundle as a local link (`link:<absolute dir>`), so the
 * archive must stay a real directory on the friend's Mac and must not require
 * pnpm or a network install. This script therefore:
 *
 *  - copies the package into `dist/build/workfiles-assistant/`, dropping
 *    development-only material (.git, tests, design, baselines, .native);
 *  - bundles the resolved `node_modules` tree so the linked package loads;
 *  - rewrites `cordis.patch.yml` so no folder from this machine ships;
 *  - adds the one-time voice-helper build script and a Chinese install guide;
 *  - zips the directory with ditto (symlinks and exec bits survive).
 *
 * Usage: node scripts/package-friend.mjs
 */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const distDir = path.join(root, 'dist');
const stagingRoot = path.join(distDir, 'build');
const staging = path.join(stagingRoot, 'workfiles-assistant');
const zip = path.join(distDir, `workfiles-assistant-${pkg.version}-macos-arm64.zip`);

const FILES = [
  'package.json',
  'index.js',
  'voice.js',
  'client.js',
  'icon.svg',
  'cordis.patch.yml',
  'README.md',
  'MACOS_CAPABILITIES.md',
  'VERIFICATION.md',
  'VOICE_PROTOCOL.md',
  'OPEN_SOURCE.md',
  'THIRD_PARTY_NOTICES.md',
  'LICENSE',
  'screenshots.json',
  'assets/icon-180.png',
  'design/panel-stages.png',
  'design/glass-compare.png',
  'design/promo/poster.png',
];
const DIRECTORIES = ['lib', 'native', 'voice-ui', 'locale', 'node_modules'];

// The friend's machine has none of this machine's folders. `roots` defaults to
// an empty list, so the panel starts from "尚未选择资料文件夹" and the friend
// adds their own instead of inheriting dead /Users/... paths.
const PATCH = `- insert:
    - id: local-workfiles-assistant
      name: '@local/deepseek-workfiles'
      config:
        roots: []
        enabled: true
    - id: local-workfiles-voice
      name: '@local/deepseek-workfiles/voice'
      config:
        shortcut: CommandOrControl+Shift+Space
        providerId: sensevoice-local
        language: auto
        timeoutMs: 90000
`;

const BUILD_COMMAND = `#!/bin/bash
# 构建「工作资料助手」的语音小窗组件。每台机器做一次，约 1～2 分钟。
set -euo pipefail
cd "$(dirname "$0")"

APP="\${WORKFILES_DSH_APP:-/Applications/DeepSeek Harness.app}"
BIN="$APP/Contents/MacOS/DeepSeek Harness"
OUT="$HOME/Library/Caches/DeepSeekHarness/WorkfilesVoice"

fail() { printf '\\n✗ %s\\n' "$1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "这个插件只支持 macOS。"
[ "$(uname -m)" = "arm64" ] || fail "本包只在 Apple 芯片（arm64）的 Mac 上验证；当前是 $(uname -m)。"
[ -x "$BIN" ] || fail "找不到 DeepSeek Harness：$APP （装在别处时可用 WORKFILES_DSH_APP 指定 .app 路径）"
[ -f native/build-helper.mjs ] || fail "本目录不完整，请重新解压压缩包。"

VERSION="$(/usr/bin/defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '未知')"
printf '使用 DeepSeek Harness %s 自带的运行时构建语音组件…\\n' "$VERSION"
case "$VERSION" in
  0.2.2*) ;;
  *) printf '⚠︎ 本插件在 0.2.2-rc.3 上验证过，当前宿主是 %s，构建可能失败。\\n' "$VERSION" >&2 ;;
esac
printf '输出目录：%s（约 300 MB）\\n\\n' "$OUT"

if ! ELECTRON_RUN_AS_NODE=1 "$BIN" native/build-helper.mjs --output-root "$OUT"; then
  printf '\\n✗ 构建失败。\\n' >&2
  printf '  如果之前用别的目录构建过，先删除旧缓存再试：\\n' >&2
  printf '  rm -rf "%s"\\n' "$OUT" >&2
  exit 1
fi

printf '\\n✓ 语音组件构建完成。\\n'
printf '下一步：DeepSeek Harness → 设置 → 插件 → 添加插件，选择本文件夹；启用后完全退出并重新打开 DSH。\\n'

if [ -t 0 ]; then printf '\\n按回车键关闭这个窗口。'; read -r _; fi
`;

async function copy(rel) {
  const source = path.join(root, rel);
  const target = path.join(staging, rel);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
}

async function brokenSymlinks(dir) {
  const broken = [];
  const walk = async current => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        try { await fs.realpath(full); } catch { broken.push(full); }
      } else if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(dir);
  return broken;
}

async function sha256(file) {
  const hash = createHash('sha256');
  for await (const chunk of (await import('node:fs')).createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

await fs.rm(stagingRoot, { recursive: true, force: true });
await fs.mkdir(staging, { recursive: true });

for (const file of FILES) await copy(file);
for (const dir of DIRECTORIES) await copy(dir);
await fs.writeFile(path.join(staging, 'cordis.patch.yml'), PATCH);

const guide = (await fs.readFile(path.join(root, 'scripts/friend-install.md'), 'utf8'))
  .replaceAll('{{VERSION}}', pkg.version);
await fs.writeFile(path.join(staging, '安装说明.md'), guide);
await fs.writeFile(path.join(staging, '1-构建语音组件.command'), BUILD_COMMAND, { mode: 0o755 });
await fs.chmod(path.join(staging, '1-构建语音组件.command'), 0o755);

// Cheap guards: never ship this machine's folders, the build record, or a
// dangling dependency symlink.
const stagedPatch = await fs.readFile(path.join(staging, 'cordis.patch.yml'), 'utf8');
if (/\/Users\//u.test(stagedPatch)) throw new Error('staged cordis.patch.yml still names an absolute folder');
if (await fs.stat(path.join(staging, '.native')).catch(() => null)) throw new Error('staged tree must not contain .native');
const broken = await brokenSymlinks(path.join(staging, 'node_modules'));
if (broken.length) throw new Error(`broken dependency symlinks: ${broken.slice(0, 5).join(', ')}`);

const syntax = spawnSync('/bin/bash', ['-n', path.join(staging, '1-构建语音组件.command')], { encoding: 'utf8' });
if (syntax.status !== 0) throw new Error(`build script has a syntax error: ${syntax.stderr}`);

// The linked package is imported straight from this directory by DSH, so prove
// that Node resolves every bundled dependency from the staged copy.
const smoke = spawnSync(process.execPath, [
  '--input-type=module',
  '-e',
  "await import('./lib/activity-host.js'); await import('./voice.js'); await import('./index.js'); console.log('imports ok');",
], { cwd: staging, encoding: 'utf8' });
if (smoke.status !== 0) throw new Error(`staged package does not import: ${smoke.stderr || smoke.stdout}`);

await fs.rm(zip, { force: true });
const zipResult = spawnSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', staging, zip], { stdio: 'inherit' });
if (zipResult.status !== 0) throw new Error('ditto failed to archive the staged package');
const stat = await fs.stat(zip);

console.log(`\n✓ ${path.relative(root, zip)}`);
console.log(`  ${(stat.size / 1024 / 1024).toFixed(1)} MB · sha256 ${await sha256(zip)}`);
console.log('  发给朋友后：解压 → 双击 1-构建语音组件.command → 插件页添加该文件夹');
