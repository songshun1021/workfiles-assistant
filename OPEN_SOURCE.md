# 开源选择与复用边界

核实日期：2026-11-12；桌面语音升级更新于 2026-11-13。本说明区分**实际依赖／运行时复用**、**宿主已有能力**与**仅做调研的替代项目**，不将它们的代码、许可证、版本或隐私实现混为一谈。

## 0.2 桌面语音升级：当前实际复用

- 目标 DSH **0.2.2-rc.2**。用户已明确要求真正全局唤起与受控小窗，并另外同意将约 286 MB 原生组件生成在本机缓存。没有修改、重签原 App，也没有接受 Xcode 许可或另起 HTTP／DSH 服务。
- 复用安装版 **Electron 44.7.0 / Node 24.21.0 / Chromium 152.0.7977.130 / arm64**。原始 launcher 和四个 framework 复制到插件自有缓存，保留 vendor framework 签名，仅非 deep 签署 owned wrappers／top app。原安装可执行文件／framework SHA 与严格签名验证保持不变；精确步骤见 [原生说明](<./native/README.md>)。
- 复用官方 **0.2.2-rc.2** `@deepseek-ai/dsh-experimental-voice-input-bundle` 的 Host 识别接口。该 bundle 本次已启用，旧的草稿语音 Client 行单独关闭，避免两个不同语义的麦克风入口。真正语音 UI 为隔离／sandbox 的原生组件，最终转写自动进入一个普通、限权 Agent Session。
- 本地 SenseVoice 的模型准备仍由用户明确点击，激活不下载模型、不打开麦克风；无静默云端识别回退。ASR 权重、sherpa-onnx 与 VAD 的许可和来源由官方资源管理保留，不能用上层 bundle 的 MIT 替代。
- Electron 本身 MIT，已保留 [Electron 原文](<./native/LICENSE.Electron>)。其内含 Chromium／其它二进制依赖有各自许可；当前产物仅供这台 Mac 本地运行，不宣称已完成可携带分发的全部 notices/notarization。对外打包前必须从对应安装发行物补齐 notices、确认再分发条款与签名。
- 最终音频仅内存交给默认本地识别；最终文字及按需资料元数据仍依现有 Harness 模型配置进入模型会话。本地 ASR 不等于完全离线 Agent。

下面保留首版调研过程与未采用项目的边界；提到“首版未启用语音”的内容是 0.1 历史，不是当前配置。

## 首版选择

- 采用 Harness Host 的文件系统、受控子进程、工具、人类命令与会话投影机制；只在用户明确选择的资料目录内按需查找。没有后台活动监控、持续截屏、持续录音或全盘索引。
- 使用小型 ZIP/XML 解析依赖读取受限的 Office 文本，不为此安装、编译 Swift/C/C++，也不接受 Xcode 许可。
- “近期”仅指本对话通过助手找到或请求打开的资料；文件修改时间不代表真实打开时间。窗口标题不当作文档的可靠路径。
- 文件名、位置和按需读取的少量正文可能进入既有工具结果与聊天上下文；Harness 会话投影可有本地派生 checkpoint。没有额外常驻采集库或自建活动数据库。清空候选不删除既有聊天记录；本地检索也不代表之后的模型请求完全离线。
- 语音优先考虑宿主原有 bundle，但本插件不启用它、不请求麦克风、不下载模型。启用、资源下载及麦克风使用需要各自明确授权。

## 实际复用的锁定依赖

| 包 | 版本 | 许可证 | 用途／引入关系 |
|---|---|---|---|
| [yauzl](https://github.com/thejoshwolfe/yauzl) | 3.4.0 | MIT | 在内存中按需读取 Office ZIP 条目 |
| [saxes](https://github.com/lddubeau/saxes/tree/v6.0.0) | 6.0.0 | ISC | 解析 Office XML |
| [pend](https://github.com/andrewrk/node-pend) | 1.2.0 | MIT | yauzl 的异步任务辅助依赖 |
| [xmlchars](https://github.com/lddubeau/xmlchars) | 2.2.0 | MIT | saxes 的 XML 字符类依赖 |
| [zod](https://github.com/colinhacks/zod) | 4.4.3 | MIT | 校验会话投影状态 |
| [@deepseek-ai/schemastery](https://github.com/deepseek-ai/deepseek-harness) | 3.19.0 | MIT | Harness 插件配置模式 |
| [@deepseek-ai/cosmokit](https://github.com/deepseek-ai/deepseek-harness) | 1.9.0 | MIT | schemastery 的工具依赖 |
| [@standard-schema/spec](https://github.com/standard-schema/standard-schema) | 1.1.0 | MIT | schemastery 的 Standard Schema 依赖 |

原文版权及许可见[第三方声明](<./THIRD_PARTY_NOTICES.md>)。本次核对了安装依赖的实际许可正文；saxes 的发布包未带独立许可文件，因此其完整声明取自上游固定 v6.0.0 标签，并在第三方声明中单独注明。这里不把 MIT/ISC 理解为可以删除原作者版权或免责声明。

## 核实过但不直接采用的替代项目

### 1. Screenpipe：只借鉴交互与时间线设计

准确仓库为 [screenpipe/screenpipe](https://github.com/screenpipe/screenpipe)，本次固定审查版本为 `68689f8350f59bf414be41d022d9182bde2e1417`。

- 该版本的[许可原文](https://github.com/screenpipe/screenpipe/blob/68689f8350f59bf414be41d022d9182bde2e1417/LICENSE.md)是 **Screenpipe Commercial License／source-available**，不是 MIT 或 OSI 开源许可。商业嵌入和竞争产品等用途需要许可。之前以 MIT 发布的版本仍按其原许可，但不得将旧版本许可套用到当前代码，或将当前隐私实现倒推到旧版本。
- 有本地 REST、SDK、MCP 等可复用接口，但核心是持续工作历史采集，包括屏幕、辅助功能树、音频等；需要的系统权限随所启用采集类型而变。
- 当前说明把原始历史默认本地、产品分析／错误遥测、云 AI、转写、同步及企业储存分为不同数据路径。“本地优先”不是所有配置下都不外传，也不等于默认没有遥测。
- [构建指南](https://github.com/screenpipe/screenpipe/blob/68689f8350f59bf414be41d022d9182bde2e1417/CONTRIBUTING.md)涉及 Rust/Tauri、Bun、FFmpeg/CMake 等及完整 Xcode 初始化，不符合本次无编译与无许可变更约束。

**决定：** 首版不依赖、不分发、不复制其代码；只借鉴清晰时间线、排除规则、范围与保留控制的产品思路。

### 2. ActivityWatch：仅后续用户自愿运行时适配

准确项目为 [ActivityWatch/activitywatch](https://github.com/ActivityWatch/activitywatch) 及 [ActivityWatch/aw-watcher-window](https://github.com/ActivityWatch/aw-watcher-window)。窗口 watcher 的核实版本为 `76b3f6f5804095847470720cbcf96760887d7ac4`，许可为 MPL-2.0；如果将来分发其受覆盖文件或修改，须履行相应源码与声明义务，不把它误写为 MIT。

- 记录应用、窗口标题及时间，而非必须截屏或录音；活动元数据本身仍敏感，不能未经授权采集。macOS 窗口标题需要辅助功能权限，部分脚本／浏览器策略另涉及 Automation。
- 有 [bucket、event、heartbeat、query REST 接口](https://docs.activitywatch.net/en/latest/api/rest.html)。本地服务不应暴露到外网；不同服务器版本的鉴权能力不能混写。
- 核实版本的[说明](https://github.com/ActivityWatch/aw-watcher-window/blob/76b3f6f5804095847470720cbcf96760887d7ac4/README.md)明确：Python privacy filter 不适用于 macOS 默认 Swift helper；配置过滤时该策略拒绝启动，须改用 JXA／AppleScript。不能保证不同策略或旧版本有相同过滤语义。
- [官方隐私说明](https://docs.activitywatch.net/en/latest/privacy.html)区分默认本地记录与 v0.14 起用户主动触发的可选 AI Summary。后者使用用户自备服务凭据，将紧凑活动概览直接发给所选模型服务；不是默认上传，也不是所有功能永不上传。

**决定：** 首版不安装或启动 watcher，只借鉴事件模型。以后若用户已经自愿运行 ActivityWatch，可另行授权有界、只读的历史适配，而非默认导入整段活动。

### 3. get-windows：轻量但不等于文档记忆

核实 [sindresorhus/get-windows v10.0.0](https://github.com/sindresorhus/get-windows/tree/v10.0.0)，MIT，Node ≥22、ESM。

- `activeWindow()`／`openWindows()` 提供 app、title、bounds、id 及支持浏览器的 URL。`owner.path` 是应用 bundle 位置，不是 PPT 文件位置。
- [该版本说明](https://github.com/sindresorhus/get-windows/blob/v10.0.0/readme.md)允许关闭 Accessibility 和 Screen Recording 的权限检查，但相应失去 URL 或标题。要求 Screen Recording 权限不表示组件本身持续保存截图。
- macOS 运行随包可执行文件，没有自带活动历史服务；但安装脚本有原生构建回退，不能把它当作无条件纯 JS 或无工具链安装。

**决定：** 首版不用。未来用户明确请求“一次识别当前应用”时再评估固定预编译产物和最小权限，不后台轮询，也不据窗口标题猜测文档路径。

### 4. whisper.cpp：备用本地语音引擎

准确仓库为 [ggml-org/whisper.cpp](https://github.com/ggml-org/whisper.cpp)，已核对 MIT 许可（包括[固定 v1.7.5 的许可正文](https://github.com/ggml-org/whisper.cpp/blob/v1.7.5/LICENSE)）。

- 提供本地 C API、CLI、HTTP server 等；可以一次录音后离线转写，不必持续打开麦克风，模型下载与音频上传是两种不同数据路径。
- 源码构建需要 C/C++ 工具链与 CMake，另有模型体积、内存和中文质量取舍；实时输入示例还有额外依赖。

**决定：** 首版不另建语音栈、不构建、不下载。只有宿主原有语音能力无法满足质量时，才另行评估合适的预编译推理实现。

### 5. Harness 原有语音：优先复用，但不是本插件自动开启

本机安装版 `@deepseek-ai/dsh-experimental-voice-input-bundle` 为 `0.2.2-rc.1`、包清单 MIT；本次未启用。已通过 Cordis Inspect 确认精确语音接口，而不是猜测 Service 名称。

- 安装版 [SenseVoice 实现说明](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-speech-to-text-sensevoice/README.md>)说明使用 SenseVoiceSmall ONNX、Silero VAD 和预编译 sherpa-onnx，在 Host CPU 推理，不要求用户安装 Python 或编译器；INT8 权重约 239 MB。
- 激活只检查缓存；显式准备才下载固定版本、尺寸和校验值的资源。可配置单一下载来源或已有离线路径。运行时与权重的第三方许可须另行保留，不能只凭 bundle 的 MIT 就推断所有模型资产同一许可。
- `speechController.transcribe` 返回可编辑文字，不自动提交 Agent；指定 provider 的转写不静默回退上传到其他服务。所谓“本地”是 Host 所在机器，不必然是浏览器机器。
- 安装版 [UI 说明](</Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-experimental-client-ui-voice-input/README.md>)明确没有自动发送、常驻麦克风或唤醒词。设备设置页的电平预览也会使用麦克风，所以仅查看该交互不能被当成无权限的静态预览。

**决定：** 日后明确授权后复用既有按次录音／草稿流程，保留键盘输入。不会因启用工作资料助手而顺带开启语音或模型下载。

### 6. 文件检索与 Office 解析：复用底层能力，不另建索引服务

- [官方 MCP filesystem](https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem) 当前核实包版本为 2.3.0，主要按文件名 glob 搜索，不提供 PPTX 正文理解或 Mac 文档打开；可参考 `--read-only --confine-roots`。仓库处于许可迁移，新的 Apache-2.0、遗留 MIT 与文档 CC-BY-4.0 不能笼统混称为“全 MIT”，以[许可原文](https://github.com/modelcontextprotocol/servers/blob/main/LICENSE)及具体文件为准。
- [mcp-everything-search](https://github.com/mamertofabian/mcp-everything-search) 的 MIT 实现说明 Mac 可复用 Spotlight，但原实现的可选全局范围、换行分割与先收完整输出再裁切不满足本次边界。这里只借鉴 OS 索引入口；实际使用受控参数、NUL 分隔、有限输出与逐个候选的规范路径复核，没有复制该包装器。
- [ripgrep-all](https://github.com/phiresky/ripgrep-all) 为 AGPL-3.0-or-later，需要较重的原生转换器和缓存链，默认也没有专用 PPTX 解析适配；不作为这个轻量插件的依赖。
- [officeParser](https://github.com/harshankur/officeParser) 的核实版本 8.7.1 为 MIT，但引入 PDF/OCR 等本次不需要的依赖，且当前 Node 24 分支最低版本高于本机随附的 24.21.0。选择更小的 yauzl+saxes 组合，不擅自升级宿主运行时。

**决定：** 没有核实到可直接安装到当前 Harness、同时满足范围约束、候选纠正、受限 PPTX 正文与系统打开语义的完整插件。因此只实现必要的 Harness 适配层，复用 macOS Spotlight、现有会话/工具/受控进程机制及成熟 ZIP/XML 库；不自建搜索服务器、转写引擎或文档格式解压器。

## 维护约束

替换依赖、加入活动源、开启语音或准备分发时，应重新核对实际版本、许可原文、系统权限、遥测与外传路径。上述调研项目并未随本插件分发，也不是已获得其商标、托管服务或商业使用授权的声明。
