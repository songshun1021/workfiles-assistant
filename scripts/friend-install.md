# 工作资料助手 · 安装说明

一个 DeepSeek Harness 的 macOS 插件：按下 **⌘⇧Space** 说一句话，它在本机找到你最近看过的资料并直接打开——不用先想起文件名。

本包版本 **{{VERSION}}**，在 **macOS arm64（Apple 芯片）+ DeepSeek Harness 0.2.2-rc.3** 上验证。

## 装之前

- Apple 芯片的 Mac（Intel 不支持）。
- 已经装好 DeepSeek Harness **0.2.2-rc.3**。版本不一致时插件管理器会拒绝安装，不要改版本号硬装。
- DSH 里已经有语音识别能力（实验插件 `@deepseek-ai/dsh-experimental-voice-input-bundle`，提供本机 SenseVoice）。没有的话先在插件页装上它，再装本插件；否则语音那一行不会启动。

## 一、放到固定位置

把解压出来的整个 `workfiles-assistant` 文件夹放到**不会被清理**的位置：

- ✅ `~/Developer/workfiles-assistant`
- ❌ 下载文件夹、桌面、iCloud 同步目录、临时目录

DSH 记录的是这个文件夹的绝对路径。装好之后**不要移动、改名或删除**，否则插件失效；要换位置就重新解压再装一次。

## 二、构建语音小窗组件（每台机器一次）

语音小窗复用本机已安装的 DeepSeek Harness 自带 Electron，所以必须在本机构建。

双击文件夹里的 **`1-构建语音组件.command`**。
如果 macOS 提示“无法打开，因为无法验证开发者”：右键点击 → 打开 → 仍要打开。
如果双击完全没有反应：打开「终端」，输入 `bash `（后面有个空格），把 `1-构建语音组件.command` 拖进终端窗口再按回车。

- 需要 1～2 分钟，复制约 300 MB 到 `~/Library/Caches/DeepSeekHarness/WorkfilesVoice`。
- 不会启动图形界面，也不会打开麦克风。
- 看到 `语音组件构建完成` 就成功了。

命令行等价操作（不想双击时）：

```sh
cd ~/Developer/workfiles-assistant
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  native/build-helper.mjs --output-root "$HOME/Library/Caches/DeepSeekHarness/WorkfilesVoice"
```

## 三、装进 DeepSeek Harness

1. 打开 DeepSeek Harness → 设置 → **插件（Plugins）**。
2. 点 **添加插件（Add plugin）**，选中刚才那个 `workfiles-assistant` 文件夹。
3. 启用「工作资料助手」，然后**完全退出 DSH 再重新打开**（⌘Q，不是只关窗口）。
4. 刷新后左侧栏底部出现「资料助手」入口。

## 四、第一次使用

1. 打开「资料助手」→ **资料文件夹**：添加你希望它查找的文件夹（例如自己的 `~/Desktop`、`~/Documents`）。默认是空的，需要你手动添加；最多 8 个，不接受整个磁盘或整个个人目录。
2. 同一面板里点 **辅助功能**，在系统设置中为 DeepSeek Harness 打开辅助功能。这一步由你本人操作，插件不会自动授权。
3. 想记录软件使用线索：在面板里勾选要记录的应用，再手动开启记录（**默认关闭**）。窗口标题 / 网址是逐应用额外的开关，默认也是关闭的。
4. 第一次语音：按 **⌘⇧Space**，按提示准备本地识别模型（约 239 MB，只需一次），允许麦克风，然后说一句话。

## 常见问题

| 现象 | 原因与处理 |
| --- | --- |
| 添加插件时提示版本不兼容 | DSH 不是 0.2.2-rc.3；换回对应版本，不要改 `engines` 硬装 |
| ⌘⇧Space 没反应、小窗不出现 | 第二步没做或失败了；重跑 `1-构建语音组件.command` 看报错 |
| 构建报“Harness 或桌面语音组件已更新” | DSH 升级过；重新运行 `1-构建语音组件.command` |
| 构建报“构建记录无效” | 之前用别的目录构建过：删掉 `~/Library/Caches/DeepSeekHarness/WorkfilesVoice` 后重试 |
| 只说找到应用，没有文件 | 该应用没有暴露文件信息；先确认面板里已添加资料文件夹 |
| 语音说“打不开” | 没有可用的默认模型或账户额度；先在 DSH 里配置模型 |
| 快捷键冲突 | 面板里换一个快捷键 |

## 数据、隐私与卸载

- 只记录你**勾选**的软件在前台出现过的时间，默认关闭；窗口标题 / HTTPS 地址要逐应用另外同意，默认关闭。
- 不读文档正文、按键、剪贴板、截图，不读浏览器历史；只在按下快捷键时听，识别在本机。
- 本机数据：`~/.dsh/storages/local_workfiles_activity/`、`~/.dsh/storages/local_workfiles_voice.json`、`~/Library/Caches/DeepSeekHarness/WorkfilesVoice`。
- 卸载：插件页移除「工作资料助手」，再删掉上面三个位置（可选）。

更完整的能力与边界见同目录的 `README.md`、`MACOS_CAPABILITIES.md`。
