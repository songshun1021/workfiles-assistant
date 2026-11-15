window.__ModuleLoader__.load({
  id: '@local/deepseek-workfiles',
  factory(require) {
    // BEGIN_WORKFILES_PURE — boundary and view helpers, tested without a DOM or React renderer.
    const activityPackage = '@local/deepseek-workfiles/activity';
    const applications = Object.freeze([
      Object.freeze({ id: 'com.microsoft.Word', name: 'Microsoft Word' }),
      Object.freeze({ id: 'com.microsoft.Powerpoint', name: 'Microsoft PowerPoint' }),
      Object.freeze({ id: 'com.kingsoft.wpsoffice.mac', name: 'WPS Office' }),
    ]);
    const maxApplications = 128;
    // Exact public Host ApplicationIdSchema; Office entries above are suggestions, not a permission list.
    function isApplicationId(value) { return typeof value === 'string' && value.length <= 255 && /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+(?![\s\S])/u.test(value); }
    function parseApplicationIds(value) {
      if (!Array.isArray(value) || value.length > maxApplications || new Set(value).size !== value.length || [...value].some(id => !isApplicationId(id))) throw new TypeError('Select up to 128 distinct application bundle IDs.');
      return [...value];
    }
    const observedId = /^wa-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
    const actionFields = Object.freeze({
      status: ['refresh'], configure: ['enabled', 'applications', 'contextApplications'], set_application: ['id', 'selected'], set_context: ['id', 'allowed'], discover_applications: [], select_running_applications: [], open_observed: ['id'], list: ['query', 'after', 'before', 'limit'],
      clear: [], open_accessibility: [], folders: [], add_root: ['path'], remove_root: ['path'], set_search_enabled: ['enabled'],
      voice_status: [], voice_show: [], voice_record: [], voice_cancel: [], voice_shortcut: ['shortcut'],
    });
    function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
    function parseActionInput(value) {
      if (!plain(value) || !Object.hasOwn(actionFields, value.action)) throw new TypeError('Invalid document assistant action.');
      const permitted = ['action', ...actionFields[value.action]];
      if (Reflect.ownKeys(value).some(key => typeof key !== 'string' || !permitted.includes(key))) throw new TypeError('Unexpected action field.');
      const result = { action: value.action };
      for (const key of actionFields[value.action]) if (value[key] !== undefined) result[key] = value[key];
      for (const key of ['enabled', 'refresh', 'selected', 'allowed']) if (key in result && typeof result[key] !== 'boolean') throw new TypeError('Expected a boolean.');
      if (result.action === 'set_application' && (!isApplicationId(result.id) || typeof result.selected !== 'boolean') || result.action === 'set_context' && (!isApplicationId(result.id) || typeof result.allowed !== 'boolean')) throw new TypeError('Expected an explicit application permission change.');
      for (const key of ['applications', 'contextApplications']) if (key in result) result[key] = parseApplicationIds(result[key]);
      if (result.applications && result.contextApplications && result.contextApplications.some(id => !result.applications.includes(id))) throw new TypeError('Window metadata requires the app to be selected separately.');
      if (result.action === 'open_observed' && (typeof result.id !== 'string' || result.id.length !== 39 || !observedId.test(result.id))) throw new TypeError('Select a stored observation ID.');
      if ('query' in result && (typeof result.query !== 'string' || result.query.length > 512)) throw new TypeError('The filter is too long.');
      for (const key of ['after', 'before']) if (key in result && (typeof result[key] !== 'string' || result[key].length > 64 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(result[key]) || !Number.isFinite(Date.parse(result[key])))) throw new TypeError('Expected a timestamp with time zone.');
      if ('limit' in result && (!Number.isInteger(result.limit) || result.limit < 1 || result.limit > 20)) throw new TypeError('Invalid record limit.');
      if (['add_root', 'remove_root'].includes(result.action) && (typeof result.path !== 'string' || !result.path.length || result.path.length > 4096 || /[\u0000-\u001f\u007f]/u.test(result.path))) throw new TypeError('Invalid folder.');
      if (result.action === 'set_search_enabled' && typeof result.enabled !== 'boolean') throw new TypeError('Expected a search setting.');
      if (result.action === 'voice_shortcut' && (typeof result.shortcut !== 'string' || result.shortcut.length < 3 || result.shortcut.length > 100 || /[\u0000-\u001f\u007f]/u.test(result.shortcut))) throw new TypeError('Invalid shortcut.');
      return result;
    }
    function updateApplicationSelection(id, selected) {
      // Send only the clicked identity. Another tab's newer revocations cannot be overwritten by stale arrays.
      return parseActionInput({ action: 'set_application', id, selected });
    }
    function updateContextSelection(id, allowed) {
      // The Host checks its latest selected apps atomically. This never reselects an app or enables recording.
      return parseActionInput({ action: 'set_context', id, allowed });
    }
    function copyPolicySettings(value) {
      if (!plain(value) || typeof value.enabled !== 'boolean' || value.retentionDays !== 7 || !Array.isArray(value.applications) || Reflect.ownKeys(value).some(key => !['enabled', 'applications', 'contextApplications', 'retentionDays'].includes(key))) throw new TypeError('Invalid authoritative activity settings.');
      const parsed = parseActionInput({ action: 'configure', enabled: value.enabled, applications: value.applications, contextApplications: value.contextApplications === undefined ? [] : value.contextApplications });
      return { enabled: parsed.enabled, applications: parsed.applications, contextApplications: parsed.contextApplications, retentionDays: 7 };
    }
    function initialPolicyState() { return { status: null, stale: true, error: '' }; }
    function reducePolicyState(current, event) {
      if (event.type === 'status') {
        const value = event.value;
        if (!plain(value) || !plain(value.ledger) || !plain(value.documents) || typeof value.documents.enabled !== 'boolean') throw new TypeError('Invalid authoritative activity status.');
        const settings = copyPolicySettings(value.ledger.settings);
        return { status: { ...value, ledger: { ...value.ledger, settings } }, stale: false, error: '' };
      }
      if (event.type === 'writing') return { ...current, stale: true };
      if (event.type === 'ack') {
        // A successful settings acknowledgment replaces the displayed policy BEFORE any follow-up status/list read.
        // It does not unlock writes: only a successful authoritative status can do that.
        const settings = copyPolicySettings(event.value?.settings), status = current.status || {};
        return { ...current, status: { ...status, ledger: { ...status.ledger, settings } }, stale: true };
      }
      if (event.type === 'failed') return { ...current, stale: true, error: String(event.error?.message || event.error || 'Activity settings could not be confirmed.').slice(0, 1000) };
      throw new TypeError('Invalid policy view transition.');
    }
    function canWritePolicy(policy, canAct, busy = false) { return canAct === true && !busy && policy?.stale === false && !!policy.status?.ledger?.settings; }
    function mergeApplicationCatalog({ selected = [], capabilities = [], discovered = [], retained = [], entries = [] } = {}) {
      const list = value => Array.isArray(value) ? value : [], saved = [...new Set(list(selected).filter(isApplicationId))].slice(0, maxApplications), catalog = new Map();
      const add = (app, facts = false) => {
        if (!plain(app) || !isApplicationId(app.id)) return;
        const current = catalog.get(app.id) || { id: app.id, name: app.id };
        const name = typeof app.name === 'string' ? app.name.replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu, '').trim().slice(0, 256).replace(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/gu, '').trim() : '';
        catalog.set(app.id, { ...current, ...(name ? { name } : {}), ...(facts && typeof app.installed === 'boolean' ? { installed: app.installed } : {}), ...(facts && typeof app.running === 'boolean' ? { running: app.running } : {}), ...(facts && typeof app.foreground === 'boolean' ? { foreground: app.foreground } : {}) });
      };
      for (const id of saved) add({ id });
      for (const app of applications) add(app);
      for (const app of list(retained)) add(app);
      for (const entry of list(entries)) add(entry?.app);
      for (const app of list(capabilities)) add(app, true);
      for (const app of list(discovered)) add(app, true);
      const sorted = [...catalog.values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      // Reserve every saved identity before filling the bounded list; discovery cannot evict a saved app.
      const keep = new Set(saved);
      for (const app of sorted) if (keep.size < maxApplications) keep.add(app.id);
      return { applications: sorted.filter(app => keep.has(app.id)), truncated: catalog.size > keep.size };
    }
    function filterApplicationCatalog(catalog, query) {
      const text = typeof query === 'string' ? query.trim().toLocaleLowerCase() : '';
      return catalog.filter(app => !text || `${app.name}\n${app.id}`.toLocaleLowerCase().includes(text));
    }
    /** Only apps that can actually become frontmost give useful context. Background
     * agents stay selectable, but are hidden by default unless already selected. */
    function applicationRows(catalog, { selected = [], query = '', showBackground = false } = {}) {
      const chosen = new Set(selected);
      return filterApplicationCatalog(catalog, query).filter(app => showBackground || app.foreground !== false || chosen.has(app.id));
    }
    function observedOpenAction(entry, { canAct = false, busy = false, searchEnabled = false } = {}) {
      const url = entry?.window?.url;
      if (!canAct || busy || searchEnabled !== true || entry?.kind !== 'window' || typeof entry.id !== 'string' || entry.id.length !== 39 || !observedId.test(entry.id) || typeof url !== 'string' || !/^https:\/\//u.test(url) || url.length > 2048 || /[\u0000-\u0020\u007f-\u009f]/u.test(url)) return null;
      // No URL is sent or followed by the Client. The Host revalidates its stored sanitized HTTPS address.
      return parseActionInput({ action: 'open_observed', id: entry.id });
    }
    function parseActivityResult(value) {
      if (!plain(value) || value.ok !== true || !Object.hasOwn(value, 'data') || Reflect.ownKeys(value).some(key => key !== 'ok' && key !== 'data')) throw new TypeError('Invalid document assistant response.');
      const seen = new Set(); let nodes = 0;
      function json(item, depth) {
        if (++nodes > 30000 || depth > 32) throw new TypeError('The response is too complex.');
        if (item === null || typeof item === 'boolean' || typeof item === 'string' || typeof item === 'number' && Number.isFinite(item)) return;
        if ((!Array.isArray(item) && !plain(item)) || seen.has(item)) throw new TypeError('Expected bounded JSON data.');
        seen.add(item);
        if (Array.isArray(item)) {
          for (let i = 0; i < item.length; i++) { if (!Object.hasOwn(item, i)) throw new TypeError('Sparse JSON array.'); json(item[i], depth + 1); }
          if (Reflect.ownKeys(item).some(key => key !== 'length' && (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/u.test(key) || Number(key) >= item.length))) throw new TypeError('Unexpected array field.');
        } else for (const key of Reflect.ownKeys(item)) { if (typeof key !== 'string') throw new TypeError('Non-JSON key.'); json(item[key], depth + 1); }
        seen.delete(item);
      }
      json(value.data, 0);
      if (JSON.stringify(value).length > 262144) throw new TypeError('The response exceeds the UI budget.');
      return value;
    }
    function makeActivityContribution() {
      const codec = (name, parse) => ({ mode: 'strict', typeSymbol: `${activityPackage}#${name}`, create: () => ({ parse }) });
      return { package: activityPackage, descriptors: [{
        id: `${activityPackage}#workfilesActivity/action`, service: 'workfilesActivity', namespace: 'workfilesActivity', method: 'action',
        invocation: { kind: 'direct' }, parameters: [{ name: 'input', wire: 'input', source: 'json', codec: codec('ActivityAction', parseActionInput) }],
        cancellation: { parameter: 'signal' }, result: codec('ActivityResult', parseActivityResult),
      }] };
    }
    function decodeActivityResponse(response, fallback) {
      if (response?.ok !== true) throw new Error(response?.error?.message || response?.error?.code || fallback);
      return parseActivityResult(response.value).data;
    }
    function shortcutLabel(value, platform = 'darwin') {
      if (typeof value !== 'string' || !value.length || value.length > 100) return platform === 'darwin' ? '⌘⇧Space' : 'Ctrl⇧Space';
      return value.replace(/CommandOrControl|CmdOrCtrl/g, platform === 'darwin' ? '⌘' : 'Ctrl').replace(/Command|Cmd/g, '⌘').replace(/Control|Ctrl/g, 'Ctrl').replace(/Shift/g, '⇧').replace(/Alt|Option/g, '⌥').replace(/\+/g, '');
    }
    function voiceBusy(voice) { return voice?.active?.busy === true || ['checking', 'preparing', 'transcribing', 'working', 'cancelling'].includes(voice?.phase); }
    function voiceInProgress(voice) { return voice?.active != null || voiceBusy(voice) || voice?.microphoneActive === true || ['listening', 'question'].includes(voice?.phase); }
    // Passive status only; no native context sampling, model turn or hidden audio.
    // Owned by its mounted view, serial (never overlaps), and abortable on close.
    function watchVoiceStatus(read, receive, { signal, visible = () => true, setTimer = setTimeout, clearTimer = clearTimeout, delay = 1500 } = {}) {
      const owner = new AbortController(), work = AbortSignal.any([owner.signal, ...(signal ? [signal] : [])]);
      let timer, closed = false;
      const stop = () => {
        if (closed) return; closed = true;
        if (timer !== undefined) clearTimer(timer); timer = undefined;
        owner.abort(); signal?.removeEventListener('abort', stop);
      };
      async function tick() {
        if (work.aborted) return;
        try { const value = visible() ? await read(work) : null; if (!work.aborted) receive(value); }
        catch { if (!work.aborted) receive(null); }
        if (!work.aborted) timer = setTimer(() => { timer = undefined; void tick(); }, delay);
      }
      if (signal?.aborted) stop();
      else { signal?.addEventListener('abort', stop, { once: true }); void tick(); }
      return stop;
    }
    function focusIndex(index, count, shift) { if (count < 1) return -1; if (index < 0) return shift ? count - 1 : 0; return (index + (shift ? -1 : 1) + count) % count; }
    function formatObserved(value, fallback) { const time = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(time) ? new Intl.DateTimeFormat(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(time)) : fallback; }
    function createViewStore() {
      let state = Object.freeze({ open: false, trigger: null, voice: null }), disposed = false;
      const listeners = new Set();
      const update = next => { if (!disposed) { state = Object.freeze({ ...state, ...next }); for (const listener of [...listeners]) listener(); } };
      return { getSnapshot: () => state, subscribe(listener) { if (disposed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
        open: trigger => update({ open: true, trigger: trigger || null }), close: () => update({ open: false }), voice: voice => update({ voice: voice || null }),
        dispose() { disposed = true; listeners.clear(); state = Object.freeze({ open: false, trigger: null, voice: null }); } };
    }
    // END_WORKFILES_PURE
    const React = require('react');
    const h = React.createElement;
    const namespace = 'local-workfiles-v0-3-0';
    const dictionaries = {
      zh: {
        assistant: '资料助手', voice: '语音找资料', settings: '资料设置', close: '关闭资料助手', defaultShortcut: '默认 ⌘⇧Space',
        intro: '按一次快捷键，说出要找的资料。',
        ledger: '最近 7 天', details: '说明与隐私',
        showBackground: '显示后台应用／系统代理（它们不会成为前台，勾选也不产生记录）',
        selectAllRunning: '全选（当前运行的应用）', selectAllRunningHelp: '一次选中此刻正在运行的应用；不会开启窗口标题/网址记录，也不会开启记录开关。',
        selectedAllNotice: '已把当前运行的应用加入记录范围。',
        ledgerShort: '记住你最近用过的软件和资料，方便说“刚才那份”。',
        appsShort: '只记你勾选的软件：它在什么时候出现过，不记内容。',
        addApps: '选择软件', hideApps: '收起软件列表', noAppsSelected: '还没选软件。点“选择软件”挑几个常用的即可。',
        contextShort: '列表里第二个勾选框可额外记窗口标题和网址（更敏感，默认不记）。',
        selectionLiveShort: '记录已开：改动马上生效。', selectionPausedShort: '记录未开：先选软件不会开始记录。',
        axShortGranted: '已允许辅助功能。', axShortMissing: '要看具体文档或窗口，需你在系统设置里授权辅助功能。',
        scopeShort: '能查找和打开的资料文件夹（与上面的记录无关）。', observedShort: '“出现时间”只说明当时在前台，不等于你阅读、编辑或保存过。',
        ledgerHelp: '记住你最近在所选软件中看到的资料线索，方便以后说“刚才那份”。首次默认关闭；升级保留你原来的记录开关和软件选择，不会自动增加窗口元数据同意。',
        apps: '允许读取线索的软件', appsHelp: '软件选择和记录开关分开保存，仅所选软件可能提供线索。取消某个软件也会撤销它的窗口元数据同意；取消全部会暂停记录，不会自动改选其它软件。',
        selectionLive: '自动记录目前已开启：更改软件选择或窗口元数据同意会立即影响之后的采集。想先挑选再开始，请先暂停记录。',
        selectionPaused: '自动记录未开启／已暂停：选择软件或窗口元数据不会开启记录；此时只有你主动唤起语音，才可能按这些许可按需取得当前线索。',
        policyStale: '设置尚未确认，已暂时锁定修改，避免覆盖另一个窗口刚做的撤销。请点“重新确认设置”。',
        policyStaleShort: '设置待确认', policyRetry: '重新确认设置',
        refreshApps: '刷新运行中的软件', discoverHelp: '先打开想使用的软件，再点“刷新运行中的软件”。Word、PowerPoint 和 WPS 只是建议，不是软件范围上限；发现不代表一定能取得窗口线索。只在你点此按钮时发现软件，不调用模型。',
        discoveryPending: '未刷新', discoveryDone: '已刷新',
        catalogLimit: '最多显示 128 个软件，优先保留已选软件。列表可能不完整；未显示的软件不会被自动选择。', appLimit: '最多可选择 128 个软件。',
        filterApps: '筛选软件', appFilterPlaceholder: '按软件名或 bundle ID 筛选', noAppsMatch: '没有符合筛选的软件；筛选不会改变已保存的选择。', selectedApps: '已选软件',
        contextApp: '窗口标题和 HTTPS 地址', contextShortLabel: '标题/网址', sep: '、', contextSelectFirst: '先勾选这个软件', contextOptional: '可选',
        contextHelp: '这项额外同意首次使用和旧版升级时默认不勾选，之后保留你的明确选择，不随软件选择或记录开关自动加入。所选软件仍可能提供授权文件夹内的本地文件线索；只有另勾此项才允许额外读取当前窗口标题和 HTTPS 地址。',
        contextPrivacy: '窗口标题和地址可能包含私人信息；需要你手动授予 macOS 辅助功能权限，不会自动弹出或授权。是否能取得线索取决于软件；不会读窗口正文，也不会推断缺失的地址。地址会移除查询参数和 # 片段，可能因此不完整。',
        installed: '已安装', notInstalled: '未安装', installUnknown: '安装状态未知', runningRefreshed: '运行中（上次发现时）', selectApp: '请先选择至少一个软件。',
        startLedger: '开启自动记录', pauseLedger: '暂停记录', paused: '未开启／已暂停', recording: '正在记录所选软件的允许线索', recordingApps: '正在记录应用名，更多线索尚需权限或同意', unavailable: '读取组件暂不可用',
        noRecords: '目前没有符合条件的记录。开启后切换到允许的软件，才会产生线索；不会补采过去的活动。',
        retention: '本机滚动保留 7 天，最多 1000 条，达到任一上限会清理较早记录；只记录线索，不复制资料正文。',
        observed: '出现时间', observedHelp: '这里的时间是“观察到它在前台出现”的时间，不等于打开、阅读、编辑或保存时间，也不是文件修改时间。',
        recent: '最近记录', recentHelp: '最多 20 条，只保留 7 天。',
        filter: '筛选记录', queryPlaceholder: '按软件名、文档名或窗口线索筛选', applyFilter: '筛选', refresh: '刷新', loading: '处理中…', recordsPending: '记录尚未加载，请刷新重试。',
        applicationOnly: '仅应用线索，未确认具体文档', windowOnly: '窗口线索（未取得标题）', windowClue: '前台窗口线索', document: '文档', software: '软件', unknownTime: '时间不可用', count: '本机记录数', lastObserved: '最近一次线索',
        openObserved: '请求打开保存的地址', noObservedUrl: '没有保存的 HTTPS 地址；不会从标题重建或猜测。',
        observedUrlHelp: '标题和地址仅代表一次前台观察，不证明编辑、阅读或保存。打开仅请求系统处理账本中保存的 HTTPS 地址；不保证恢复原窗口或完成登录，删去参数后也可能无法直达原页。',
        openRequested: '已请求系统打开保存的地址；这不代表目标窗口已打开或已登录。', openSearchPaused: '资料查找／打开已暂停；恢复后才可请求打开已保存的地址。',
        clear: '清空本地线索', clearTitle: '清空这个账本？', clearHelp: '这会删除本地已存的应用、文档、窗口线索和当前便签，不删除原文件、对话或模型服务中的已有内容；不会关闭自动记录，之后的新线索仍会记录。',
        clearConfirm: '确认清空', cancel: '取消', cleared: '本地线索已清空；不会立刻把同一条当前线索重新补回。',
        forgetRecord: '删除这条', forgetRecordHelp: '只删除这一条本地线索；原文件、对话与其他线索不受影响。', recordForgotten: '已删除这条本地线索。',
        accessibility: '只读线索与辅助功能权限', permissionUnavailable: '读取组件暂不可用，尚不能检查辅助功能权限；没有把未知状态当作已经授权。', axMissing: '尚未允许辅助功能：仍可记录所选应用名。范围内本地文件和另行同意的窗口线索需你手动授权；勾选软件不会弹出或授予系统权限。',
        axGranted: '辅助功能已允许。所选软件可提供范围内已确认的本地文件线索；额外窗口标题和 HTTPS 地址仍只限另行勾选同意的软件。',
        axBoundary: 'macOS 的辅助功能授权本身较宽，并不是只读系统权限；本助手只做受限读取，不会借此打字、改文档或控制其它应用。打开设置不等于已授权，也不会自动开启账本。',
        openAccessibility: '打开辅助功能设置', checkPermission: '检查权限', scope: '允许查找的文件夹',
        scopeHelp: '文件查找、按需少量正文和本地文件打开仅限这些文件夹；账本只保留范围内已确认的本地文档路径。另行同意的窗口标题和 HTTPS 地址不以文件夹为范围。',
        choose: '添加文件夹', remove: '移除', noScope: '尚未选择资料文件夹。', pauseSearch: '暂停资料查找', resumeSearch: '恢复资料查找', searchPaused: '资料查找已暂停',
        independentPause: '“暂停资料查找”也会暂停打开保存的地址，但不会停止记录应用／已同意的窗口线索；如需停止新增账本线索，请单独使用上方“暂停记录”。',
        voiceHeading: '语音与全局快捷键', voiceRegistered: '系统快捷键已注册；空闲不监听。', voiceConflict: '系统快捷键未注册，可能已被占用；仍可使用语音按钮。',
        voiceUnavailable: '桌面语音入口暂不可用；原有聊天资料查找仍可使用。', showVoice: '查看语音小窗（不开始录音）', showTask: '查看当前任务',
        stopSubmit: '结束录音并查找', shortcut: '全局快捷键', shortcutDefault: '⌘⇧空格（默认）', shortcutAlt: '⌘⌥空格', shortcutK: '⌘⇧K', shortcutCustom: '其他组合…',
        shortcutFormat: '自定义组合，如 CommandOrControl+Shift+Space', saveShortcut: '保存快捷键', shortcutBusy: '请先取消任务／收起语音小窗，再更换快捷键。',
        shortcutHelp: '录音时再按一次是结束并提交；处理中再按只查看状态。要停止任务，请使用单独的取消按钮。',
        cancelBoundary: '取消只停止后续动作；系统已接受的打开请求不能可靠撤回，不会替你关闭已打开的文件。',
        voiceRequested: '已请求语音入口；请在语音小窗查看实际状态。', voiceCancel: '取消任务／收起小窗',
        runtime: 'Harness 需在后台运行；完全退出后快捷键不响应。不会自行开机启动，也没有常驻菜单栏图标或桌面浮标。',
        privacy: '只读取显式选择的软件线索，不读浏览器完整历史、网页／窗口正文或 Codex 历史，不录屏、不记按键、不读剪贴板，空闲不录音；不接入飞书／腾讯等服务 API。当前资料便签只是短暂辅助，不替代 7 天账本。',
        modelPrivacy: '线索收集和账本存储在本机；当你发起任务时，最终转写、相关软件名、文件名、位置、窗口标题、保存的地址和按需读取的少量文件正文可能进入正常模型对话。不是全部离线，也不是清空后完全无痕。',
        failed: '这次操作未能完成。', connection: '暂时无法连接资料助手，请刷新 Harness 页面后重试。', noAccess: '当前连接没有操作权限；不会修改设置或启动语音。',
        settingsPending: '设置尚未加载，请刷新重试。', saving: '正在保存／刷新…',
      },
      en: {
        assistant: 'Document assistant', voice: 'Find by voice', settings: 'Document settings', close: 'Close document assistant', defaultShortcut: 'Default ⌘⇧Space',
        intro: 'Press once, then say which document you need.',
        ledger: 'Last 7 days', details: 'Details and privacy',
        showBackground: 'Show background apps and system agents (they never come to the front, so selecting them records nothing)',
        selectAllRunning: 'Select all running apps', selectAllRunningHelp: 'Selects every app running right now. It does not start recording and does not grant window titles/URLs.',
        selectedAllNotice: 'Running apps were added to the recorded scope.',
        ledgerShort: 'Remembers which apps and files you just used, so you can say “that one from earlier”.',
        appsShort: 'Only the apps you tick are remembered — when they appeared, never their content.',
        addApps: 'Choose apps', hideApps: 'Hide app list', noAppsSelected: 'No apps yet. Choose a few you actually use.',
        contextShort: 'The second checkbox can also record the window title and web address (more sensitive, off by default).',
        selectionLiveShort: 'Recording is on: changes apply immediately.', selectionPausedShort: 'Recording is off: choosing apps does not start it.',
        axShortGranted: 'Accessibility is allowed.', axShortMissing: 'To see the actual document or window, allow Accessibility in System Settings.',
        scopeShort: 'Folders that can be searched and opened (separate from recording).', observedShort: '“Observed at” only means it was in front; it does not mean you read, edited or saved it.',
        ledgerHelp: 'Remember clues from selected apps, so you can refer to “that document from earlier”. Off on first use. Upgrades preserve your recording switch and app selections, without adding window metadata consent.',
        apps: 'Apps allowed to provide clues', appsHelp: 'App choices and the recording switch are saved separately. Only selected apps can provide clues. Removing an app also revokes its window metadata consent. Removing every app pauses recording; no other app is selected automatically.',
        selectionLive: 'Automatic recording is already on: app and window metadata choices affect future collection immediately. Pause recording first if you want to choose before collecting.',
        selectionPaused: 'Automatic recording is off / paused: choosing apps or window metadata does not enable it. In this state, current clues may be read under these permissions only after your explicit voice invocation.',
        policyStale: 'Settings are not confirmed yet, so changes are locked to avoid overwriting a revocation made in another view. Choose “Reconfirm settings”.',
        policyStaleShort: 'Settings unconfirmed', policyRetry: 'Reconfirm settings',
        refreshApps: 'Refresh running apps', discoverHelp: 'Open the app you want, then click “Refresh running apps”. Word, PowerPoint and WPS are suggestions, not the limit. Discovery does not guarantee window clues. It runs only on this click, without a model call.',
        discoveryPending: 'not refreshed', discoveryDone: 'refreshed',
        catalogLimit: 'Up to 128 apps are shown, keeping selected apps first. The list may be incomplete; hidden apps are never automatically selected.', appLimit: 'Select up to 128 apps.',
        filterApps: 'Filter apps', appFilterPlaceholder: 'Filter by app name or bundle ID', noAppsMatch: 'No matching apps. Filtering does not change saved choices.', selectedApps: 'Selected apps',
        contextApp: 'Window title and HTTPS address', contextShortLabel: 'Title/URL', sep: ', ', contextSelectFirst: 'Select the app first', contextOptional: 'optional',
        contextHelp: 'This additional consent starts unchecked on first use and legacy upgrades, then preserves your explicit choices. App selection and the recording switch never add it. Selected apps may still provide local file clues within allowed folders; only this separate checkbox permits additional current-window titles and HTTPS addresses.',
        contextPrivacy: 'Titles and addresses may contain private information. macOS Accessibility must be granted manually; choosing apps does not prompt or grant it. Availability depends on the app. No window body is read and missing addresses are never guessed. Query parameters and # fragments are removed, which can make an address incomplete.',
        installed: 'Installed', notInstalled: 'Not installed', installUnknown: 'Installation unknown', runningRefreshed: 'Running at last discovery', selectApp: 'Select at least one app first.',
        startLedger: 'Enable automatic recording', pauseLedger: 'Pause recording', paused: 'Off / paused', recording: 'Recording permitted clues from selected apps', recordingApps: 'Recording app names; more clues need permission or consent', unavailable: 'Reader temporarily unavailable',
        noRecords: 'No matching records yet. After enabling, switch to an allowed app to create clues. Earlier activity is not backfilled.',
        retention: 'Kept locally for up to 7 days or 1,000 records, whichever limit comes first. Only clues are saved, not document contents.',
        observed: 'Observed at', observedHelp: 'This is when an item was observed in the foreground. It does not prove opening, reading, editing or saving, and is not the file modification time.',
        recent: 'Recent records', recentHelp: 'Up to 20 items, kept for 7 days.',
        filter: 'Filter records', queryPlaceholder: 'Filter by app, document or window clue', applyFilter: 'Filter', refresh: 'Refresh', loading: 'Working…', recordsPending: 'Records have not loaded. Refresh to retry.',
        applicationOnly: 'App clue only; no document confirmed', windowOnly: 'Window clue (no title available)', windowClue: 'Foreground window clue', document: 'Document', software: 'App', unknownTime: 'Time unavailable', count: 'Local records', lastObserved: 'Latest clue',
        openObserved: 'Request opening saved address', noObservedUrl: 'No saved HTTPS address. It will not be reconstructed or guessed from the title.',
        observedUrlHelp: 'Titles and addresses are foreground observations, not proof of editing, reading or saving. Opening only asks the OS to handle the saved HTTPS address; it does not guarantee the original window or a logged-in page, and stripped parameters may prevent a direct return.',
        openRequested: 'The OS was asked to open the saved address. This does not confirm an opened window or a signed-in page.', openSearchPaused: 'Document search / opening is paused. Resume it before requesting a saved address.',
        clear: 'Clear local clues', clearTitle: 'Clear this ledger?', clearHelp: 'Deletes saved local app, document and window clues and current cues, not original files, conversations or data already sent to a model service. Recording is not disabled; future new clues can still be recorded.', clearConfirm: 'Clear ledger', cancel: 'Cancel', cleared: 'Local clues cleared. The same current item will not immediately be backfilled.',
        forgetRecord: 'Delete this clue', forgetRecordHelp: 'Deletes only this local clue. Original files, conversations and other clues are untouched.', recordForgotten: 'That local clue was deleted.',
        accessibility: 'Read-only clues and Accessibility', permissionUnavailable: 'The reader is unavailable, so Accessibility permission could not be checked. Unknown is not treated as granted.', axMissing: 'Accessibility is not allowed. Selected app names can still be recorded. In-scope local files and separately consented window clues need your manual grant; selecting apps neither prompts nor grants it.',
        axGranted: 'Accessibility is allowed. Selected apps may provide confirmed local file clues in allowed folders. Additional window titles and HTTPS addresses still require separate app consent.',
        axBoundary: 'The macOS Accessibility grant is broad, not a read-only OS permission. This assistant only performs limited reads, never typing, editing documents or controlling apps. Opening Settings neither grants permission nor enables the ledger.',
        openAccessibility: 'Open Accessibility settings', checkPermission: 'Check permission', scope: 'Allowed document folders',
        scopeHelp: 'File search, requested excerpts and local file opening stay within these folders; the ledger keeps only confirmed, in-scope local document paths. Separately consented window titles and HTTPS addresses are not limited by folder scope.',
        choose: 'Add folder', remove: 'Remove', noScope: 'No document folders selected.', pauseSearch: 'Pause document search', resumeSearch: 'Resume document search', searchPaused: 'Document search is paused',
        independentPause: 'Pausing document search also pauses saved-address opening, but does not stop app / consented window recording. Use the separate “Pause recording” control above to stop new ledger clues.',
        voiceHeading: 'Voice and global shortcut', voiceRegistered: 'System shortcut registered. No idle listening.', voiceConflict: 'The shortcut is not registered and may be in use. The voice button is still available.',
        voiceUnavailable: 'Desktop voice is unavailable for now. Document search in chat still works.', showVoice: 'Show voice panel (no new recording)', showTask: 'Show current task', stopSubmit: 'Finish recording and find',
        shortcut: 'Global shortcut', shortcutDefault: '⌘⇧Space (default)', shortcutAlt: '⌘⌥Space', shortcutK: '⌘⇧K', shortcutCustom: 'Other combination…', shortcutFormat: 'Custom combination, e.g. CommandOrControl+Shift+Space',
        saveShortcut: 'Save shortcut', shortcutBusy: 'Cancel the task / close the voice panel before changing the shortcut.',
        shortcutHelp: 'Press again while recording to submit. During processing it only shows status. Use a separate Cancel button to stop a task.',
        cancelBoundary: 'Cancel stops future work. An OS-open request already accepted may not be reversible; no document is closed for you.',
        voiceRequested: 'Voice entry requested. Check the voice panel for its actual state.', voiceCancel: 'Cancel task / close panel',
        runtime: 'Harness must keep running in the background. The shortcut stops after a full quit. No automatic login start, menu-bar icon or desktop launcher is added.',
        privacy: 'Clues only come from explicitly selected apps. No complete browser history, webpage / window bodies, Codex history, screen recording, keylogging, clipboard access or idle audio. No Feishu / Tencent service APIs are connected. The temporary current-document cue does not replace the 7-day ledger.',
        modelPrivacy: 'Clue collection and ledger storage are local. When you request a task, final transcripts, relevant app and file names, locations, window titles, saved addresses and requested file excerpts may enter the normal model conversation. This is not wholly offline or completely erased by clearing the ledger.',
        failed: 'The operation could not be completed.', connection: 'Cannot connect to the document assistant. Refresh the Harness page and retry.', noAccess: 'This connection cannot perform these actions. Settings and voice will not be changed.',
        settingsPending: 'Settings have not loaded. Refresh to retry.', saving: 'Saving / refreshing…',
      },
    };
    const css = `
.wf-root{font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-primary);min-width:0;width:100%}
.wf-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.wf-controls{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;flex-shrink:0}
.wf-button,.wf-start,.wf-settings,.wf-sidebar{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;padding:6px 10px;white-space:nowrap}
.wf-root button:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}.wf-root button:disabled,.wf-root input:disabled,.wf-root select:disabled{opacity:.5;cursor:not-allowed}
.wf-root button:focus-visible,.wf-root input:focus-visible,.wf-root select:focus-visible,.wf-root [tabindex="0"]:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}.wf-icon{flex-shrink:0;color:var(--dsw-alias-brand-primary)}
.wf-key{font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.wf-sidebar{border-color:transparent;width:100%;justify-content:flex-start;padding:8px;min-height:36px;max-width:100%}.wf-sidebar.wf-narrow{width:36px;justify-content:center;padding:7px}
.wf-overlay{position:fixed;inset:0;z-index:100;display:grid;place-items:center;padding:24px;box-sizing:border-box;pointer-events:auto}.wf-shade{position:absolute;inset:0;background:var(--dsw-alias-bg-base);opacity:.88}
.wf-dialog{position:relative;display:flex;flex-direction:column;min-width:0;width:min(760px,100%);max-height:calc(100dvh - 48px);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 20px 70px var(--dsw-alias-border-l1);font-size:13px;overflow:hidden}
.wf-dialog-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;padding:20px 22px 14px;border-bottom:1px solid var(--dsw-alias-border-l1)}.wf-dialog-head h1{font:inherit;font-size:19px;font-weight:650;margin:0 0 6px}.wf-dialog-head p{margin:0}.wf-dialog-body{overflow:auto;padding:0 22px 20px;overscroll-behavior:contain}
.wf-section{padding:18px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.wf-section:last-child{border-bottom:0}.wf-section h2,.wf-section legend{font:inherit;font-size:15px;font-weight:650;margin:0 0 8px}.wf-section p{margin:7px 0}.wf-muted{color:var(--dsw-alias-label-secondary)}.wf-small{font-size:12px}.wf-wrap{overflow-wrap:anywhere;min-width:0}
.wf-status{display:inline-flex;align-items:center;border:1px solid var(--dsw-alias-border-l1);padding:4px 9px;border-radius:20px;font-size:12px}.wf-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:12px 0 6px}.wf-primary{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.wf-apps{border:0;padding:0;margin:16px 0 8px;min-width:0}.wf-app-list{display:grid;gap:8px;max-height:360px;overflow:auto;overscroll-behavior:contain;padding:4px}.wf-app{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,230px);align-items:start;gap:12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:10px;min-width:0}.wf-app-choice{display:flex;align-items:flex-start;gap:8px;min-width:0;cursor:pointer}.wf-app input{width:16px;height:16px;flex-shrink:0;accent-color:var(--dsw-alias-brand-primary);margin:2px 0 0}.wf-app small{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;overflow-wrap:anywhere}.wf-app-filter{width:100%;margin:5px 0}
.wf-input,.wf-select{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;padding:7px 9px;min-width:0;box-sizing:border-box}.wf-query{display:flex;align-items:center;gap:8px;margin:12px 0}.wf-query input{flex:1;width:100%}.wf-shortcut{min-width:190px;max-width:100%;flex:1}.wf-custom{width:100%;margin:4px 0}
.wf-list{list-style:none;padding:0;margin:8px 0}.wf-history{max-height:360px;overflow:auto;overscroll-behavior:contain;padding:0 4px}.wf-record{padding:10px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.wf-record:last-child{border-bottom:0}.wf-record-top{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}.wf-record-name{font-weight:600;margin:4px 0}.wf-record-path{font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}.wf-row{display:flex;align-items:center;justify-content:space-between;gap:10px;margin:8px 0;min-width:0}
.wf-details{margin:12px 0 0;border-top:1px solid var(--dsw-alias-border-l1);padding-top:10px}.wf-details summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary)}.wf-details p{margin:6px 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.wf-error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}.wf-notice{padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;margin:10px 0}.wf-confirm{padding:12px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;margin-top:10px}.wf-confirm h3{font:inherit;font-weight:650;margin:0 0 5px}.wf-live{min-height:18px;margin-top:8px}
@media(max-width:600px){.wf-overlay{padding:10px}.wf-dialog{max-height:calc(100dvh - 20px)}.wf-dialog-head{padding:16px}.wf-dialog-body{padding:0 16px 16px}.wf-key{display:none}.wf-app{grid-template-columns:1fr;gap:10px}.wf-row{align-items:flex-start}.wf-shortcut{min-width:0;width:100%;flex-basis:100%}}
`;
    function icon(kind) {
      return h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round', className: 'wf-icon', 'aria-hidden': true }, kind === 'microphone'
        ? [h('rect', { key: 'r', x: 9, y: 3, width: 6, height: 12, rx: 3 }), h('path', { key: 'p', d: 'M5.5 10.5v1a6.5 6.5 0 0 0 13 0v-1M12 18v3M9 21h6' })]
        : [h('path', { key: 'p', d: 'M4 4h7a3 3 0 0 1 3 3v14a4 4 0 0 0-4-3H4zM14 7h6v14h-6' }), h('path', { key: 'q', d: 'M7 8h3M7 11h3' })]);
    }
    return {
      inject: ['slots', 'locale', 'remote', 'uiWorkspace'],
      async apply(ctx) {
        const locale = ctx.get('locale');
        ctx.effect(() => locale.register(namespace, dictionaries));
        const t = locale.bind(namespace);
        // $mount is itself owned by its accessing Context in rc.2. It publishes
        // the namespace first; requiring it in root inject would deadlock setup.
        await ctx.remote.$mount(makeActivityContribution());
        ctx.inject(['remote.workfilesActivity'], childCtx => {
          const lifetime = new AbortController(), requests = new Set(), view = createViewStore();
          childCtx.effect(() => () => { lifetime.abort(new Error('Document assistant UI disposed.')); for (const controller of requests) controller.abort(); requests.clear(); view.dispose(); });
          async function request(input, caller) {
            const own = new AbortController(); requests.add(own);
            const signal = AbortSignal.any([lifetime.signal, own.signal, ...(caller ? [caller] : []), AbortSignal.timeout(20000)]);
            try {
              signal.throwIfAborted();
              const response = await childCtx.remote.workfilesActivity.action(parseActionInput(input), signal);
              signal.throwIfAborted();
              return decodeActivityResponse(response, t('connection'));
            } finally { requests.delete(own); }
          }
          function useLocale() { React.useSyncExternalStore(listener => locale.subscribe(listener), () => locale.getSnapshot()); }
          function useView() { return React.useSyncExternalStore(view.subscribe, view.getSnapshot); }
          function useCanAct(props) { return typeof props.useRemoteAccess === 'function' ? props.useRemoteAccess('workfilesActivity/action') : typeof props.useAccess === 'function' ? props.useAccess('workfilesActivity/action') : false; }
          function useOperation(canAct) {
            const pending = React.useRef(null), alive = React.useRef(true);
            const [busy, setBusy] = React.useState(false), [error, setError] = React.useState('');
            React.useEffect(() => { alive.current = true; return () => { alive.current = false; pending.current?.abort(); pending.current = null; }; }, []);
            async function perform(operation, quiet = false) {
              if (!canAct || lifetime.signal.aborted || !alive.current) return;
              // A Human action supersedes a passive visible-view refresh. Never
              // silently lose a click because a background read held the latch.
              if (pending.current) {
                if (quiet || !pending.current.quiet) return;
                pending.current.abort(); pending.current = null;
              }
              const controller = new AbortController(); controller.quiet = quiet; pending.current = controller;
              if (!quiet) { setBusy(true); setError(''); }
              try { await operation(controller.signal); }
              catch (failure) { if (!controller.signal.aborted && !lifetime.signal.aborted && alive.current) setError(String(failure?.message || t('failed')).slice(0, 1000)); }
              finally { if (pending.current === controller) { pending.current = null; if (alive.current) setBusy(false); } }
            }
            return { busy, error, perform, pending, clearError() { if (alive.current) setError(''); } };
          }
          function ComposerEntry(props) {
            useLocale();
            const state = useView(), canAct = useCanAct(props), operation = useOperation(canAct);
            const [notice, setNotice] = React.useState('');
            React.useEffect(() => {
              if (!canAct) { view.voice(null); return; }
              return watchVoiceStatus(signal => request({ action: 'voice_status' }, signal), value => view.voice(value), { signal: lifetime.signal, visible: () => document.visibilityState !== 'hidden' });
            }, [canAct]);
            // The label never promises peek-only based on a stale snapshot.
            // Native toggle decides atomically: start / stop-submit / reveal busy.
            const label = t('voice');
            return h('div', { className: 'wf-root' }, h('style', null, css),
              h('div', { className: 'wf-top' }, h('div', { className: 'wf-controls' },
                h('button', { type: 'button', className: 'wf-start', disabled: operation.busy || !canAct, onClick: () => operation.perform(async signal => { await request({ action: 'voice_record' }, signal); const status = await request({ action: 'voice_status' }, signal); view.voice(status); setNotice(t('voiceRequested')); }), title: t('shortcutHelp'), 'aria-label': label }, icon('microphone'), operation.busy ? t('loading') : label),
                h('button', { type: 'button', className: 'wf-settings', onClick: event => view.open(event.currentTarget), 'aria-haspopup': 'dialog', 'aria-expanded': state.open }, t('settings'))),
                h('span', { className: 'wf-key', title: t('shortcutHelp') }, state.voice?.shortcut ? shortcutLabel(state.voice.shortcut, state.voice.platform) : t('defaultShortcut'))),
              operation.error ? h('p', { className: 'wf-error', role: 'alert' }, operation.error) : null,
              notice && !operation.error ? h('p', { className: 'wf-small wf-muted', role: 'status' }, notice) : null);
          }
          function SidebarEntry(props) {
            useLocale(); const state = useView();
            return h('div', { className: 'wf-root' }, h('style', null, css), h('button', { type: 'button', className: `wf-sidebar${props.wide ? '' : ' wf-narrow'}`, title: t('assistant'), 'aria-label': t('assistant'), 'aria-haspopup': 'dialog', 'aria-expanded': state.open, onClick: event => view.open(event.currentTarget) }, icon('ledger'), props.wide ? h('span', { className: 'wf-wrap' }, t('assistant')) : null));
          }
          function SettingsDialog(props) {
            useLocale();
            const state = useView(), canAct = useCanAct(props), operation = useOperation(canAct), dialog = React.useRef(null);
            const policyRef = React.useRef(initialPolicyState());
            const [policy, setPolicy] = React.useState(policyRef.current), status = policy.status;
            const [records, setRecords] = React.useState(null), [query, setQuery] = React.useState(''), [appliedQuery, setAppliedQuery] = React.useState('');
            const [confirmClear, setConfirmClear] = React.useState(false), [notice, setNotice] = React.useState(''), [shortcut, setShortcut] = React.useState('CommandOrControl+Shift+Space'), [customShortcut, setCustomShortcut] = React.useState(false);
            const [showAllApps, setShowAllApps] = React.useState(false), [showBackground, setShowBackground] = React.useState(false);
            const [discovery, setDiscovery] = React.useState(null), [retainedApps, setRetainedApps] = React.useState([]), [appQuery, setAppQuery] = React.useState(''), [openRequest, setOpenRequest] = React.useState(null);
            const shortcutDirty = React.useRef(false), queryRef = React.useRef('');
            const headingId = React.useId(), introId = React.useId(), appsHelpId = React.useId(), contextHelpId = React.useId(), appQueryId = React.useId(), queryId = React.useId(), shortcutId = React.useId();
            React.useLayoutEffect(() => {
              const restore = state.trigger;
              dialog.current?.querySelector('[data-wf-initial]')?.focus();
              return () => { if (restore?.isConnected) restore.focus({ preventScroll: true }); };
            }, []);
            function commitPolicy(event) {
              // Update the gate synchronously too: no second gesture can race React's next render.
              const next = reducePolicyState(policyRef.current, event);
              policyRef.current = next; setPolicy(next); return next;
            }
            function failPolicy(failure) {
              commitPolicy({ type: 'failed', error: failure?.message || t('failed') });
              setRecords(null); setOpenRequest(null);
            }
            function rememberAppLabels(selectedIds, extra) {
              // Ephemeral labels only. Retention of a label is not app selection, running state or consent.
              setRetainedApps(previous => mergeApplicationCatalog({ selected: selectedIds, retained: previous, ...extra }).applications.map(({ id, name }) => ({ id, name })));
            }
            function acceptRecords(list, selectedIds) {
              if (policyRef.current.stale) return;
              const entries = Array.isArray(list?.entries) ? list.entries : [];
              setRecords(entries); rememberAppLabels(selectedIds, { entries });
            }
            async function refresh(signal, refreshPermission = false) {
              let value;
              try {
                value = await request({ action: 'status', ...(refreshPermission ? { refresh: true } : {}) }, signal);
                commitPolicy({ type: 'status', value }); operation.clearError();
              } catch (failure) {
                if (!signal.aborted && !lifetime.signal.aborted) failPolicy(failure);
                throw failure;
              }
              view.voice(value.voice);
              if (!shortcutDirty.current && value.voice?.shortcut) {
                setShortcut(value.voice.shortcut);
                setCustomShortcut(!['CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Space', 'CommandOrControl+Shift+K'].includes(value.voice.shortcut));
              }
              const list = await request({ action: 'list', query: queryRef.current, limit: 20 }, signal);
              acceptRecords(list, value.ledger?.settings?.applications || []);
            }
            async function discoverApplications(signal) {
              // Deliberate Human click only. Never called by refresh, pane opening or either status watcher.
              const value = await request({ action: 'discover_applications' }, signal);
              setDiscovery(value); rememberAppLabels(settings?.applications || [], { discovered: value?.applications });
            }
            React.useEffect(() => {
              operation.perform(signal => refresh(signal));
              // Visible Human view only; no polling after close, no native sample request.
              const timer = setInterval(() => { operation.perform(signal => refresh(signal), true); }, 5000);
              return () => clearInterval(timer);
            }, [canAct]);
            async function mutate(input, signal) {
              // Clearing is always a safe explicit revocation. Other policy writes require a confirmed status.
              if (!['clear', 'forget'].includes(input.action) && !canWritePolicy(policyRef.current, canAct)) throw new Error(t('policyStale'));
              commitPolicy({ type: 'writing' });
              // Forget disclosed rows / open acknowledgments before a revocation or clear can fail or be delayed.
              setRecords(null); setOpenRequest(null);
              let result;
              try {
                result = await request(input, signal);
                if (['configure', 'set_application', 'set_context', 'select_running_applications'].includes(input.action)) commitPolicy({ type: 'ack', value: result });
              } catch (failure) {
                if (!signal.aborted && !lifetime.signal.aborted) failPolicy(failure);
                throw failure;
              }
              setNotice(''); await refresh(signal); return result;
            }
            const ledger = status?.ledger, settings = ledger?.settings, voice = status?.voice, documents = status?.documents;
            const selected = settings?.applications || [], contextSelected = settings?.contextApplications || [], roots = documents?.configuredRoots || [];
            const catalog = mergeApplicationCatalog({ selected, capabilities: ledger?.capabilities?.applications, discovered: discovery?.applications, retained: retainedApps, entries: records });
            const visibleApps = applicationRows(catalog.applications, { selected, query: appQuery, showBackground });
            const backgroundCount = catalog.applications.filter(app => app.foreground === false && !selected.includes(app.id)).length;
            const disabled = operation.busy || !canAct, policyDisabled = !canWritePolicy(policy, canAct, operation.busy);
            const error = policy.error || operation.error;
            const button = (label, action, extra = {}) => h('button', { type: 'button', className: 'wf-button', disabled, onClick: () => operation.perform(signal => action(signal)), ...extra }, label);
            const ledgerState = ledger?.state === 'recording' ? 'recording' : ledger?.state === 'recording_apps' ? 'recordingApps' : ledger?.state === 'unavailable' ? 'unavailable' : 'paused';
            const preset = customShortcut ? 'custom' : ['CommandOrControl+Shift+Space', 'CommandOrControl+Alt+Space', 'CommandOrControl+Shift+K'].includes(shortcut) ? shortcut : 'custom';
            function keyDown(event) {
              if (event.isComposing) return;
              if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); view.close(); return; }
              if (event.key !== 'Tab') return;
              const nodes = [...dialog.current.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(node => node.getClientRects().length);
              const next = focusIndex(nodes.indexOf(event.target), nodes.length, event.shiftKey);
              if (next >= 0) { event.preventDefault(); nodes[next].focus(); }
            }
            return h('div', { className: 'wf-root wf-overlay' }, h('style', null, css), h('div', { className: 'wf-shade', 'aria-hidden': true }),
              h('section', { ref: dialog, className: 'wf-dialog', role: 'dialog', 'aria-modal': true, 'aria-labelledby': headingId, 'aria-describedby': introId, onKeyDown: keyDown },
                h('header', { className: 'wf-dialog-head' }, h('div', null, h('h1', { id: headingId }, t('assistant')), h('p', { id: introId, className: 'wf-small wf-muted' }, t('intro'))), h('button', { type: 'button', className: 'wf-button', 'data-wf-initial': true, 'aria-label': t('close'), onClick: () => view.close() }, '×')),
                h('div', { className: 'wf-dialog-body' },
                  !canAct ? h('p', { className: 'wf-notice', role: 'status' }, t('noAccess')) : null,
                  error ? h('p', { className: 'wf-error wf-notice', role: 'alert' }, error) : null,
                  policy.stale && status ? h('div', { className: 'wf-notice', role: 'status' }, h('p', { className: 'wf-small' }, t('policyStale')), button(t('policyRetry'), signal => refresh(signal, true))) : null,
                  notice ? h('p', { className: 'wf-notice', role: 'status' }, notice) : null,
                  status === null ? h('div', { className: 'wf-actions' }, h('span', { role: 'status' }, operation.busy ? t('loading') : t('settingsPending')), button(t('refresh'), signal => refresh(signal, true))) : null,
                  h('section', { className: 'wf-section', 'aria-label': t('ledger') }, h('h2', null, t('ledger')),
                    ledger ? h('p', null, h('span', { className: 'wf-status', role: 'status' }, t(policy.stale ? 'policyStaleShort' : ledgerState))) : null,
                    h('p', { className: 'wf-muted' }, t('ledgerShort')),
                    h('div', { className: 'wf-actions' }, button(t(settings?.enabled ? 'pauseLedger' : 'startLedger'), signal => mutate({ action: 'configure', enabled: !settings.enabled }, signal), { className: 'wf-button wf-primary', disabled: policyDisabled || !settings || !settings.enabled && (!selected.length || ledger?.capabilities?.available !== true) }),
                      settings && !policy.stale ? h('span', { className: 'wf-small wf-muted' }, t(settings.enabled ? 'selectionLiveShort' : 'selectionPausedShort')) : null),
                    !selected.length && settings ? h('p', { className: 'wf-small wf-muted' }, t('selectApp')) : null,
                    h('fieldset', { className: 'wf-apps', disabled: policyDisabled || !settings, 'aria-describedby': showAllApps ? `${appsHelpId} ${contextHelpId}` : appsHelpId }, h('legend', null, t('apps')), h('p', { id: appsHelpId, className: 'wf-small wf-muted' }, t('appsShort')),
                      h('div', { className: 'wf-actions' }, button(t(showAllApps ? 'hideApps' : 'addApps'), async () => setShowAllApps(value => !value), { disabled: disabled || !settings, 'aria-expanded': showAllApps }),
                        button(t('selectAllRunning'), signal => mutate({ action: 'select_running_applications' }, signal), { disabled: policyDisabled || !settings || ledger?.capabilities?.available !== true, title: t('selectAllRunningHelp') }),
                        button(t('refreshApps'), signal => discoverApplications(signal), { disabled: disabled || !settings || ledger?.capabilities?.available !== true }),
                        h('span', { className: 'wf-small wf-muted', role: 'status' }, t(discovery ? 'discoveryDone' : 'discoveryPending'))),
                      !showAllApps ? h('p', { className: 'wf-small wf-muted wf-wrap' }, selected.length ? `${t('selectedApps')}: ${selected.length} · ${selected.map(id => catalog.applications.find(app => app.id === id)?.name || id).join(t('sep'))}` : t('noAppsSelected')) : null,
                      showAllApps ? h('div', null,
                        h('p', { id: contextHelpId, className: 'wf-small wf-muted' }, t('contextShort')),
                        h('label', { htmlFor: appQueryId, className: 'wf-small' }, t('filterApps')), h('input', { id: appQueryId, type: 'search', className: 'wf-input wf-app-filter', value: appQuery, maxLength: 256, placeholder: t('appFilterPlaceholder'), onChange: event => setAppQuery(event.target.value) }),
                        h('p', { className: 'wf-small wf-muted' }, `${t('selectedApps')}: ${selected.length} / ${maxApplications}`),
                        backgroundCount || showBackground ? h('label', { className: 'wf-small wf-muted wf-row' }, h('input', { type: 'checkbox', checked: showBackground, onChange: () => setShowBackground(value => !value) }), h('span', null, t('showBackground'), backgroundCount ? ` · ${backgroundCount}` : '')) : null,
                        catalog.truncated || discovery?.truncated ? h('p', { className: 'wf-small wf-muted', role: 'status' }, t('catalogLimit')) : null,
                        visibleApps.length ? h('div', { className: 'wf-app-list', tabIndex: 0, role: 'group', 'aria-label': t('apps') }, visibleApps.map(app => {
                        const chosen = selected.includes(app.id);
                        return h('div', { key: app.id, className: 'wf-app' },
                          h('label', { className: 'wf-app-choice' }, h('input', { type: 'checkbox', checked: chosen, disabled: policyDisabled || !settings || !chosen && selected.length >= maxApplications, title: !chosen && selected.length >= maxApplications ? t('appLimit') : undefined,
                            onChange: event => { const input = updateApplicationSelection(app.id, event.target.checked); operation.perform(signal => mutate(input, signal)); } }),
                            h('span', { className: 'wf-wrap' }, app.name, h('small', null, app.id), h('small', null, t(app.installed === true ? 'installed' : app.installed === false ? 'notInstalled' : 'installUnknown'), app.running === true ? ` · ${t('runningRefreshed')}` : ''))),
                          h('label', { className: 'wf-app-choice' }, h('input', { type: 'checkbox', checked: chosen && contextSelected.includes(app.id), disabled: policyDisabled || !settings || !chosen, 'aria-label': `${app.name} · ${t('contextApp')}`, 'aria-describedby': contextHelpId,
                            onChange: event => { const input = updateContextSelection(app.id, event.target.checked); operation.perform(signal => mutate(input, signal)); } }),
                            h('span', { className: 'wf-wrap' }, t('contextShortLabel'), h('small', null, t(chosen ? 'contextOptional' : 'contextSelectFirst')))));
                      })) : h('p', { className: 'wf-muted' }, t('noAppsMatch'))) : null),
                    ledger?.lastError ? h('p', { className: 'wf-error' }, ledger.lastError) : null,
                    typeof ledger?.count === 'number' ? h('p', { className: 'wf-small wf-muted' }, `${t('count')}：${ledger.count}`, ledger.lastObservedAt ? ` · ${t('lastObserved')}：${formatObserved(ledger.lastObservedAt, t('unknownTime'))}` : '') : null),
                  h('section', { className: 'wf-section', 'aria-label': t('accessibility') }, h('h2', null, t('accessibility')), h('p', null, t(!ledger ? 'settingsPending' : ledger.capabilities?.available !== true ? 'permissionUnavailable' : ledger.capabilities?.accessibilityTrusted === true ? 'axShortGranted' : 'axShortMissing')),
                    h('div', { className: 'wf-actions' }, button(t('openAccessibility'), signal => request({ action: 'open_accessibility' }, signal)), button(t('checkPermission'), signal => refresh(signal, true)))),
                  h('section', { className: 'wf-section', 'aria-label': t('recent') }, h('h2', null, t('recent')), h('p', { className: 'wf-small wf-muted' }, t('recentHelp')),
                    h('form', { className: 'wf-query', onSubmit: event => { event.preventDefault(); operation.perform(async signal => { queryRef.current = query.trim(); setAppliedQuery(queryRef.current); const list = await request({ action: 'list', query: queryRef.current, limit: 20 }, signal); acceptRecords(list, selected); }); } }, h('input', { id: queryId, type: 'search', className: 'wf-input', value: query, maxLength: 512, placeholder: t('queryPlaceholder'), 'aria-label': t('filter'), disabled: disabled || policy.stale, onChange: event => setQuery(event.target.value) }), h('button', { type: 'submit', className: 'wf-button', disabled: disabled || policy.stale }, t('applyFilter'))),
                    h('div', { className: 'wf-actions' }, button(t('refresh'), signal => refresh(signal)), button(t('clear'), async () => setConfirmClear(true), { disabled: disabled || !ledger })),
                    confirmClear ? h('div', { className: 'wf-confirm', role: 'group', 'aria-label': t('clearTitle') }, h('h3', null, t('clearTitle')), h('p', { className: 'wf-small' }, t('clearHelp')), h('div', { className: 'wf-actions' }, button(t('clearConfirm'), async signal => { await mutate({ action: 'clear' }, signal); setConfirmClear(false); setNotice(t('cleared')); }), button(t('cancel'), async () => setConfirmClear(false)))) : null,
                    documents?.enabled === false ? h('p', { className: 'wf-small wf-muted', role: 'status' }, t('openSearchPaused')) : null,
                    records === null ? h('p', { className: 'wf-muted', role: 'status' }, operation.busy ? t('loading') : t('recordsPending')) : records.length ? h('ul', { className: 'wf-list wf-history', tabIndex: 0, 'aria-label': `${t('recent')}${appliedQuery ? ` · ${appliedQuery}` : ''}` }, records.map(entry => {
                      const openAction = observedOpenAction(entry, { canAct, busy: operation.busy || policy.stale, searchEnabled: documents?.enabled });
                      return h('li', { key: entry.id, className: 'wf-record' },
                        h('div', { className: 'wf-record-top' }, h('span', null, entry.app?.name || entry.app?.id || t('software')), h('time', { className: 'wf-small wf-muted', dateTime: entry.observedAt }, formatObserved(entry.observedAt, t('unknownTime'))),
                          h('button', { type: 'button', className: 'wf-small', 'aria-label': `${t('forgetRecord')} ${entry.app?.name || ''}`.trim(), title: t('forgetRecordHelp'), disabled: disabled,
                            onClick: () => operation.perform(async signal => { await mutate({ action: 'forget', id: entry.id }, signal); setNotice(t('recordForgotten')); }) }, t('forgetRecord'))),
                        h('div', { className: 'wf-record-name wf-wrap' }, entry.kind === 'document' && entry.document ? entry.document.name : entry.kind === 'window' ? entry.window?.title || t('windowOnly') : t('applicationOnly')),
                        entry.kind === 'document' && entry.document ? h('div', { className: 'wf-record-path' }, entry.document.path) : null,
                        entry.kind === 'window' ? h('div', null, h('div', { className: 'wf-small wf-muted' }, t('windowClue')),
                          entry.window?.url ? h('div', { className: 'wf-record-path' }, entry.window.url) : h('p', { className: 'wf-small wf-muted' }, t('noObservedUrl')),
                          h('div', { className: 'wf-actions' }, button(t('openObserved'), async signal => {
                            if (!openAction) return;
                            const result = await request(openAction, signal);
                            if (result?.status !== 'open_requested') throw new Error(t('failed'));
                            setOpenRequest({ id: entry.id, requestedAt: result.requestedAt });
                          }, { disabled: disabled || !openAction })),
                          openRequest?.id === entry.id ? h('p', { className: 'wf-small wf-muted', role: 'status' }, t('openRequested'), openRequest.requestedAt ? ` · ${formatObserved(openRequest.requestedAt, t('unknownTime'))}` : '') : null) : null);
                    })) : h('p', { className: 'wf-muted' }, t('noRecords')),
                    h('p', { className: 'wf-small wf-muted' }, t('observedShort'))),
                  h('section', { className: 'wf-section', 'aria-label': t('scope') }, h('h2', null, t('scope')), h('p', { className: 'wf-small wf-muted' }, t('scopeShort')),
                    documents?.enabled === false ? h('p', { role: 'status' }, t('searchPaused')) : null,
                    documents ? roots.length ? h('ul', { className: 'wf-list' }, roots.map(root => h('li', { key: root, className: 'wf-row' }, h('span', { className: 'wf-wrap' }, root), button(t('remove'), signal => mutate({ action: 'remove_root', path: root }, signal), { disabled: policyDisabled, 'aria-label': `${t('remove')} ${root}` })))) : h('p', { className: 'wf-muted' }, t('noScope')) : null,
                    h('div', { className: 'wf-actions' }, button(t('choose'), async signal => { const selectedPath = await childCtx.uiWorkspace.pickDirectory(); signal.throwIfAborted(); if (selectedPath) await mutate({ action: 'add_root', path: selectedPath }, signal); }, { disabled: policyDisabled }), button(t(documents?.enabled === false ? 'resumeSearch' : 'pauseSearch'), signal => mutate({ action: 'set_search_enabled', enabled: documents.enabled === false }, signal), { disabled: policyDisabled || !documents })),
                    ...(documents?.warnings || []).map((warning, index) => h('p', { key: index, className: 'wf-small wf-muted' }, warning))),
                  h('section', { className: 'wf-section', 'aria-label': t('voiceHeading') }, h('h2', null, t('voiceHeading')),
                    h('p', { className: voice?.running && voice?.registered ? 'wf-muted' : 'wf-error', role: 'status' }, voice?.running ? voice.registered ? `${shortcutLabel(voice.shortcut, voice.platform)} · ${t('voiceRegistered')}` : t('voiceConflict') : voice?.lastError || t('voiceUnavailable')),
                    h('div', { className: 'wf-actions' }, button(t('showVoice'), async signal => { const result = await request({ action: 'voice_show' }, signal); view.voice(result); await refresh(signal); }), button(t('voice'), async signal => { await request({ action: 'voice_record' }, signal); await refresh(signal); }, { title: t('shortcutHelp') }), button(t('voiceCancel'), async signal => { await request({ action: 'voice_cancel' }, signal); await refresh(signal); }, { disabled: disabled || !voiceInProgress(voice) })),
                    h('label', { htmlFor: shortcutId }, t('shortcut')),
                    h('div', { className: 'wf-actions' }, h('select', { id: shortcutId, className: 'wf-select wf-shortcut', value: preset, disabled: disabled || !voice || voiceInProgress(voice), onChange: event => { shortcutDirty.current = true; setCustomShortcut(event.target.value === 'custom'); setShortcut(event.target.value === 'custom' ? '' : event.target.value); } },
                      h('option', { value: 'CommandOrControl+Shift+Space' }, t('shortcutDefault')), h('option', { value: 'CommandOrControl+Alt+Space' }, t('shortcutAlt')), h('option', { value: 'CommandOrControl+Shift+K' }, t('shortcutK')), h('option', { value: 'custom' }, t('shortcutCustom'))),
                      button(t('saveShortcut'), async signal => { await request({ action: 'voice_shortcut', shortcut: shortcut.trim() }, signal); shortcutDirty.current = false; await refresh(signal); }, { disabled: disabled || !voice || voiceInProgress(voice) || shortcut.trim().length < 3 || shortcut.trim() === voice.shortcut })),
                    preset === 'custom' ? h('input', { type: 'text', className: 'wf-input wf-custom', value: shortcut, maxLength: 100, placeholder: t('shortcutFormat'), 'aria-label': t('shortcutFormat'), disabled: disabled || !voice || voiceInProgress(voice), onChange: event => { shortcutDirty.current = true; setShortcut(event.target.value); } }) : null,
                    voiceInProgress(voice) ? h('p', { className: 'wf-small wf-muted' }, t('shortcutBusy')) : null),
                  h('details', { className: 'wf-details' }, h('summary', null, t('details')),
                    h('p', { className: 'wf-small wf-muted' }, t('ledgerHelp')), h('p', { className: 'wf-small wf-muted' }, t('appsHelp')),
                    h('p', { className: 'wf-small wf-muted' }, t(settings?.enabled ? 'selectionLive' : 'selectionPaused')),
                    h('p', { className: 'wf-small wf-muted' }, t('discoverHelp')), h('p', { className: 'wf-small wf-muted' }, t('contextHelp')), h('p', { className: 'wf-small wf-muted' }, t('contextPrivacy')),
                    h('p', { className: 'wf-small wf-muted' }, t('axBoundary')), h('p', { className: 'wf-small wf-muted' }, t('retention')),
                    h('p', { className: 'wf-small wf-muted' }, t('observedHelp')), h('p', { className: 'wf-small wf-muted' }, t('observedUrlHelp')),
                    h('p', { className: 'wf-small wf-muted' }, t('scopeHelp')), h('p', { className: 'wf-small wf-muted' }, t('independentPause')),
                    h('p', { className: 'wf-small wf-muted' }, t('shortcutHelp')), h('p', { className: 'wf-small wf-muted' }, t('cancelBoundary')), h('p', { className: 'wf-small wf-muted' }, t('runtime')),
                    h('p', { className: 'wf-small wf-muted' }, t('privacy')), h('p', { className: 'wf-small wf-muted' }, t('modelPrivacy'))),
                  h('div', { className: 'wf-live wf-small wf-muted', role: 'status', 'aria-live': 'polite' }, operation.busy ? t('saving') : null))));
          }
          function SettingsOverlay(props) { const state = useView(); return state.open ? h(SettingsDialog, props) : null; }
          childCtx.slots.inject('conversation.composer.dock', () => childCtx.slots.register({ name: 'conversation.composer.dock', id: 'local-workfiles-assistant', order: 8, label: () => t('assistant') }, props => h(ComposerEntry, { ...props, key: props.sessionId })));
          childCtx.slots.inject('sidebar.footer.action', () => childCtx.slots.register({ name: 'sidebar.footer.action', id: 'local-workfiles-assistant-sidebar', order: 70, label: () => t('assistant') }, props => h(SidebarEntry, props)));
          childCtx.slots.inject('shell.overlay', () => childCtx.slots.register({ name: 'shell.overlay', id: 'local-workfiles-assistant-settings', order: 70, label: () => t('assistant') }, props => h(SettingsOverlay, props)));
        });
      },
    };
  },
});
