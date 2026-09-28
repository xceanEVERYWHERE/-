// 中文说明：隔离环境适配层。密钥仅送到扩展后台，不进入页面桥或本地缓存。
(() => {
  'use strict';
  const listeners = new Set(), valueListeners = new Set();
  const clone = value => value === undefined ? undefined : structuredClone(value);
  let values = {}, authoritative = {}, revisions = {}, predicted = {}, clientId = null;
  let queue = [], draining = null, writeError = null;
  const broadcasts = [];
  const bootstrapListeners = new Set();
  let bootstrapState = {phase:'waiting',message:'正在连接助手后台…',retryable:false};
  let bootstrapPending = null, bootstrapApi = null, pageGone = false, cancelBootstrapStep = null;
  function bootstrapError(message, code, retryable = false) {
    return Object.assign(Error(message), {code,retryable});
  }
  function reportBootstrap(phase, message, retryable = false) {
    bootstrapState = {phase,message,retryable};
    for (const fn of bootstrapListeners) { try { fn({...bootstrapState}); } catch (_) {} }
  }
  // document_idle 不等于标签页已经 complete；仅重试后台明确标记的加载状态。
  function bootstrapStep(promise, timeout) {
    return new Promise((resolve,reject) => {
      let done = false;
      const finish = (error,value) => {
        if (done) return; done = true; clearTimeout(timer);
        if (cancelBootstrapStep === cancel) cancelBootstrapStep = null;
        error ? reject(error) : resolve(value);
      };
      const cancel = () => finish(bootstrapError('页面已离开，请在当前课程页刷新后启动。','PAGE_GONE'));
      const timer = setTimeout(() => finish(bootstrapError('助手后台响应超时，可以重试启动。','BOOTSTRAP_TIMEOUT',true)),timeout);
      cancelBootstrapStep = cancel;
      if (pageGone) { cancel(); return; }
      Promise.resolve(promise).then(value => finish(null,value),error => finish(error));
    });
  }
  globalThis.addEventListener?.('pagehide', () => { pageGone = true; cancelBootstrapStep?.(); });
  async function initialSnapshot() {
    const deadline = Date.now() + 30000;
    for (let attempt = 0; attempt < 61; attempt++) {
      if (pageGone) throw bootstrapError('页面已离开，请刷新当前课程页。','PAGE_GONE');
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      const initial = await bootstrapStep(chrome.runtime.sendMessage({type:'zhs-core-init'}),Math.min(8000,remaining));
      if (pageGone) throw bootstrapError('页面已离开，请刷新当前课程页。','PAGE_GONE');
      if (initial?.ok && initial.clientId && initial.values && initial.revisions) return initial;
      if (initial?.code !== 'DOCUMENT_LOADING' || initial.retryable !== true) {
        throw bootstrapError(initial?.error || '扩展初始化失败，请刷新课程页。',initial?.code || 'BOOTSTRAP_REJECTED');
      }
      reportBootstrap('waiting','课程页面仍在加载，助手将在就绪后自动显示…');
      const delay = Math.min(500,deadline - Date.now());
      if (delay <= 0) break;
      let timer;
      try { await bootstrapStep(new Promise(resolve => { timer = setTimeout(resolve,delay); }),delay + 1000); }
      finally { clearTimeout(timer); }
    }
    throw bootstrapError('课程页面加载尚未完成。可以稍后重试启动，或刷新页面。','DOCUMENT_LOADING',true);
  }
  const tell = message => { for (const fn of listeners) { try { fn(message); } catch (_) {} } };
  function installValue(key, value, revision) {
    if (!Number.isInteger(revision) || revision < (revisions[key] || 0)) return false;
    authoritative[key] = clone(value); revisions[key] = revision;
    const pending = queue.filter(job => job.key === key && !job.cancelled);
    values[key] = pending.length ? clone(pending[pending.length - 1].visible) : clone(value);
    predicted[key] = Math.max(revision, ...pending.map(job => job.expectedRevision + 1));
    return true;
  }
  function changed(message) {
    if (!clientId) { broadcasts.push(message); return; }
    if (!Object.hasOwn(values, message.key) && !['config','apiKey','zhsVideoRunV1','zhsRunV2','zhsTraceV2'].includes(message.key)) return;
    if (message.revision < (revisions[message.key] || 0)) return;
    const previous = authoritative.zhsVideoRunV1;
    if (message.clientId !== clientId && message.key === 'zhsVideoRunV1') {
      for (const job of queue) if (job.key === message.key) job.cancelled = true;
    }
    if (!installValue(message.key, message.value, message.revision)) return;
    for (const fn of valueListeners) { try { fn(message.key,clone(values[message.key])); } catch (_) {} }
    const fresh = authoritative.zhsVideoRunV1;
    if (message.key === 'zhsVideoRunV1' && previous?.enabled && previous.owner === clientId &&
        (!fresh?.enabled || fresh.id !== previous.id || fresh.owner !== clientId)) tell('运行已由另一页面暂停或接管。');
  }
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || sender.tab || message?.type !== 'zhs-core-changed') return false;
    changed(message); return false;
  });
  async function drain() {
    while (queue.length) {
      const job = queue[0];
      if (job.cancelled) { queue.shift(); continue; }
      try {
        const response = await chrome.runtime.sendMessage({type:'zhs-core-set', key:job.key, value:job.value, expectedRevision:job.expectedRevision});
        if (job.cancelled) {
          queue = queue.filter(item => item !== job);
          if (response?.key) installValue(response.key,response.value,response.revision);
          continue;
        }
        if (!response?.ok) {
          for (const queued of queue) queued.cancelled = true;
          queue = [];
          if (response?.key) installValue(response.key, response.value, response.revision);
          throw Error(response?.error || '扩展设置未保存，请刷新后重新开始。');
        }
        if (queue[0] === job) queue.shift(); else queue = queue.filter(item => item !== job);
        installValue(job.key, response.value, response.revision);
      } catch (error) {
        queue = []; values = clone(authoritative); predicted = {...revisions};
        writeError = Error('本地状态保存失败：' + String(error.message || error)); tell(writeError.message); return;
      }
    }
  }
  function kick() {
    if (!draining) draining = drain().finally(() => { draining = null; if (queue.length) kick(); });
  }
  async function initialize() {
    const initial = await initialSnapshot();
    if (pageGone) throw bootstrapError('页面已离开，请刷新当前课程页。','PAGE_GONE');
    clientId = initial.clientId; values = clone(initial.values); authoritative = clone(initial.values);
    revisions = {...initial.revisions}; predicted = {...revisions};
    for (const message of broadcasts.splice(0)) changed(message);
    const api = {
      clientId,
      onAuthorityLost(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      onValuesChanged(fn) { valueListeners.add(fn); return () => valueListeners.delete(fn); },
      leaseVerified(id, owner) { const run = authoritative.zhsVideoRunV1; return !writeError && run?.enabled && run.id === id && run.owner === owner && owner === clientId && run.leaseUntil > Date.now(); },
      async flush() { while (draining || queue.length) { if (!draining) kick(); await draining; } if (writeError) throw writeError; },
      GM_getValue(key, fallback) { return Object.hasOwn(values,key) ? clone(values[key]) : clone(fallback); },
      GM_setValue(key, value) {
        if (!['config','zhsVideoRunV1','zhsRunV2','zhsTraceV2'].includes(key)) throw Error('请在扩展设置页配置密钥。');
        if (key === 'zhsTraceV2') {
          const entry = Array.isArray(value) ? value[value.length - 1] : null;
          if (!entry) return;
          values[key] = clone(value.slice(-120));
          void chrome.runtime.sendMessage({type:'zhs-core-trace',entry:clone(entry)}).catch(() => {}); return;
        }
        if (writeError) throw writeError;
        const visible = key === 'apiKey' ? (String(value).trim() ? 'configured' : '') : clone(value);
        const expectedRevision = predicted[key] || 0;
        predicted[key] = expectedRevision + 1; values[key] = clone(visible);
        queue.push({key,value:clone(value),visible,expectedRevision,cancelled:false}); kick();
      },
      GM_registerMenuCommand() {},
      GM_setClipboard(value) { return navigator.clipboard.writeText(String(value)); },
      GM_xmlhttpRequest(options) {
        const id = crypto.randomUUID(); let cancelled = false, settled = false, sent = false;
        const finish = (kind, value) => { if (settled) return; settled = true; options[kind]?.(value); };
        void api.flush().then(async () => {
          if (cancelled) return;
          if (options.method !== 'POST' || options.url !== 'https://api.deepseek.com/chat/completions') throw Error('接口不受支持。');
          const data = JSON.parse(options.data); sent = true;
          const result = await chrome.runtime.sendMessage({type:'zhs-core-ai',id,data});
          if (cancelled || settled) return;
          if (!result?.ok) { finish(result?.kind === 'timeout' ? 'ontimeout' : result?.kind === 'abort' ? 'onabort' : 'onerror'); return; }
          finish('onload', {status:result.status, responseText:result.responseText, responseHeaders:result.responseHeaders || ''});
        }).catch(() => { if (!cancelled) finish('onerror'); });
        return {abort() {
          if (cancelled || settled) return; cancelled = true;
          if (sent) void chrome.runtime.sendMessage({type:'zhs-core-ai-abort',id}).catch(() => {});
          finish('onabort');
        }};
      },
      requestInput(request) { return chrome.runtime.sendMessage({type:'zhs-input-request',request}); },
      async openOptions() {
        let timer;
        try {
          const result = await Promise.race([
            chrome.runtime.sendMessage({type:'zhs-core-options'}),
            new Promise((_,reject) => { timer = setTimeout(() => reject(Error('打开设置页响应超时，请检查是否已经打开；也可右击扩展图标选择“选项”。')),8000); })
          ]);
          if (!result?.ok) throw Error(result?.error || '无法打开扩展设置页。');
        } finally { clearTimeout(timer); }
      },
      modernNavigation(request) {
        const root = document.documentElement, id = crypto.randomUUID();
        const requestName = 'data-zhs-modern-navigation-request', responseName = 'data-zhs-modern-navigation-response';
        if (request.kind === 'next') return new Promise((resolve,reject) => {
          let timer;
          const finish = (error,result) => { clearTimeout(timer); root.removeEventListener('zhs-modern-navigation-result-v1',receive); root.removeAttribute(requestName); root.removeAttribute(responseName); error ? reject(error) : resolve(result); };
          const receive = () => {
            let result; try { result = JSON.parse(root.getAttribute(responseName) || 'null'); } catch (_) { return; }
            if (!result || result.id !== id) return;
            finish(result.ok ? null : Error(result.error || '播放器切课未确认。'),result);
          };
          root.addEventListener('zhs-modern-navigation-result-v1',receive);
          timer = setTimeout(() => finish(Error('播放器切课响应超时；未重复调用。')),8000);
          root.removeAttribute(responseName); root.setAttribute(requestName,JSON.stringify({...request,id}));
          root.dispatchEvent(new CustomEvent('zhs-modern-navigation-v1'));
        });
        root.removeAttribute(responseName); root.setAttribute(requestName, JSON.stringify({...request,id}));
        try {
          root.dispatchEvent(new CustomEvent('zhs-modern-navigation-v1'));
          const response = JSON.parse(root.getAttribute(responseName) || 'null');
          if (!response || response.id !== id || !response.ok) throw Error(response?.error || '播放器连接未就绪，请刷新课程页。');
          return response;
        } finally { root.removeAttribute(requestName); root.removeAttribute(responseName); }
      },
    };
    return Object.freeze(api);
  }
  function retry() {
    if (pageGone) return Promise.reject(bootstrapError('页面已离开，请刷新当前课程页。','PAGE_GONE'));
    if (bootstrapApi) return Promise.resolve(bootstrapApi);
    if (bootstrapPending) return bootstrapPending;
    reportBootstrap('waiting','正在连接助手后台…');
    bootstrapPending = initialize().then(api => {
      bootstrapApi = api; reportBootstrap('ready','助手已就绪。'); return api;
    }, error => {
      reportBootstrap(pageGone ? 'cancelled' : 'failed',String(error.message || error),error.retryable === true);
      throw error;
    }).finally(() => { bootstrapPending = null; });
    return bootstrapPending;
  }
  const ready = retry();
  // 内容脚本依次载入，先登记处理器，避免下一文件挂接之前产生未处理拒绝。
  void ready.catch(() => {});
  globalThis.ZhsUnifiedRuntime = Object.freeze({ready,retry,
    onBootstrapState(fn) { bootstrapListeners.add(fn); fn({...bootstrapState}); return () => bootstrapListeners.delete(fn); }
  });
})();
