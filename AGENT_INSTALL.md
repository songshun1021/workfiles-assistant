# Agent 安装手册 · 工作资料助手 0.9.0

> 面向接收方 Agent（Codex / DeepSeek Harness 等）。请**按顺序执行并在每一步后核对输出**；不确定时停下来问人类，不要猜。
> 人类用户请看 `README.md` 的「内测安装」。

## 0. 环境自检（不通过就停止）

```sh
sw_vers -productVersion          # 需要 macOS（本版只在 arm64 验证）
uname -m                         # 期望 arm64
```

- 宿主必须是 **DeepSeek Harness 0.2.2-rc.3**。用 `plugin_manager` 的 `list_bundles` 确认 `@deepseek-ai/dsh-base` 的 version 为 `0.2.2-rc.3`。
  **版本不一致时不要安装、不要改 `engines.dsh`、不要申请版本豁免**，直接告诉人类需要对应版本。
- Node.js ≥ 22（可复用 DSH 自带运行时）。构建语音组件时需要 `/Applications/DeepSeek Harness.app` 存在。

## 1. 选择固定安装目录

插件是**本地链接**安装：DSH 记录的是这个目录的路径。

- 解压到稳定位置，例如 `~/Developer/workfiles-assistant`。
- **不要**放在 `~/Downloads`、`/tmp` 或任何会被清理的目录。安装后**不要移动或删除**该目录，否则插件失效。
- 目录名建议就叫 `workfiles-assistant`（`AGENT_INSTALL.md` 与 `README.md` 都按此假设）。

```sh
mkdir -p ~/Developer
ditto -x -k <压缩包> ~/Developer   # 或用系统解压工具
ls ~/Developer/workfiles-assistant/package.json
```

## 2. 安装（交给 DSH，不要手改 profile）

用 `plugin_manager`：

- `action: install_bundle`
- `target`: 上一步目录的**绝对路径**

它会完成依赖安装与 bundle 选择。**不要**手写 `~/.dsh` 下的 `package.json` / `cordis.patch.yml`，**不要**在 profile 目录里跑 pnpm。

安装后用 `list_bundles` 核对：

- 存在 `@local/deepseek-workfiles`，`version` 为 `0.9.0`，`installed: true`，`enabled: true`
- `rows` 应为两行：`local-workfiles-assistant`、`local-workfiles-voice`
- 结果里不应出现 incompatible-version 错误

## 3. 构建桌面语音组件（每台机器各做一次）

语音小窗复用本机 Electron，必须在**本机**构建；产物在 `~/Library/Caches/DeepSeekHarness/WorkfilesVoice`，不进压缩包。

朋友版压缩包已内置 `node_modules`，不需要 `pnpm install`；直接双击目录里的 `1-构建语音组件.command`，或：

```sh
cd ~/Developer/workfiles-assistant
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  native/build-helper.mjs --output-root "$HOME/Library/Caches/DeepSeekHarness/WorkfilesVoice"
```

从源码目录安装时改用 `pnpm install` 后 `pnpm run build:native`，效果相同。

- 构建会从 `/Applications/DeepSeek Harness.app` 复制约 300 MB Electron 运行时并做 ad-hoc 签名，需要时间与磁盘。
- **不会**启动 GUI、不会打开麦克风。若构建报「宿主版本已改变」，说明宿主不是 0.2.2-rc.3 → 回到第 0 步。
- 构建记录写入项目内 `.native/helper.json`（不入库、不随包分发）。

## 4. 自检

```sh
cd ~/Developer/workfiles-assistant
node --test test/*.test.js      # 期望：tests 624 / pass 624 / fail 0
```

语法自检（可选）：`for f in index.js client.js voice.js lib/*.js native/*.js native/*.mjs native/*.cjs voice-ui/*.js; do node --check "$f" || exit 1; done`

## 5. 启用与验证

1. `plugin_manager` `set_bundle`（`target: @local/deepseek-workfiles`, `enabled: true`），期望 `application: applied`、`warnings: []`。
2. 让人类刷新 Harness 页面；左下角应出现「资料助手」入口。
3. 只读验证（不产生采集）：让 Agent 调用 `workfiles_history`，参数 `{ "detail": "applications", "limit": 1 }`，应返回 `ok: true` 且 `recordingEnabled`、`selectedApplications` 字段存在。

### 5.5 必须修正默认资料文件夹（换机器后必做）

`cordis.patch.yml` 里的默认文件夹是**开发机路径**（`/Users/sean/Desktop` 等），在别的 Mac 上不存在。启用后让人类在面板「资料文件夹」里：

- 移除不存在的那几条（会显示 warning），
- 添加这台机器真实要用的文件夹（例如自己的 `~/Desktop`、`~/Documents`）。

不要为了绕过警告而把根目录设成 `/` 或整个个人目录；本版只接受具体文件夹。

## 6. 必须由人类本人完成（Agent 不要代做）

- 在「资料助手 → 辅助功能」里点按钮打开系统设置，由**人类**手动授权辅助功能；Agent 不要尝试自动授予或绕过 TCC。
- 选择要记录的应用（可用「全选（当前运行的应用）」一键）。**窗口标题/网址同意默认关闭**，是否开启由人类决定。
- 首次录音前由人类处理麦克风权限与本地识别模型准备。

## 7. 禁止事项

- 不修改、不重签 `/Applications/DeepSeek Harness.app`（本插件只读复用其运行时）。
- 不手改 DSH profile 的 `package.json` / `cordis.patch.yml`；不启用版本豁免。
- 不把用户数据外传：账本与语音身份在本机
  - `~/.dsh/storages/local_workfiles_activity/`（7 天活动账本）
  - `~/.dsh/storages/local_workfiles_voice.json`（语音会话指针 + 模型指纹）
- 不替用户打开任意 URL/路径；网页只能按已记录、本会话已查询的 `wa-` ID 打开。

## 8. 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 安装被拒绝，提示版本不匹配 | 宿主不是 0.2.2-rc.3；升级/降级宿主，**不要**改声明 |
| `list_bundles` 里 rows 为空 | 加载前被拦截，通常是版本或依赖问题；看 `warnings` 原文 |
| 语音小窗不出现 | 第 3 步未构建或构建失败；重跑 `pnpm run build:native` |
| 只看到应用名，没有窗口标题 | 该应用没勾「标题/网址」，或应用不暴露 AX 元数据，或未授权辅助功能 |
| 语音说"打不开"或没反应 | 0.5.1 起语音会话会跟随当前默认模型；若仍失败，检查默认模型与账户额度 |
| 切换了模型/API 后语音仍用旧模型 | 已修复：身份记录带模型指纹，指纹不一致会新建语音会话（旧会话保留） |

## 9. 卸载

- `plugin_manager` `remove_bundle`（`target: @local/deepseek-workfiles`）。
- 可选清理本机数据：删除 `~/.dsh/storages/local_workfiles_activity/`、`~/.dsh/storages/local_workfiles_voice.json`、`~/Library/Caches/DeepSeekHarness/WorkfilesVoice`。

## 10. 这个包是什么

详见 `README.md`、`MACOS_CAPABILITIES.md`、`VERIFICATION.md`。一句话：**本地有界活动账本（7 天/1000 条，只记所选应用的前台出现）+ 单独同意的 Accessibility 窗口标题与规范化 HTTPS 地址 + 语音查回与按观察 ID 的受控打开**；不读正文/按键/剪贴板/截图/OCR，不接云端连接器。
