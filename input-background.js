/* 中文说明：只有用户点击扩展图标才能授权；后台只发送固定的正常鼠标输入。 */
(() => {
'use strict';
const P = globalThis.ZhsInputProtocol;
let binding = null, actionQueue = Promise.resolve();
const documents = new Map();
const delay = (promise, ms, label) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(Error(label + '超时；未自动重试。')), ms);
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const messageError = error => String(error?.message || error).slice(0, 240);
function senderPage(sender) {
  if (sender.id !== chrome.runtime.id || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 ||
      typeof sender.documentId !== 'string' || !sender.documentId || !P.course(sender.url) ||
      sender.tab.url !== sender.url) throw Error('消息来源不是合法的共享课顶层文档。');
  return sender;
}
function isBound(b, sender) {
  return b && !b.cancelled && sender.tab.id === b.tabId && sender.documentId === b.documentId && sender.url === b.url;
}
function live(b, job) {
  if (binding !== b || b.cancelled || b.phase !== 'enabled') throw Error('此标签的输入授权已关闭。');
  if (job?.cancelled) throw Error('输入已取消。');
}
async function badge(tabId, text, title) {
  await Promise.allSettled([
    chrome.action.setBadgeText({tabId, text}),
    chrome.action.setBadgeBackgroundColor({tabId, color: text === 'ON' ? '#276749' : '#9b2c2c'}),
    chrome.action.setTitle({tabId, title})
  ]);
}
function finish(b, job, ok, error) {
  if (job.settled) return;
  job.settled = true; clearTimeout(job.timer); b.jobs.delete(job.request.id.toLowerCase());
  job.resolve({id: job.request.id, ok, ...(error ? {error} : {}), enabled: binding === b && b.phase === 'enabled' && !b.cancelled});
}
async function disarm(b, reason, detached = false) {
  if (!b || b.cancelled) return;
  b.cancelled = true; if (binding === b) binding = null;
  for (const job of b.jobs.values()) { job.cancelled = true; finish(b, job, false, reason); }
  b.queue.length = 0;
  const cleanup = [];
  if (b.documentId) cleanup.push(delay(chrome.tabs.sendMessage(b.tabId, {type: 'zhs-input-disarm', nonce: b.nonce},
    {frameId: 0, documentId: b.documentId}), 800, '关闭授权'));
  if (b.attached && !detached) cleanup.push(delay(chrome.debugger.detach({tabId: b.tabId}), 1000, '解除调试连接'));
  cleanup.push(badge(b.tabId, '', '共享课正常输入：点击开启当前标签'));
  await Promise.allSettled(cleanup);
}
async function currentTab(b) {
  const tab = await delay(chrome.tabs.get(b.tabId), 1000, '读取标签');
  if (!tab || tab.url !== b.url || !P.course(tab.url) || tab.status === 'loading') throw Error('标签已导航或正在加载，请在目标课程页重新开启扩展。');
  return tab;
}
function content(b, type, extra = {}, timeout = 2000) {
  return delay(chrome.tabs.sendMessage(b.tabId, {type, nonce: b.nonce, ...extra},
    {frameId: 0, documentId: b.documentId}), timeout, '页面复核');
}
async function enable(tab) {
  if (binding?.tabId === tab.id) { await disarm(binding, '用户关闭了输入授权。'); return; }
  if (binding) await disarm(binding, '用户改为授权另一个标签。');
  const course = P.course(tab.url);
  if (!Number.isInteger(tab.id) || !course || tab.status === 'loading') {
    if (Number.isInteger(tab.id)) await badge(tab.id, '!', '请先打开共享课 stuStudy 课程页，再点击扩展图标。');
    return;
  }
  const b = {tabId: tab.id, url: course.href, courseId: course.courseId, nonce: crypto.randomUUID(), documentId: null,
    phase: 'binding', attached: false, cancelled: false, jobs: new Map(), cancelledIds: new Set(), queue: [], draining: false};
  binding = b;
  try {
    // 由内容脚本回信的浏览器 sender.documentId 确定顶层文档，页面无法提供此标识。
    const ack = await delay(chrome.tabs.sendMessage(b.tabId, {type: 'zhs-input-bind', nonce: b.nonce, href: b.url}, {frameId: 0}), 2500, '绑定文档');
    if (!ack?.ok || !b.documentId || binding !== b || b.cancelled) throw Error(ack?.error || '当前文档绑定已失效。');
    await currentTab(b);
    if (binding !== b || b.cancelled) throw Error('开启前已离开课程页。');
    const attaching = chrome.debugger.attach({tabId: b.tabId}, '1.3').then(async () => {
      b.attached = true;
      if (binding !== b || b.cancelled) await chrome.debugger.detach({tabId: b.tabId}).catch(() => {});
    });
    await delay(attaching, 2500, '开启正常输入');
    if (binding !== b || b.cancelled) {
      await chrome.debugger.detach({tabId: b.tabId}).catch(() => {}); return;
    }
    await currentTab(b);
    const check = await content(b, 'zhs-input-check');
    if (!check?.ok || check.nonce !== b.nonce || check.href !== b.url || binding !== b || b.cancelled) throw Error('授权期间页面发生变化。');
    b.phase = 'enabled'; await badge(b.tabId, 'ON', '共享课正常输入已开启：点击关闭当前标签');
  } catch (error) {
    await disarm(b, messageError(error));
    await badge(b.tabId, '!', '开启失败：' + messageError(error));
  }
}
chrome.action.onClicked.addListener(tab => {
  actionQueue = actionQueue.then(() => enable(tab)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || Object.hasOwn(changeInfo, 'url')) {
    if (binding?.tabId === tabId) void disarm(binding, '页面已导航，输入授权已关闭。');
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  for (const key of documents.keys()) if (key.startsWith(tabId + ':')) documents.delete(key);
  if (binding?.tabId === tabId) void disarm(binding, '标签已关闭。');
});
chrome.debugger.onDetach.addListener(source => {
  if (binding?.tabId === source.tabId) void disarm(binding, '调试连接已停止，请手动重新开启。', true);
});
function remember(sender, id) {
  const key = sender.tab.id + ':' + sender.documentId;
  let ids = documents.get(key);
  if (!ids) { ids = new Set(); documents.set(key, ids); }
  const normalized = id.toLowerCase();
  if (ids.has(normalized)) throw Error('重复请求已拒绝，不会重放输入。');
  if (ids.size >= 20000) throw Error('此文档的请求数量已达到上限，请刷新后重新开启。');
  ids.add(normalized);
}
function coordinates(result) {
  if (!result?.ok) throw Error(result?.error || '页面未通过输入复核。');
  if (result.noop === true) return null;
  const {x, y, width, height} = result;
  if (![x, y, width, height].every(Number.isFinite) || width < 2 || height < 2 || width > 50000 || height > 50000 || x < 0 || y < 0 || x >= width || y >= height) {
    throw Error('页面未返回有效的可视区域坐标。');
  }
  return {x, y};
}
async function mouse(b, job, type, point) {
  live(b, job);
  // 坐标来自隔离内容脚本的两次定位，单位为 CSS 像素；页面不能指定命令或坐标。
  const pressed = type === 'mousePressed';
  try {
    await delay(chrome.debugger.sendCommand({tabId: b.tabId}, 'Input.dispatchMouseEvent', {
      type, x: point.x, y: point.y, button: type === 'mouseMoved' ? 'none' : 'left',
      buttons: pressed ? 1 : 0, ...(type === 'mouseMoved' ? {} : {clickCount: 1}), pointerType: 'mouse'
    }), 1200, '鼠标输入');
  } catch (error) {
    await disarm(b, '鼠标输入未确认完成，授权已关闭；请人工检查页面。' + messageError(error));
    throw error;
  }
}
async function execute(b, job) {
  await globalThis.ZhsCore.authorizeInput(job.sender);
  live(b, job); await currentTab(b); live(b, job);
  job.phase = 'preparing';
  const prepared = await content(b, 'zhs-input-prepare', {request: job.request});
  live(b, job); const a = coordinates(prepared);
  if (!a) return;
  if (!P.isId(prepared.ticket)) throw Error('输入复核票据无效。');
  job.phase = 'moving'; await mouse(b, job, 'mouseMoved', a);
  live(b, job); await currentTab(b); live(b, job);
  await globalThis.ZhsCore.authorizeInput(job.sender);
  live(b, job);
  const confirmed = await content(b, 'zhs-input-confirm', {ticket: prepared.ticket}, 1200);
  live(b, job); const point = coordinates(confirmed);
  if (!point) return;
  if (Math.abs(a.x - point.x) > 0.75 || Math.abs(a.y - point.y) > 0.75) throw Error('点击前的目标位置发生变化。');
  // 最后一次复核后不等待其他动作；按下后不能承诺撤销已经发出的正常输入。
  job.phase = 'pressing'; await mouse(b, job, 'mousePressed', point);
  job.phase = 'releasing'; await mouse(b, job, 'mouseReleased', point);
}
async function drain(b) {
  if (b.draining) return;
  b.draining = true;
  try {
    while (binding === b && !b.cancelled && b.queue.length) {
      const job = b.queue.shift(); if (job.settled || job.cancelled) continue;
      b.active = job;
      try { await execute(b, job); finish(b, job, true); }
      catch (error) { finish(b, job, false, messageError(error)); }
      finally { if (b.active === job) b.active = null; }
    }
  } finally { b.draining = false; }
}
async function requestInput(request, sender) {
  senderPage(sender); request = P.validate(request); remember(sender, request.id);
  const b = binding;
  if (request.kind === 'status') {
    return {id: request.id, ok: true, enabled: !!(isBound(b, sender) && b.phase === 'enabled')};
  }
  if (!isBound(b, sender) || b.phase !== 'enabled') throw Error('请在当前共享课标签点击扩展图标开启正常输入。');
  if (request.kind === 'cancel') {
    const job = b.jobs.get(request.cancelId.toLowerCase());
    if (job && ['pressing', 'releasing'].includes(job.phase)) throw Error('鼠标输入已经开始，不能撤销；请检查页面。');
    // 授权复核也会异步等待；即使尚未登记 job，也要阻止被提前取消的请求随后排队。
    b.cancelledIds.add(request.cancelId.toLowerCase());
    if (job) { job.cancelled = true; finish(b, job, false, '请求已由调用方取消。'); }
    void content(b, 'zhs-input-cancel', {cancelId: request.cancelId}).catch(() => {});
    return {id: request.id, ok: true, enabled: true};
  }
  if (b.jobs.size >= 16) throw Error('待输入请求过多，请等待当前动作结束。');
  await globalThis.ZhsCore.authorizeInput(sender);
  live(b);
  if (b.cancelledIds.has(request.id.toLowerCase())) throw Error('请求已由调用方取消。');
  return new Promise(resolve => {
    const job = {request, sender, resolve, settled: false, cancelled: false, phase: 'queued'};
    job.timer = setTimeout(() => {
      if (job.settled) return;
      job.cancelled = true;
      finish(b, job, false, '输入请求超时；未自动重试。');
      if (b.active === job) void disarm(b, '输入等待超时，授权已关闭。');
    }, 5500);
    b.jobs.set(request.id.toLowerCase(), job); b.queue.push(job); void drain(b);
  });
}
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !['zhs-input-bind-ack', 'zhs-input-leaving', 'zhs-input-request'].includes(message.type)) return false;
  (async () => {
    senderPage(sender);
    if (message.type === 'zhs-input-bind-ack') {
      const b = binding;
      if (!b || b.cancelled || b.phase !== 'binding' || b.tabId !== sender.tab.id || b.url !== sender.url || message.nonce !== b.nonce ||
          (b.documentId && b.documentId !== sender.documentId)) throw Error('文档绑定请求已失效。');
      b.documentId = sender.documentId; return {ok: true};
    }
    if (message.type === 'zhs-input-leaving') {
      if (isBound(binding, sender) && message.nonce === binding.nonce) await disarm(binding, '页面已退出，输入授权已关闭。');
      return {ok: true};
    }
    if (message.type === 'zhs-input-request') return requestInput(message.request, sender);
    throw Error('不支持的扩展消息。');
  })().then(sendResponse, error => sendResponse({id: message.request?.id, ok: false, error: messageError(error), enabled: false}));
  return true;
});
})();
