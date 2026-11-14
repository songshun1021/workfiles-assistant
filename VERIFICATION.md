# 资料账本与桌面语音升级验收记录

## 0.5.2 内测分发包：可移植性修正，2026-11-15（Asia/Shanghai）

用户要打包给朋友的 Agent 安装。打包自检时发现**三处只在本机成立**的硬编码，会导致对方机器上构建或自检失败——属于真实缺陷，已修：

| 位置 | 问题 | 处理 |
| --- | --- | --- |
| `native/build-helper.mjs` | 缓存根写死 `/Users/sean/Library/Caches/...`，换用户直接报「未批准的输出目录」 | 改为 `os.homedir()` 派生；批准校验仍要求精确等于该 owned 目录 |
| `test/create_test_presentations.py` | 守卫写死开发机工作区，换目录即拒绝生成夹具 | 改为从 `__file__` 推导项目根，仍要求输出落在本项目内 |
| `test/documents.test.js` | python3 路径写死某个 `dsh-runtimes` 目录 | 改为在 `~/.dsh/dsh-runtimes/*/dependencies/python/bin/python3` 里查找；找不到则 `t.skip` 而不是失败 |
| `test/voice-native.test.js` | 断言写死缓存根 | 同步改为 homedir 派生断言 |

同时新增 [AGENT_INSTALL.md](<./AGENT_INSTALL.md>)：面向接收方 Agent 的十步安装手册（环境自检、固定目录、`install_bundle`、`pnpm run build:native`、`node --test`、启用与只读验证、必须由人类完成的授权、禁止事项、故障排查、卸载），并明确 **cordis.patch.yml 里的默认资料文件夹是开发机路径，换机器必须替换**。

### 打包与自检

- 归档 `workfiles-assistant-0.5.2-beta.1.zip`，**74 个条目**（源码 + 文档 + `AGENT_INSTALL.md` + `BUNDLE.json` + `SHA256SUMS`），332 KB，无 `__MACOSX` 元数据。
- 排除 `node_modules/`、`.native/`（每台机器自建的语音组件记录）、开发期源码备份；上传前扫过密钥特征，无凭据。
- **把压缩包解到 `/tmp/verify2` 再从那里跑全量：624 tests / 624 pass / 0 fail / 0 skipped**，`SHA256SUMS` 逐项校验通过——证明包在「别人的路径」下自洽，不再依赖开发机目录。
- 版本 **0.5.2**；依赖、账本 schema、RPC、原生读取与工具集均未变，仍为 624 项测试。
- 本机 `git` 被未接受的 Xcode 许可挡住，仓库内容通过 GitHub REST git-data API 提交；**用户在此机执行 `git clone/push` 前需先 `sudo xcodebuild -license`**。

---

## 0.5.1 语音会话不再停留在旧模型路由，2026-11-14（Asia/Shanghai）

用户报告“让它打开最近看过的推文没有响应”，怀疑是切换 API 导致。**只读排查日志后确认：与插件、账本、网页打开都无关，是语音专用会话仍在使用旧路由。**

### 日志证据

- 专用语音 Session `workfiles-voice-e1ae4859…` 创建于 **2026-11-13 22:43**，此后每次都是 **resume** 同一个会话。
- 该会话全部请求头为 `provider:"openai", model:"gpt-6.1-sol", reasoningEffort:"max"`（整份日志 35 处 openai、**0 处 deepseek**）。
- 最近三轮（含“帮我打开最近看的推文”）直接返回 `PI_AI_ERROR`：`You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.`，`inputTokens=0`，并重试 5 次——**模型根本没跑，所以既没有工具调用，也没有任何回答**。
- 同一时刻用普通工具调用同一账号可正常打开该推文（`open_requested`），证明采集、账本、`wa-` 候选与打开链路均正常。

### 根因与修复

- 语音会话是长期存在的专用 Session，绑定创建时的模型；用户把默认模型切到 DeepSeek 后，resume 仍走旧的 OpenAI 路由。
- [voice.js](<./voice.js>) 的身份记录新增**不凭据化的** `selection` 指纹（`provider/model@effort`）。启动时若指纹与当前默认选择不一致，或记录来自旧版本没有指纹，则**新建专用会话**而不是复用旧会话；绑定新会话时写回当前指纹。
- 新增回归断言：指纹存在、只有一致才复用、持久化写回、指纹不含 apiKey/token/secret。全量 **624 tests／624 pass／0 fail**，语法检查 exit 0。
- 版本 **0.5.1**。用户在重载插件后下一次按快捷键即会创建新语音会话，使用当前默认模型（DeepSeek）；无需改插件设置或重新授权。

### 边界

- 本次未修改任何 API Key、凭据或模型配置，也未替用户选择模型；只在“默认选择已改变”时让语音会话跟随。
- 如果默认模型仍指向没有额度的路由，语音仍会失败——那是账户额度问题，不是插件问题。

---

## 0.5.0 修复 Accessibility 读取（此前窗口/文档线索实际上从未成功），2026-11-14（Asia/Shanghai）

用户在真实环境反馈“只看得到应用名”。**只读排查后确认这是实现缺陷，不是系统限制**；已在真机验证修复。

### 找到的缺陷

- `native/context-reader.js` 用 `Ref()[0]` 取 `AXUIElementCopyAttributeValue` 的出参。在本机 macOS/JXA 上该出参不是 AXUIElement：后续所有属性读取都返回 **-25201（invalid element）**，导致聚焦窗口、标题、`AXDocument`、`AXURL` 全部拿不到，账本永远只有应用级行。用同一进程对照验证：`$()` 占位符可取到元素（`AXFocusedWindow` 22 ms，`AXTitle` 5 ms）。
- 即使取到标题，也会因为“可选的 WebArea 地址遍历不完整”把整个窗口线索丢弃；一个可选属性不支持就等于整条记录降级。
- 单次 AX 调用 80 ms 对 Electron/Chromium 冷连接过紧。

### 修复

- 对象出参改用 `$()` 占位符，并兼容两种桥接形态（`outValue()`）；标量出参（`AXChildren` 计数）仍用 `Ref()`。
- 只有 **deadline 到期/焦点变化/无法创建窗口** 才丢弃窗口线索；标题一旦从“已复核的聚焦窗口”读到就保留，地址单独缺失不牵连标题。可容忍 `-25205/-25211/-25212`（未实现/属性不支持/无值），`-25204` 等仍视为致命。
- 单次 AX 调用上限 80 ms → **300 ms**（总预算仍 900 ms，遍历预留同步调整）。

### 真机验证（只读探测，不写账本）

- 修复前：`{"app":{"id":"com.deepseek.dsh",...},"reason":"DOCUMENT_NOT_AVAILABLE"}`（无窗口）。
- 修复后：`{"app":{"id":"com.deepseek.dsh",...},"window":{"title":"语音助手核心场景设计 — DeepSeek Harness"}}`。
- 同一进程 `AXIsProcessTrusted()` 为 **true**，说明此前一直是代码问题，而非未授权。
- 全量 **623 tests／623 pass／0 fail，exit 0**；原生 VM 测试同步更新为“可选属性失败保留已验证标题、deadline 到期与焦点变化仍全部丢弃”的新契约。未开麦、未改 profile、未新增连接器。

### 仍未验证

- 浏览器类应用能否给出 `AXURL`/WebArea 仍需用户在 Edge 等应用上实机确认（且该应用需单独勾选“标题/网址”）。
- 本次只读探测未写入账本；端到端“切到已同意应用 → 账本出现窗口行”需用户实际切换焦点后复查。

---

## 0.4.3 区分前台应用与后台代理，2026-11-14（Asia/Shanghai）

- 用户指出候选列表混入大量系统后台代理。原生发现阶段新增 `foreground`（`activationPolicy === 0` 为可成为前台的应用；`1` 为菜单栏/系统代理），经 Host 校验后仅作为标签，不改变任何权限。
- 软件列表**默认隐藏后台代理**，已选中的仍显示；列表内新增「显示后台应用／系统代理」开关，并说明它们不会产生记录。
- 全量 **623 tests／623 pass／0 fail**；无新增采集、无权限变化。

---

## 0.4.2 一键全选当前运行的应用，2026-11-14（Asia/Shanghai）

- 新增 Owner 动作 `select_running_applications`：一次点击 → 显式发现当前运行应用 → 在**最新已保存设置**上原子并入（上限 128）。不传数组、不覆盖其它窗口的撤销、**不开启记录开关、不授予窗口标题/网址同意**。
- 界面新增「全选（当前运行的应用）」按钮与提示文案；`mutate` 的权威确认列表包含该动作。
- 全量 **622 tests／622 pass／0 fail**。

---

## 0.4.1 设置面板收敛为“一句话 + 默认收起”，2026-11-14（Asia/Shanghai）

用户反馈设置弹窗文字过多、要勾选一长列软件却不知道用途。**只改文案与信息层级，不改任何权限、存储或采集行为**；既有选择与同意原样保留。

- 弹窗首屏改为 5 块、每块一句话：最近 7 天（一句用途 + 记录开关）、记录哪些软件（默认只显示“已选 N 个：名单”，点「选择软件」才展开完整列表）、辅助功能（一句状态 + 两个按钮）、最近记录、文件夹、语音快捷键。原长段落统一收进底部的「说明与隐私」，默认折叠。
- 完整应用列表**默认收起**；每行第二个勾选框从「窗口标题和 HTTPS 地址」改为「标题/网址 · 可选」，含义说明仍保留在同一面板的折叠说明中。
- 记录开关旁由两段长解释改为“记录已开：改动马上生效。”／“记录未开：先选软件不会开始记录。”；观察时间的提醒改为“只说明当时在前台，不等于你阅读、编辑或保存过。”
- 版本 **0.4.1**；依赖、engine、账本 schema、RPC、原生读取与 5 个工具均未变。全量 **621 tests／621 pass／0 fail，exit 0**，生产语法检查 exit 0。
- 部署后实际调用 `workfiles_history` 仍返回用户自己配置的 `recordingEnabled=true` 与所选应用（Word、PowerPoint、Finder、飞书、Codex，其中后三者另开了窗口线索同意），未发生任何自动扩大或重置。**用户此前的选择属于用户操作，不由本版产生。**
- 未做已认证页面视觉验收（当前 GUI 仍要求认证，未读取或绕过）：折叠/展开、窄屏与明暗主题需用户刷新后自行确认。

---

## 0.4.0 更广的应用与单独的窗口线索同意，2026-11-14（Asia/Shanghai）

用户要求把原“仅 Office 三款”的选择扩展为更广的 macOS 应用，并尽可能完整地使用辅助功能接口；飞书／腾讯／MCP 连接器明确留到下一版。**未接任何连接器、未采集真实前台／窗口／文档、未申请 AX 权限、未开麦克风、未启动模型试用任务、未改原 App。** 既有记录状态（已开启 + Word/PPT）在部署后原样保留，新增窗口标题／地址同意为 **空**。

### 本版实现

- 应用范围由固定 3 个建议改为**用户显式选择的动态 bundle ID**，最多 128 个；Word／PowerPoint／WPS 降级为建议项，不再是技术白名单。新增显式“刷新运行中的软件”，只列出当前运行、具 GUI 的应用标识／名称，不读窗口、网页、历史，也不等于完整安装清单。
- 新增**独立的窗口元数据同意** `contextApplications`，必须是已选应用的子集，旧数据解码为 `[]`，不经任何路径自动扩大。授权与记录开关、资料文件夹范围、辅助功能系统授权四者互相独立。
- 原生采集在既有托管 `/usr/bin/osascript` 有界进程内扩展：仅当前聚焦窗口；48 节点／深度 5／总 900 ms／单次 AX 调用 80 ms 的角色级读取，只在取得 WebArea 地址时遍历；**从不读取正文、选中文字、控件值、地址栏未提交文字、剪贴板、按键或截图**；焦点／进程重检失败只降级为应用线索。
- HTTPS 地址统一规范化：仅 https、≤2048 字符、去查询参数与片段、拒绝凭据／IP／localhost／`.local`／单标签内网名。标题 ≤512。无法取得就不写，不猜链接。
- 历史新增 `window` 行种类并保留旧 `application`／`document` 行。应用级查询**先投影再过滤／校验**，不会经标题或 URL 泄露主题。窗口同意撤销会把旧窗口行物理降级为应用行，并清理其去重游标。
- 新增 Owner 原子增量动作 `set_application` / `set_context`：只改单个 ID，在串行 mutation 内基于最新设置计算，避免多个界面用过期数组互相恢复刚被撤销的授权；`set_context{allowed:true}` 在应用已撤销时拒绝，不会顺带重新选中。移除最后一个应用在同一次提交内安全暂停记录。
- 新增“按已观察 ID 请求打开保存的网页”：仅接受本次历史查询返回的 `wa-` 候选，Host 重验留存行、当前应用与窗口同意、查找／打开开关后才调用 `/usr/bin/open`；不开放任意 URL、通用浏览器或 shell。文件打开仍走原规范路径／身份复核。
- 界面新增策略门：任何写入先锁，只有权威 `status` 成功后才解锁；失败或缺认时锁定选择／记录开关并保留重试，同时清空已显示的记录行，避免在撤销失败或状态过期时仍呈现旧披露。选择软件只发单项增量，**从不发送 `enabled`**。
- 模型侧仍是固定 5 个工具；`workfiles_open` 现在接受 `wf-` 文件或 `wa-` 网页 ID，但两者都必须是本 Session 已写入的候选。提示词说明不限 Office、不声称覆盖所有应用或网页、窗口线索依赖应用暴露与 AX 授权。

### 回归、构建与部署

- 生产语法检查（`index.js`、`client.js`、`voice.js`、`lib/*.js`、`native/*.js`、`native/*.mjs`、`native/*.cjs`、`voice-ui/*.js`）**exit 0**。
- 全量 **621 tests／621 pass／0 fail／0 cancelled／0 skipped，exit 0**；其中原生来源 **64**、账本／控制器／策略 **191**、Host 集成与网页开链 **55**、客户端纯／静态 **57**，其余为原有文档、语音与清单测试。所有 OS／存储／子进程／AX 均为合成实现或纯 VM JXA，未触真实用户前台。
- 未改动依赖声明，`engines.dsh` 仍为 **0.2.2-rc.3**；包版本升为 **0.4.0**，新增 [macOS 能力评估](<./MACOS_CAPABILITIES.md>) 并加入分发清单。
- 语音小窗未重建：11 个冻结资源（`native/main.mjs`、`preload.cjs`、`protocol.mjs`、`security.mjs`、`controller.mjs`、`LICENSE.Electron`、`voice-ui/*`）本版未改，生产 `loadVoiceHelper` 只读预检返回 **valid**（buildId **48a43990d50e5ff4b67ac23e**，sourceAppVersion 0.2.2-rc.3，Electron 44.7.0，11 项资源哈希一致）。原 App 与 owned 组件 `codesign --verify --strict` 均通过；未启动 GUI、未开麦克风。
- 正常启用已安装的本地 bundle：**`application:applied`、`warnings:[]`**，管理器显示 0.4.0、enabled/installed=true、两行不变。
- 部署后实际调用 `workfiles_history(detail:applications, limit:1)` 成功，返回 **recordingEnabled=true、selectedApplications=[Word, PowerPoint]、contextApplications=[]、entries=[]**，且 `coverage.windowMetadataRequiresSeparateConsent=true`、`coverage.connectorData=false`。`local_workfiles_activity` 的 `global.json` 仍是升级前原样（未持久化新增字段、未扩大同意、未重置、未回补）。

### 未验证与当前试用边界

- 当前 GUI 为 **http://127.0.0.1:59688**，根页仍返回 **HTTP 401 authentication required**；未查找／读取／分享认证 URL、cookie 或令牌，未用其它浏览器空间绕过，也未新建替代服务。因此**已认证页面的真实布局、400px 窄屏、明暗主题、焦点顺序与真实点击未验收**；UI 结论来自生产纯函数／静态测试与独立源码审查，不代表视觉实测通过。
- 未做真实 macOS AX 桥接与具体应用兼容性验证：Safari／Edge／飞书／腾讯文档客户端是否暴露窗口标题或 `AXURL`、面板控件是否位于 48 节点／深度 5 预算内，仍需用户实机确认。取不到时按设计只保留应用线索。
- 未验证物理快捷键注册／触发、原生小窗显示、麦克风、语音识别及端到端模型试用。录音准备、系统麦克风与 AX 权限仍需用户手动操作。

### 试用建议

刷新现有 Harness 页面 → 侧栏底部“资料助手” → 先“刷新运行中的软件”，选中实际要用的几个应用（此时不会开启记录，也不会扩大窗口元数据）→ 需要具体窗口线索的再单独勾选“窗口标题和 HTTPS 地址” → 打开系统辅助功能设置，由用户手动授权并“检查权限” → 最后单独点“开始记录”。之后可问“最近出现过哪些软件”，再问“最近出现过哪些资料／网页”对比两种明细。若状态显示“设置待确认”，点“重新确认设置”解锁，不要在此期间反复勾选。

---

## 0.3.1 适配 DSH 0.2.2-rc.3，2026-11-14（Asia/Shanghai）

用户更新 Harness 后报告“不匹配”；先只读审核，随后由用户明确确认“适配并恢复试用”。**未设版本豁免、未手改 profile、未开启账本或麦克风、未选择软件、未申请权限、未采集真实前台／文档或启动模型试用任务。**

### 定位与最小修复

- 管理器明确报告插件 0.3.0 的 `engines.dsh=0.2.2-rc.2` 与运行时 `0.2.2-rc.3` 不匹配，rows 为空；Host Config 查不到本插件，Client 侧栏也没有本插件 occupant。这是加载前拦截，不能拿旧版入口注册作为新版证据。
- 独立的 `loadVoiceHelper` 只读预检也拒绝旧 925ce31d 构建，提示宿主／组件已更新。虽然 Electron／Node／Chromium 版本号未变，但宿主可执行文件和 framework 哈希均已变化，不能只改版本声明。
- 核对当前安装版 CLI manifest、公开 Session／Typert 契约、Cordis 4.1.0 和实际侧栏插槽；打包升级索引没有 rc.2→rc.3 的专门条目，rc.1 及更早指南不作为本次新增迁移执行。未发现需要本次改业务／UI API 的证据；新版本实机行为仍须分开确认。
- [包声明](<./package.json>) 升为 **0.3.1**、明确支持当前 **0.2.2-rc.3**；[分发测试](<./test/manifest.test.js>) 同步断言，更新 [使用说明](<./README.md>)。不修改 Client、采集器、语音状态机、权限／同意、资料范围或数据 schema，既有 UI/UX 审查保留，未冒称重新做了视觉评审。

### 构建、回归与恢复

- 先保持插件不可加载，使用更新后的原 App 作为只读来源，在已批准的 WorkfilesVoice 缓存内重建 owned helper；新 buildId **48a43990d50e5ff4b67ac23e**，sourceAppVersion **0.2.2-rc.3**，Electron **44.7.0**／Node **24.21.0**／Chromium **152.0.7977.130**，arm64。
- 源可执行文件 SHA-256：`2dfee74f56b13d4798224acf13fbd7120609f766f7fdfad01cdf44cc6c571488`；源 framework SHA-256：`5ae65a511faf48d98707d08937ccd8141e691e5f163b1d50cc9faccbc036cb83`。原 App 未修改／重签，新组件仅 owned ad-hoc 签名；源／副本签名与 Node-mode 校验均通过。
- 11 个冻结资源哈希与上一版一致；重建后又使用生产 `loadVoiceHelper` 验证源／副本／资源哈希，结果 valid。构建和验证都未启动 GUI 或麦克风。版本化旧缓存保留，未清理或覆盖可能在用的旧组件。
- 审核前与修复后均执行全量：**442 tests／442 pass／0 fail／cancelled／skipped，exit 0**。生产语法检查 exit 0。没有新增依赖声明；包管理器确认 lockfile up-to-date。
- 在更新构建后，正常 disable／enable 同一已安装的本地 bundle，最终 **`application:applied`、`warnings:[]`**。管理器核对为 0.3.1、enabled/installed=true、两个插件行恢复、无 incompatible-version 错误，未卸载或改写原配置。
- 实际调用普通 `workfiles_history(view:recent,detail:applications,limit:1)` 成功，仍为 **recordingEnabled=false、selectedApplications=[]、entries/applications/candidates=[]**，未触发原生前台快照。当前 Client Inspect 确认 `local-workfiles-assistant-sidebar` 活跃；Host Config 也恢复本插件条目。

### 当前试用边界

当前 GUI 为 **http://127.0.0.1:65382**。继续使用原有 Ego TaskSpace 11，根页仍显示 authentication required，已 handOff 回用户；未查找、读取或分享认证 URL／cookie／令牌，未新建替代服务或用其它空间绕过。**尚未完成已认证页面点击、原生小窗、真实快捷键注册／触发、AX、麦克风及端到端试用；加载与单测不等于这些实测。**

用户可在原有 Harness 页面刷新，打开侧栏底部“资料助手”，先点“查看语音小窗（不开始录音）”；由用户查看真实准备／快捷键状态。首次识别资源若未准备，须用户明确点击准备，完成后再次触发才可录音。先按文件名／修改时间找资料不要求开启七天账本或授予 AX；账本、软件选择与 AX 留待用户另行决定。不得把未开启前的睡眠期间冒称已记录历史。

---

## 0.3.0 最近 7 天本地线索，2026-11-14

**第一版已实现、构建并在当前 profile 重载。默认仍关闭，所选软件为空；没有为了验收开启记账、读取真实前台 App／文档、申请 AX 或开启麦克风。真实界面点击与系统兼容性仍需人工确认。** 下方 0.2.x 为历史证据，不能代替本版验收。

### 本版实现与边界

- 新增默认关闭、仅限 Word／PowerPoint／WPS 的本地 7 天／1000 条账本，选择软件与开启持续采集分离；只记元数据，不回补过去，不采 Edge、浏览历史、正文、选中文字、按键、剪贴板、截图或音频。权限本身并非只读，由用户手动授予，代码只做受限读取。
- 固定入口是 Harness 侧栏底部“资料助手”；输入框两按钮为备用入口，打开同一个全局设置 overlay，无须 Agent/Session。支持选择、开启／暂停、查看／筛选、确认清空、文件夹／查找独立开关及快捷键设置。没有常驻菜单栏图标或桌面浮标。
- 自动采样不调用模型。查询才产生正常 `workfiles_history` 工具结果；默认应用级结果不含文档名／路径或文件元数据读取；问文档才生成新鲜同会话候选，经原安全打开链路处理。
- 显式语音手势的短时便签在抢焦点前捕获，最多 2 分钟／16 份，实际 Session 绑定；token 不进入转写、IPC/status 或隐藏提示，结束／取消前立即释放。它不替代自动账本。
- 暂停、撤销、清空和卸载有同步代际／取消栅栏；7 天过期清理也覆盖去重游标，暂停期间仍维护，停机后下一次加载先清理。查找暂停与采集暂停独立。按 4 秒采样并不保证完整历史，观察不证明阅读／编辑／保存／打开动作。

### 回归、真实 SDK 与独立复核

最终全量命令：

```sh
node --test test/*.test.js
```

**442 tests，442 pass，0 fail／cancelled／skipped，exit 0**。包括原有文档与安全打开、会话投影、音频、Native／Runtime，以及新增账本、受控 JXA、Controller、Owner RPC、Host 组合、历史／当前查询、元数据检查和 Client 纯逻辑。不是 442 次实机录音／AX／DOM 测试。

- 真实公开 Cordis `Context`／`Service` 验证 scoped invocation 的 owner/interactions gate；真实安装版 TypertRegistry 接受公开 contribution，ASAR Context 与本地 SDK Service 跨副本 scoped owner fixture 通过。Host 组合测试仅用假存储／subprocess／OS adapter，不读 profile 或用户资料。
- 新增 Session 测试发现“结果已返回但便签还没撤销”的清理时序问题，改为在 resolve 前释放，取消和迟到准入均有回归。
- 独立只读 UI/UX reviewer 报告三项跨层缺陷，Root 均修复并新增回归：
  1. [Client](<./client.js>) 主录音始终走 Native toggle，不用缓存 busy 决定 peek；新增可取消／串行／隐藏时不请求的只读状态刷新。[Native controller](<./native/controller.mjs>) peek 保留所有可见 activation，包含正在录音和完成反馈。
  2. 小窗 ready/error/done 但仍 active 时，也视为需要先收起；设置提供“取消任务／收起小窗”，UI 与 Host 的快捷键准入一致。
  3. [采集 Controller](<./lib/activity-controller.js>) 将 SOURCE_UNAVAILABLE 视为失败，保留错误并显示 unavailable，不把它当成离开所选软件重置去重；FOCUS_CHANGED 不入账，不生成当前能力。成功后才恢复健康状态。
- `backgroundCollection:false` 旧字段明确限定为 document-search 子系统，不替代独立账本开关。
- Client 仅导入 React，使用已核对的主题 token；没有 iframe、通用 RPC、原始 Gateway dispatch 或复制开发会话。纯函数和静态契约测试不冒称 React/DOM 实测。

### 最终构建与当前激活

- 最终 owned native buildId：**`925ce31d6789be3a8ed69369`**，Electron **44.7.0**，Node **24.21.0**，Chromium **152.0.7977.130**，arm64。11 个冻结资源哈希、copied-runtime Node-mode、top/launcher/framework strict 签名、原 App 和源 framework 校验均通过，构建 exit 0。
- 新构建位于用户已批准的 WorkfilesVoice 缓存，版本化输出不覆盖运行中组件；原安装 App 未修改、未重签，未接受 Xcode 许可、未下载新 Electron。旧版和中间构建暂留作回退／避免误删在用组件，不把单份约 286 MiB 误称整个缓存大小。
- 管理器本地包已安装，重复 install 返回 already-installed，未移除或重建 profile；随后通过同一 bundle 的 disable/enable 正确重载，最终 **`application: applied`、`warnings: []`**。未设版本豁免，原文件夹范围保持桌面／文稿／下载。
- 最后真实调用 `workfiles_history(view:recent,detail:applications,limit:1)` 成功：entries/applications/candidates 为空、recordingEnabled=false、selectedApplications=[]，coverage 明确 sampledForegroundOnly=true、completeSystemHistory=false。没有原生新快照或配置动作。
- 当前 Client Inspect 确认 sidebar.footer.action 的 `local-workfiles-assistant-sidebar` 及 shell.overlay 的 `local-workfiles-assistant-settings` occupant 活跃，标准 props 包含 useRemoteAccess。**注册活跃不是截图或点击验收。**
- Host Service Inspect 是安装版的生成静态 API catalog，不是任意新业务 Service 的运行时目录；其“no catalogued Service”不能单独判定本插件 RPC 失败。公开 SDK fixture 与实际正常工具结果分别记录，不混作真实浏览器调用。

### 本版未完成的物理／视觉验收

1. 当前 GUI 为 `http://127.0.0.1:65230`。专用 Ego“工作资料助手账本验收”空间打开根页后要求认证，已交给用户处理；未读 cookie/profile/令牌/钥匙串，未绕过认证、未接管其它空间、未开替代服务。
2. 一次不带 advertised revision 的公开 Client artifact GET 得到 404；对已安装模块服务源码的只读核对确认只接受精确已发布 revision URL，因此该请求既不能证明新字节已送达，也不能据此判定插件代码故障。本版不声称完成 served-byte 比对或实际页面执行核验。
3. 需要在**现有 Harness 页面刷新一次**，确认侧栏入口和真实面板的宽窄／浅深主题／焦点与键盘表现；实际 Owner RPC 点击还未通过已认证浏览器验收。
4. Word／PowerPoint／WPS 当前文档路径的真实 AX 兼容性、首次系统显示的授权对象、物理快捷键／抢焦点时序／真实麦克风与端到端执行均未在本版擅自触发。用户可先查看小窗（不录音），再按自身意愿选择软件、开启账本、手动授权与验证。
5. 整个任务并非离线：按需转写／线索／名称／路径／正文片段可能送入当前配置模型；本地清空不撤回已有聊天或模型服务信息。当前委派列表仅开放 OpenAI 路由，未读取或使用用户 DeepSeek API Key，也未冒称以 DeepSeek 跑了子任务。

## 0.2.2 客户端缺陷修复，2026-11-13

用户现场报告无法找到“资料设置”，且点击主按钮报 `cannot get property "remote.commands" without inject`。这是实现缺陷，不是用户没有按说明操作；此前的 219 项测试没有覆盖这条真实客户端链路，不能用通过数否定现场失败。

本次独立只读复核从安装版官方 Client 源码确认并修复：

1. Client Cordis `inject` 补齐 `remote`、`remote.commands`、`uiWorkspace`。包清单的模块依赖不能替代这些 Service 依赖。
2. `commands.execute` 先解包 `RemoteResult` 的 `ok/value/error`，再读取 `CommandExecution.result`；保留远程拒绝原因，取消／会话切换检查仍在使用结果之前。
3. 词典注册交给 `ctx.effect` 清理，并使用新 namespace 避开旧版本无清理词典的残留，避免重挂时重复注册让入口消失。
4. “资料设置”紧随主按钮，改为同样可见的有边框按钮，移除右推间距；两按钮放在 `nowrap` 原子组内、不折字／不收缩，快捷键在组外、可截断／另行。极窄容器仍需实际布局检查，不能声称不会被任何祖先裁切。没有更改录音授权或检索范围。
5. 设置尚未加载与真实空范围分开显示；未读到状态前禁用依赖该状态的暂停操作。

最终 **222/222 tests pass，0 fail／cancelled／skipped，exit 0**；新增的是依赖／清理静态契约、实际生产纯 RemoteResult 解码函数、按钮顺序／未知范围回归，**不是 React／DOM 模拟或浏览器点击验收**。原生 loader 同时再次验证当前安装和冻结资源通过，buildId 仍 `1a75261979d664aed3f987fe`，没有重建／下载／开麦。

管理器重新启用 Core 返回 `application: applied`、`warnings: []`，Native 依赖恢复。独立 reviewer 从同版 client-modules 源码确认 entry 重启会重读本地链接包的最终 browser artifact，无需重装或 dev:web；并对精确公开资源 `/plugins/??@local/deepseek-workfiles/client.js&rev=132ccce921a2` 作无认证 GET：HTTP 200、13900 bytes，与 13818-byte 本地 artifact 加官方 combo/source-map trailer 逐字节匹配，exit 0。本地 SHA256 为 `acda5c9db4c25a7ca7933dc9a29dac196a9ddee36fe11e64b749f7b1be0db081`；服务 SHA256 为 `1020049f8ca66a42a03495b8c7c9ca8d83be02d1d4f19aee879f9e62e1f07145`。没有读浏览器 profile、cookie、认证信息或执行该脚本。

根另对当前 GUI 根页的无认证只读请求得到 HTTP 401 后即停止，没有寻求认证绕过。当前旧页面在插件切换后没有该 Slot occupant；不能仅据此断言缺失原因，需要刷新再复核。**服务新字节已证实，不等于浏览器已执行。** 未取得刷新后的截图、实际按钮点击或 console 证据，因此不声称最终界面已经验收通过。用户应刷新**现有** Harness 页面一次，而不是寻找旧页面里尚未更新的同名设置。

## 0.2.1 初次激活记录，2026-11-13（历史阶段）

目标环境：DSH **0.2.2-rc.2**、当前 `desktop` profile、现有 GUI `http://127.0.0.1:63831`，macOS arm64。**实现、单元回归、签名组件与 Host 激活已完成；首次真实小窗／物理按键／系统麦克风／语音端到端仍待用户在当前 Mac 确认。** 不将这些不同证据混写成全部实机通过。

### 已实测

- 原资料 Host 与桌面语音行经管理器重新启用，均返回 `application: applied`、`warnings: []`。没有版本豁免或手改 profile YAML。
- 官方语音 bundle 已启用，草稿语音 Client 行 `ui-voice-input` 单独关闭，避免两个不同语义的入口。没有准备模型或申请麦克风。
- 当前四个资料工具真实可调用；再次读取 context，三项用户授权范围仍为桌面／文稿／下载、enabled=true、warnings=[]、backgroundCollection=false。没有追加新根或用户资料正文读取。
- 适配期间真实发现 storage domain 名不接受连字符，已按 rc.2 的 `^[a-z][a-z0-9_]*$` 改为 `local_workfiles_voice` 并加入分发测试；重启该插件行后成功激活。
- 所有冻结资源的最终全套 **219 tests，219 pass，0 fail，0 cancelled，0 skipped，exit 0**。包括原文档／权限 59、Native 28、Agent adapter 29、音频 30、Coordinator 31、Runtime 30、纯 UI 显示状态 12。
- 根重新执行了最终语法／测试、`loadVoiceHelper` 对当前源码和当前安装运行时的校验。最终 buildId **`1a75261979d664aed3f987fe`**、11 项受限资源哈希、Electron **44.7.0**，验证命令 exit 0；该命令没有启动 GUI 或麦克风。
- 源码基线已保留，根对 Host 小改、整个 Client 替换、清单／补丁／本地化作了最终差异复核；没有修改原检索算法或放宽资料范围。

### 原生缓存与签名

用户已明确允许使用 `~/Library/Caches/DeepSeekHarness/WorkfilesVoice`。本次生成真正的插件拥有 App，不是网页 overlay 或 mock。

- 最终 owned buildRoot 为上述缓存下 `1a75261979d664aed3f987fe.nosync`；两份私有 locator 均使用 artifactRoot 相对路径，source bundleRoot 仍在工作区。
- 体积约 **299,945,979 bytes（286 MiB）**、278 files、14 个受控内部相对链接。上版大副本已在禁用入口、确认该前缀无进程、核实 owner 和 locator 未引用后回收，最终只留新版。
- copied vendor frameworks 保留原签名；top app 与四个 owned launcher 分别非 deep ad-hoc 签名、strict 验证通过。
- 原 App／四个源 framework strict 验证与原 executable/runtime SHA 保持不变。没有改原 App、去掉安全属性、接受 Xcode 许可或下载另一份 Electron。
- copied executable 的 Node-mode probe 通过：Electron 44.7.0 / Node 24.21.0 / Chromium 152.0.7977.130。**Node-mode 不等于 GUI／音频验收。**

### 回归与体验修复

- Native JSONL／preload sender、来源、当前 UUID／音频格式与尺寸 fail-closed；无通用 IPC、无网络端口。
- 处理不合作 ASR／Agent、晚到取消、二次文档检查预算、准备取消、并发双启动、失败后继续 send、阻塞 stdin shutdown、主进程退出但后代未静默等真实失败回归全部通过。
- 8 秒 armed lease 的 7999/8000/8001ms 及墙钟倒退、准备后不得自动开麦均有纯测试。
- Agent adapter 使用普通 `agents.create/resume`、正常 prompt admission 和 committed 日志；作用域实际限定四个资料工具，含防同名 scoped shadow 的 guard。取消会清 inbox 并补取消迟到准入。
- 一次独立 UX 子代理评审指出的三项反馈问题已修正：次级设置显示实际快捷键／冲突；键盘模式明确停麦、不再显示旧“我在听”；未找到／长结果／阅读交互保留，只有短成功自动收起。新增纯显示测试，不模拟 DOM。
- 原生 UI 颜色使用系统 fallback；主 GUI 入口使用已查询到的主题 token，不声称 Native 自动继承用户手选的 Harness 主题。

### 尚待实机确认

- Client Slot 曾在本轮升级前段确认 `local-workfiles-assistant` 为 active；最终版本切换后当前连接的旧页面尚未重新挂载该入口，**需要刷新现有 GUI 再复核**。不能用之前的同名 Slot 证明最终画面已更新。
- 独立 reviewer 的 Client 查询曾超时；根随后成功读取过 Slot／Theme。没有真实最终截图、按钮点击或控制台无错证据。
- Ego Lite 列表提示可选更新；本轮没有升级、没有恢复／接管其它用户空间，也未为截图读取浏览器认证、profile、钥匙串或另起服务器。
- 第一真实小窗应由安装后的 **资料设置 → 显示语音小窗（不录音）** 打开。该操作走正常人类命令 `show`，固定 capture=false，不是命令行启动另一个演示 App。
- 用户明确点击本地模型准备后才下载资源；完成不自动开麦。之后由用户按快捷键／点击开始并决定系统麦克风权限，验证端点、识别、普通 Agent 自动打开和一句纠正。
- 当前 219 项主要为纯／契约测试，**不是**已测真实声学、跨 App 按键、TCC、系统 TTS 或语音任务实际模型请求的声明。原有文字资料工具的真实受控样例结果保留在下方历史。

---

# 0.1 历史交付记录（非当前语音配置）

日期：2026-11-12，Asia/Shanghai。插件版本：0.1.0；当前 Harness：0.2.2-rc.1。

## 结论

**已安装并激活到当前 DeepSeek Harness profile。** 文件检索、候选纠正、受限 PPTX 正文读取、跨会话隔离与系统打开请求均已通过真实插件调用验证。页面入口已有活动注册；尚未取得浏览器视觉或用户目视确认，不能把注册当成画面验收。

用户真实工作任务的长期成功率尚未测量；下面的 10/10 只针对这组受控样例，不等于产品普遍成功率，也不是用户亲自完成的 10 项真实资料任务。

## 安装与运行状态

- 安装位置：当前 `desktop` profile，本地链接至这个源码目录；修改没有波及其它已安装插件。
- 首次激活遇到 Host SDK 裸导入的模块解析错误。已去掉该裸导入，直接使用公开的原生 ToolDefinition 契约，并复用 Zod 做参数校验和 JSON Schema 投影；没有为一个辅助函数安装第二份 Harness 运行时。
- 修复后，插件管理器禁用／重新启用均返回 `application: applied`、`warnings: []`。
- 新增的四个 workfiles 工具已出现在当前 Agent 的真实工具集中，且已实际调用；不是只检查源代码或模拟工具。
- Host Config 已确认配置 schema 和 volatile 字段；初始范围为用户明确选择的桌面、文稿、下载。
- Client Inspect 已两次确认 `conversation.composer.dock` 中 `local-workfiles-assistant` 为 active；没有替换原有 activity/usage 单元。

## 自动测试

最终执行：语法检查与 Node 内建测试，**59/59 通过，0 失败，退出码 0**。

覆盖：

- 相关性优先、匹配后的修改时间排序、目录缩小与带时区的时间筛选。
- 前缀同名目录、软链接、隐藏目录、包目录、可执行／宏专用扩展名排除。
- 规范路径指向整机、整个个人目录或其祖先时拒绝。
- 候选已改变、替换、删除、撤销范围、暂停、取消与系统索引不可用。
- 当前／上一组候选、用户补充纠正、清空、日志重放、跨会话 ID 隔离。
- 未关联工具／命令结果不能伪造会话状态；派生 checkpoint 剥离正文与未知字段。
- 配置操作跨会话串行，移除范围不会被并发添加操作悄悄恢复；取消不保存迟到设置。
- 原生参数校验、Host 入口独立导入、所有本地分发资源、双语元数据与原创 SVG 的 XML 结构。
- 真实 python-pptx 生成、重新打开校验的两页 PPTX；幻灯片页序与正文读取。
- 合成 Office 对抗样例：坏 ZIP/XML、DTD／外部实体、错误编码、加密、重复条目、越包关系、路径穿越、符号链接条目、压缩比例与声明膨胀、条目／元数据／XML 深度／节点／输入大小上限，以及提前和在途取消。

边界：XML 解析的时间预算为协作式，不是独立 worker 强杀；单次目录列表受宿主文件系统实现影响，不是操作系统级资源配额；并未制造每一种极端耗时场景。普通文件身份复核也不是抵御同权限恶意本地进程换链攻击的原子沙箱。

模型侧固定开销实测为四个工具 schema 共 2,857 个 Unicode 字符，固定指引 431 字符；这是字符计数，不是 tokenizer 精确 token 数。没有每轮注入整段电脑活动历史。

## 独立子会话的真实插件调用

测试只使用明确标注的自建 PPTX 样例，不读取用户真实资料正文。共 14 次 workfiles 调用；只发出 1 次成功的系统打开请求。

| 场景 | 实际结果 |
|---|---|
| 资料范围与初始上下文 | 三个授权范围正确；子会话初始候选为空，没有父会话候选或后台活动历史 |
| 最近更新的课题报告，先不要打开 | 两个相关版本按真实 modifiedAt 排序，没有打开 |
| “不是最新那份，看看旧版内容” | 实际读取了旧版两页正文 |
| “再看第二个” | 沿用同一明确编号列表，正确读取第二个 |
| 文件名不记得，只记得正文“偏振光谱仪” | 名称无结果后按需正文检索，找到组会样例，4 份读取、0 解析失败 |
| 找回之前的新版本 | 有限候选窗口已更新时重新检索，使用新的有效 ID，没有猜路径 |
| 找并打开不存在的报告 | 返回 0 个结果，没有用其他资料顶替打开 |
| 要到授权范围外查找 | 返回 OUTSIDE_SCOPE，没有扩权或换 shell 绕过 |
| 用父会话候选 ID 打开 | 返回 UNKNOWN_CANDIDATE，没有 OS 打开请求 |
| 重新定位最新版本并打开 | 返回 open_requested；documentVisibleConfirmed=false |

本组：10 项通过、0 项失败、0 项需要澄清。最后已清空该子会话测试候选；没有删除原聊天日志。

## 用户要求的再次测试

用户外出返回后要求“重新测试一下”。约 17:20–17:28 再次验证：

1. 授权范围仍为桌面、文稿、下载，enabled=true，无后台采集。
2. 资料助手的 Client 入口仍为 active。
3. 再次检索，按真实修改时间正确返回新／旧两份报告。
4. 很早之前的候选因底层文件版本发生变化返回 STALE_CANDIDATE，没有盲目打开；刷新后新候选可用。
5. 沿用第二个候选实际读取旧版正文，页序、文本与标注正确。
6. 按正文独特线索找到组会样例，正文检查 4 份、0 失败。
7. 从上一组候选中选中刷新后的最新报告，**17:23:50 再次得到系统接受打开请求**。仍不能据此保证文档窗口已经显示。
8. 清空本对话测试候选，避免把验收列表当成用户接下来的真实资料。

## 界面、窗口与语音的验证限制

- 已确认活动 Slot 注册、安装后的双语元数据和原创图标资源；没有拿到实际渲染截图，也没有验证按钮的现场点击效果。
- 初次浏览器验收到达当前 GUI URL 时要求认证；没有查找 token、浏览器 profile 或钥匙串，也没有关闭认证。旧的已结束测试空间随后已不存在，重测不能恢复该空间；没有为绕过限制启动替代网站。
- 浏览器工具另有可选更新提示，未擅自升级。这个提示不被当成上述认证／空间状态问题的已证实原因。
- 系统打开请求共成功两次（初测一次、本次重测一次）；均仅针对同一份明确标注的验收 PPTX。没有检查其他 App 的窗口、没有自动关闭用户已有窗口；测试窗口看完可由用户关闭，无需保存。
- 语音输入 bundle 未启用，未下载识别权重，未申请或使用麦克风；因此不宣称语音实机验收完成。首版自然语言文字链路已可使用。
- 没有用真实用户资料验证长期成功率。建议之后用用户自己的课题、目录和版本命名做正式验收。

## 测试文件与清理

本次仅创建了四份清楚标注的验收 PPTX。重测结束后，把已核对内容的整个自有验收文件夹收纳到工作区的隐藏测试目录，避免它们混入默认日常检索；没有修改或删除用户工作资料。

样例保留于 `../.workfiles-acceptance-20261112`。没有强行关闭默认文档应用，也没有声称测试窗口已经关闭。此前工具结果中的原路径属于既有测试日志；当前候选已清空。

使用方法和功能边界见 [使用说明](<./README.md>)，依赖选择见 [开源说明](<./OPEN_SOURCE.md>)，完整许可见 [第三方声明](<./THIRD_PARTY_NOTICES.md>)。
