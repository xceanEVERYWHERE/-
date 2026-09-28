/* 中文说明：密钥仅保存在受信任扩展环境；页面只收到已配置标记，写入使用版本比较。 */
(() => {
  'use strict';
  const STORE = 'zhsCoreStateV1', RUN = 'zhsVideoRunV1', LEGACY = 'zhsRunV2', TRACE = 'zhsTraceV2';
  const KEYS = ['config', RUN, LEGACY, 'apiKey'];
  const clients = new Map(), requests = new Map(), seen = new Map(), cancelled = new Map(), revoked = new Set(), tabEpoch = new Map();
  let state, mutations = Promise.resolve();
  const clone = value => structuredClone(value);
  const cleanError = error => String(error?.message || error).slice(0, 200);
  const ready = (async () => {
    await chrome.storage.local.setAccessLevel({accessLevel: 'TRUSTED_CONTEXTS'});
    const saved = (await chrome.storage.local.get(STORE))[STORE];
    state = saved || {values: {config: {model: 'deepseek-flash', mute: true, next: true, autoSubmit: true}, [RUN]: null, [LEGACY]: null, [TRACE]: []}, revisions: {}, apiKey: ''};
    if (!state.values || !state.revisions || typeof state.apiKey !== 'string') throw Error('扩展存储格式异常，请在扩展管理页重新加载。');
    for (const key of [...KEYS, TRACE]) if (!Number.isSafeInteger(state.revisions[key]) || state.revisions[key] < 0) state.revisions[key] = 0;
  })();
  // 及时消费启动失败；每条消息仍等待 ready 并返回失败，不降级暴露存储。
  void ready.catch(() => {});
  function route(value) {
    try {
      const u = new URL(value);
      if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
      if (u.hostname === 'www.zhihuishu.com' && u.pathname === '/') return {home: true, href: u.href, identity: 'home'};
      if (u.hostname === 'studyh5.zhihuishu.com' && /^\/videoStudy\/?$/.test(u.pathname) && u.search.length > 1) return {home: false, href: u.href, identity: u.hostname + u.search};
      if ((u.hostname === 'wisdom-mooc.zhihuishu.com' && /^\/study\/index\/?$/.test(u.pathname)) ||
          (u.hostname === 'studyvideoh5.zhihuishu.com' && /^\/stuStudy\/?$/.test(u.pathname))) {
        const ids = u.searchParams.getAll('recruitAndCourseId');
        if (ids.length === 1 && ids[0].trim() && ids[0].length <= 512) return {home: false, href: u.href, identity: u.hostname + ':' + ids[0]};
      }
    } catch (_) {}
    return null;
  }
  function basicSender(sender) {
    if (sender?.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 ||
        typeof sender.documentId !== 'string' || !sender.documentId || sender.tab.url !== sender.url ||
        (sender.documentLifecycle && sender.documentLifecycle !== 'active')) throw Error('仅允许当前学习页的顶层扩展脚本访问。');
    const page = route(sender.url); if (!page) throw Error('当前地址不属于支持的学习页面。');
    return page;
  }
  async function verifySender(sender) {
    const page = basicSender(sender), key = sender.tab.id + ':' + sender.documentId, epoch = tabEpoch.get(sender.tab.id) || 0;
    if (revoked.has(key)) throw Error('此文档已经导航离开，访问已取消。');
    const tab = await chrome.tabs.get(sender.tab.id);
    if (revoked.has(key) || (tabEpoch.get(sender.tab.id) || 0) !== epoch) throw Error('页面在请求期间发生导航。');
    if (!tab || tab.url !== sender.url) throw Error('文档已导航，访问已取消。');
    if (tab.status === 'loading') {
      // document_idle 可能早于标签完成加载；仅同一有效文档的这种情况允许初始化重试。
      const error = Error('当前文档仍在加载，请稍后重试。');
      error.code = 'DOCUMENT_LOADING'; error.retryable = true; throw error;
    }
    clients.set(key, {tabId: sender.tab.id, documentId: sender.documentId, url: sender.url});
    return page;
  }
  function visibleValue(key) { return key === 'apiKey' ? (state.apiKey ? 'configured' : '') : clone(state.values[key] ?? (key === TRACE ? [] : null)); }
  function snapshot() {
    return {values: Object.fromEntries([...KEYS, TRACE].map(key => [key, visibleValue(key)])), revisions: clone(state.revisions)};
  }
  function serial(operation) {
    const next = mutations.then(async () => { await ready; return operation(); });
    mutations = next.catch(() => {}); return next;
  }
  async function broadcast(key, clientId) {
    const message = {type: 'zhs-core-changed', key, value: visibleValue(key), revision: state.revisions[key], clientId};
    for (const [id, client] of clients) {
      void chrome.tabs.sendMessage(client.tabId, message, {frameId: 0, documentId: client.documentId}).catch(() => clients.delete(id));
    }
  }
  function dataSize(value, max, depth = 0) {
    if (depth > 12) throw Error('存储内容层级过深。');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') { if (!Number.isFinite(value)) throw Error('存储数字无效。'); return; }
    if (typeof value === 'string') { if (value.length > max) throw Error('存储文本过长。'); return; }
    if (Array.isArray(value)) { if (value.length > 5000) throw Error('存储数组过长。'); value.forEach(item => dataSize(item, max, depth + 1)); return; }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value); if (entries.length > 100) throw Error('存储对象字段过多。');
      for (const [key, item] of entries) {
        if (['__proto__', 'constructor', 'prototype'].includes(key)) throw Error('存储属性不受支持。');
        dataSize(item, max, depth + 1);
      }
      return;
    }
    throw Error('存储内容必须为普通 JSON 数据。');
  }
  function bounded(value, max) {
    dataSize(value, max); if (JSON.stringify(value).length > max) throw Error('存储内容超过限制。'); return clone(value);
  }
  function validateValue(key, value, sender, page) {
    if (!KEYS.includes(key)) throw Error('不允许写入此存储键。');
    if (page.home && ![RUN, LEGACY].includes(key)) throw Error('首页仅允许恢复已有运行记录。');
    if (key === 'apiKey') {
      if (typeof value !== 'string' || value.length > 512 || /[\r\n\x00-\x1f]/.test(value)) throw Error('API Key 格式无效。');
      return value.trim();
    }
    if (key === 'config') {
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(name => !['model', 'mute', 'next', 'autoSubmit'].includes(name)) ||
          typeof value.model !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value.model) ||
          ['mute', 'next', 'autoSubmit'].some(name => typeof value[name] !== 'boolean')) throw Error('助手设置格式无效。');
      return clone(value);
    }
    if (value === null) throw Error('运行记录只能通过暂停停用，不能清空。');
    const target = bounded(value, 650000), targetPage = route(target.courseUrl), prior = state.values[key];
    if (!targetPage || targetPage.home || !target || Array.isArray(target) || typeof target.id !== 'string' || !target.id || target.id.length > 200 ||
        typeof target.enabled !== 'boolean' || !['course', 'exam', 'return', 'review'].includes(target.phase) ||
        !Number.isFinite(target.leaseUntil) || !Number.isFinite(target.updatedAt) ||
        (target.owner !== null && target.owner !== sender.documentId)) throw Error('运行记录或持有者无效。');
    if (!page.home && targetPage.identity !== page.identity) throw Error('不能写入其他课程的运行记录。');
    if (page.home && (!prior || target.id !== prior.id || target.courseUrl !== prior.courseUrl || target.owner !== null)) throw Error('首页不能新建或接管课程任务。');
    const otherActive = prior?.id === target.id && prior.enabled && prior.owner && prior.owner !== sender.documentId && prior.leaseUntil > Date.now();
    if (otherActive && !(target.enabled === false && target.owner === null)) throw Error('另一标签的运行租约尚未到期。');
    if (target.owner && target.leaseUntil > Date.now() + 60000) throw Error('运行租约时长超过限制。');
    return target;
  }
  function stopInvalidRequests() {
    for (const entry of requests.values()) {
      const run = state.values[RUN];
      if (!run?.enabled || run.owner !== entry.documentId || route(run.courseUrl)?.identity !== entry.identity || run.leaseUntil <= Date.now()) {
        entry.reason = 'abort'; entry.controller.abort();
      }
    }
  }
  async function setValue(message, sender, page) {
    return serial(async () => {
      page = await verifySender(sender);
      const key = message.key;
      if (!KEYS.includes(key) || !Number.isSafeInteger(message.expectedRevision) || message.expectedRevision < 0) throw Error('存储版本或键无效。');
      if (key === 'apiKey') throw Error('密钥只能在扩展自己的配置页设置。');
      if (message.expectedRevision !== state.revisions[key]) return {ok: false, conflict: true, key, value: visibleValue(key), revision: state.revisions[key], error: '其他文档已更新此记录，请采用最新状态。'};
      const value = validateValue(key, message.value, sender, page);
      const next = clone(state);
      if (key === 'apiKey') next.apiKey = value; else next.values[key] = value;
      next.revisions[key]++;
      await chrome.storage.local.set({[STORE]: next}); state = next;
      if (key === 'apiKey') for (const entry of requests.values()) { entry.reason = 'abort'; entry.controller.abort(); }
      if (key === RUN) stopInvalidRequests();
      void broadcast(key, sender.documentId);
      return {ok: true, key, value: visibleValue(key), revision: state.revisions[key]};
    });
  }
  async function appendTrace(message, sender) {
    return serial(async () => {
      await verifySender(sender);
      const entry = bounded(message.entry, 12000);
      if (!entry || Array.isArray(entry) || typeof entry.kind !== 'string' || entry.kind.length > 200 ||
          typeof entry.time !== 'string' || entry.time.length > 60 || typeof entry.page !== 'string' || entry.page !== new URL(sender.url).origin + new URL(sender.url).pathname ||
          Object.keys(entry).some(key => !['kind', 'detail', 'page', 'time'].includes(key))) throw Error('诊断日志格式无效。');
      const next = clone(state); next.values[TRACE] = [...(state.values[TRACE] || []), entry].slice(-120); next.revisions[TRACE]++;
      await chrome.storage.local.set({[STORE]: next}); state = next; void broadcast(TRACE, sender.documentId);
      return {ok: true, key: TRACE, value: visibleValue(TRACE), revision: state.revisions[TRACE]};
    });
  }
  function optionsSender(sender) {
    if (sender?.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL('options.html')) throw Error('仅扩展配置页能够读写密钥设置。');
  }
  function optionsSnapshot() {
    return {config: visibleValue('config'), hasKey: !!state.apiKey, revisions: {config: state.revisions.config, apiKey: state.revisions.apiKey}};
  }
  async function saveOptions(message, sender) {
    return serial(async () => {
      optionsSender(sender);
      if (Object.keys(message).some(key => !['type', 'config', 'apiKey', 'expectedRevisions'].includes(key)) || !message.expectedRevisions ||
          ['config', 'apiKey'].some(key => !Number.isSafeInteger(message.expectedRevisions[key]) || message.expectedRevisions[key] < 0)) throw Error('配置页提交的版本无效。');
      if (['config', 'apiKey'].some(key => message.expectedRevisions[key] !== state.revisions[key])) return {ok: false, conflict: true, ...optionsSnapshot(), error: '设置已被另一窗口更新，请载入最新设置后再保存。'};
      const config = validateValue('config', message.config, sender, {home: false});
      const key = Object.hasOwn(message, 'apiKey') ? validateValue('apiKey', message.apiKey, sender, {home: false}) : state.apiKey;
      const changed = [];
      if (JSON.stringify(config) !== JSON.stringify(state.values.config)) changed.push('config');
      if (key !== state.apiKey) changed.push('apiKey');
      if (!changed.length) return {ok: true, ...optionsSnapshot()};
      const next = clone(state); next.values.config = config; next.apiKey = key;
      for (const item of changed) next.revisions[item]++;
      if (next.values[RUN]) {
        next.values[RUN] = {...next.values[RUN], enabled: false, owner: null, leaseUntil: 0, updatedAt: Date.now()};
        next.revisions[RUN]++; changed.push(RUN);
      }
      await chrome.storage.local.set({[STORE]: next}); state = next;
      for (const entry of requests.values()) { entry.reason = 'abort'; entry.controller.abort(); }
      for (const item of changed) void broadcast(item, sender.documentId || 'options');
      return {ok: true, ...optionsSnapshot()};
    });
  }
  async function authorize(sender) {
    const page = await verifySender(sender); await ready; await mutations;
    const run = state.values[RUN];
    if (page.home || !run?.enabled || run.complete || run.owner !== sender.documentId || run.leaseUntil <= Date.now() || route(run.courseUrl)?.identity !== page.identity) throw Error('当前文档没有有效的课程运行租约。');
    return page;
  }
  function aiBody(data) {
    if (typeof data === 'string') { if (data.length > 60000) throw Error('AI 请求内容过长。'); data = JSON.parse(data); }
    bounded(data, 60000);
    if (!data || Object.keys(data).some(key => !['model', 'stream', 'max_tokens', 'thinking', 'response_format', 'messages'].includes(key)) ||
        typeof data.model !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(data.model) || data.stream !== false || ![2048, 4096].includes(data.max_tokens) ||
        data.thinking?.type !== 'disabled' || Object.keys(data.thinking).length !== 1 || data.response_format?.type !== 'json_object' || Object.keys(data.response_format).length !== 1 ||
        !Array.isArray(data.messages) || data.messages.length !== 2 || data.messages.some((item, i) => !item || item.role !== ['system', 'user'][i] ||
          typeof item.content !== 'string' || !item.content.trim() || item.content.length > 30000 || Object.keys(item).length !== 2)) throw Error('AI 请求结构不受支持。');
    return {model: data.model, stream: false, max_tokens: data.max_tokens, thinking: {type: 'disabled'}, response_format: {type: 'json_object'},
      messages: data.messages.map(item => ({role: item.role, content: item.content}))};
  }
  function requestKey(sender, id) {
    if (!globalThis.ZhsInputProtocol.isId(id)) throw Error('AI 请求必须有 UUID。');
    return sender.tab.id + ':' + sender.documentId + ':' + id.toLowerCase();
  }
  async function responseText(response) {
    if (!response.body?.getReader) { const text = await response.text(); if (text.length > 1000000) throw Error('AI 响应过大。'); return text; }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    while (true) {
      const {done, value} = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 1000000) { await reader.cancel(); throw Error('AI 响应过大。'); } chunks.push(value);
    }
    const merged = new Uint8Array(size); let at = 0; for (const chunk of chunks) { merged.set(chunk, at); at += chunk.byteLength; }
    return new TextDecoder().decode(merged);
  }
  async function callAI(message, sender) {
    const key = requestKey(sender, message.id), body = aiBody(message.data), page = await authorize(sender);
    const before = Date.now(); for (const [id, until] of cancelled) if (until < before) cancelled.delete(id);
    if (cancelled.has(key)) return {ok: false, kind: 'abort', error: 'AI 请求已取消。'};
    if (seen.has(key)) return {ok: false, kind: 'abort', error: '重复 AI 请求已拒绝。'};
    if (seen.size > 20000) throw Error('AI 请求数量已达到本次后台运行上限。');
    if ([...requests.values()].some(entry => entry.documentId === sender.documentId) || requests.size >= 4) throw Error('已有 AI 请求正在处理。');
    if (!state.apiKey) throw Error('请先配置 DeepSeek API Key。');
    seen.set(key, true);
    const apiKey = state.apiKey, controller = new AbortController();
    const entry = {controller, documentId: sender.documentId, tabId: sender.tab.id, identity: page.identity, reason: null};
    requests.set(key, entry);
    const timer = setTimeout(() => { entry.reason = 'timeout'; controller.abort(); }, 25000);
    try {
      const response = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey}, body: JSON.stringify(body),
        credentials: 'omit', redirect: 'error', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal
      });
      const text = await responseText(response);
      try { await authorize(sender); } catch (_) { entry.reason = 'abort'; throw Error('运行授权已变化。'); }
      if (controller.signal.aborted) throw Error('AI 请求已取消。');
      const retry = String(response.headers?.get('retry-after') || '').replace(/[\r\n]/g, '').slice(0, 100);
      return {ok: true, status: response.status, responseText: text.split(apiKey).join('[密钥已隐藏]'), responseHeaders: retry ? 'retry-after: ' + retry : ''};
    } catch (error) {
      const kind = entry.reason || (controller.signal.aborted ? 'abort' : 'network');
      return {ok: false, kind, error: kind === 'timeout' ? 'DeepSeek 请求超时。' : kind === 'abort' ? 'AI 请求已取消。' : 'DeepSeek 网络请求失败。'};
    } finally { clearTimeout(timer); requests.delete(key); }
  }
  async function abortAI(message, sender) {
    const key = requestKey(sender, message.id); cancelled.set(key, Date.now() + 120000);
    const entry = requests.get(key); if (entry) { entry.reason = 'abort'; entry.controller.abort(); }
    return {ok: true};
  }
  function clearTab(tabId) {
    tabEpoch.set(tabId, (tabEpoch.get(tabId) || 0) + 1);
    for (const [key, client] of clients) if (client.tabId === tabId) { revoked.add(key); clients.delete(key); }
    for (const entry of requests.values()) if (entry.tabId === tabId) { entry.reason = 'abort'; entry.controller.abort(); }
  }
  chrome.tabs.onUpdated.addListener((tabId, info) => { if (info.status === 'loading' || Object.hasOwn(info, 'url')) clearTab(tabId); });
  chrome.tabs.onRemoved.addListener(clearTab);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !['zhs-core-init', 'zhs-core-set', 'zhs-core-trace', 'zhs-core-ai', 'zhs-core-ai-abort', 'zhs-core-options', 'zhs-options-get', 'zhs-options-save'].includes(message.type)) return false;
    (async () => {
      if (message.type === 'zhs-options-get' || message.type === 'zhs-options-save') {
        optionsSender(sender); await ready;
        if (message.type === 'zhs-options-get') { await mutations; return {ok: true, ...optionsSnapshot()}; }
        return saveOptions(message, sender);
      }
      const page = await verifySender(sender); await ready;
      if (message.type === 'zhs-core-init') { await mutations; return {ok: true, ...snapshot(), clientId: sender.documentId}; }
      if (message.type === 'zhs-core-set') return setValue(message, sender, page);
      if (message.type === 'zhs-core-trace') return appendTrace(message, sender);
      if (message.type === 'zhs-core-options') { await chrome.runtime.openOptionsPage(); return {ok: true}; }
      if (page.home) throw Error('首页不提供 AI 接口。');
      if (message.type === 'zhs-core-ai-abort') return abortAI(message, sender);
      return callAI(message, sender);
    })().then(sendResponse, error => sendResponse({ok: false, kind: 'network', error: cleanError(error),
      ...(error?.code === 'DOCUMENT_LOADING' && error.retryable === true ? {code: 'DOCUMENT_LOADING', retryable: true} : {})}));
    return true;
  });
  globalThis.ZhsCore = Object.freeze({authorizeInput: authorize});
})();
