/* 中文说明：运行于扩展隔离环境；页面只描述动作，本文件独立定位和复核当前可见目标。 */
(() => {
  'use strict';
  const P = globalThis.ZhsInputProtocol;
  if (window !== top || !P.course(location.href)) return;
  const tickets = new Map();
  let sessionNonce = null;
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const text = element => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  function visible(element) {
    if (!element?.isConnected || !element.getClientRects().length) return false;
    for (let node = element; node?.nodeType === 1; node = node.parentElement) {
      const style = getComputedStyle(node);
      if (node.hidden || node.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
          style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function actionable(element) {
    if (!visible(element) || element.disabled || element.closest('[disabled], [aria-disabled="true"], .disabled, .is-disabled, .is-loading')) {
      throw Error('目标当前不可见或不可操作。');
    }
  }
  function blockers() {
    const controls = 'input[type="password"], .login-dialog, .login-modal, .geetest_panel, .geetest_holder, .geetest_window, .yidun_popup, .yidun_panel, .nc-container, .nc_wrapper, .captcha, .captcha-dialog, .dialog > .dialog-read, .dialog > .aberrant';
    if (all(controls).some(visible) || all('iframe').some(frame => visible(frame) &&
      /captcha|geetest|yidun|验证码|安全验证/i.test((frame.getAttribute('src') || '') + ' ' + (frame.title || '')))) {
      throw Error('页面存在登录、安全验证或网站异常提示，请先人工处理。');
    }
    if (all('.el-message-box, .el-dialog, [role="alertdialog"]').some(element => visible(element) &&
      /安全验证|验证码|请.*登录|脚本异常|异常脚本|检测到.*(?:脚本|插件|异常)|禁止.*(?:脚本|插件)/.test(text(element)))) {
      throw Error('网站提示需要人工处理，未发送输入。');
    }
  }
  function selected(element) {
    return !!element.querySelector('.topic-option-item.active, .item-topic.active');
  }
  function question() {
    const roots = all('#playTopic-dialog .el-dialog').filter(visible);
    if (roots.length !== 1) throw Error('当前随堂题窗口不唯一或未显示。');
    const root = roots[0], titles = all('.topic-title', root).filter(visible);
    if (titles.length !== 1) throw Error('当前题干容器不唯一。');
    // 网站会在题干前插入判题提示；只拼接固定题型及其紧邻的正文。
    const labels = all(':scope > .title-tit', titles[0]), bodies = all(':scope > .title-tit + span', titles[0]);
    if (labels.length !== 1 || bodies.length !== 1 || !visible(labels[0]) || !visible(bodies[0]) || !text(labels[0]) || !text(bodies[0])) {
      throw Error('题干正文尚未完整显示。');
    }
    const title = text(labels[0]) + ' ' + text(bodies[0]);
    const found = all('.topic-item', root).filter(visible);
    const options = found.filter(element => !found.some(other => other !== element && element.contains(other)));
    if (options.length < 2 || options.length > 10) throw Error('选项数量不受支持。');
    const contents = options.map(element => {
      const nodes = all('.item-topic', element).filter(visible);
      if (nodes.length !== 1 || !text(nodes[0])) throw Error('选项正文不完整。');
      return text(nodes[0]);
    });
    return {root, options, signature: JSON.stringify([title, contents])};
  }
  function lessons() {
    const lists = all('.chapterScrollbar ul.list');
    const rows = lists.flatMap((list, chapter) => {
      const found = all('li.clearfix.video', list).filter(row => row.closest('ul.list') === list && !row.querySelector('li.clearfix.video'));
      return found.filter(row => !row.matches('.test, .exam, .chapter-test, .chapter-exam')).map(row => {
        const hours = all('.cataloguediv-l > .hour', row);
        if (hours.length !== 1) throw Error('目录课时标识不唯一。');
        const hour = text(hours[0]).replace(/\s/g, '');
        if (!hour || hour.length > 80 || /测试|测验|作业|考试/.test(hour)) throw Error('目录包含无法确认的视频条目。');
        return {row, key: chapter + ':lesson:' + hour};
      });
    });
    if (rows.length < 2 || new Set(rows.map(item => item.key)).size !== rows.length) throw Error('视频目录缺失或有重复标识。');
    return rows;
  }
  function locate(request) {
    if (!P.course(location.href)) throw Error('已离开授权课程地址。');
    blockers();
    if (request.kind === 'lesson') {
      if (all('#playTopic-dialog .el-dialog').some(visible)) throw Error('随堂题尚未关闭，未切换视频。');
      const rows = lessons(), current = rows.filter(item => item.row.matches('.current_play') || item.row.querySelector('.current_play'));
      if (current.length !== 1 || current[0].key !== request.from) throw Error('当前视频与请求的起点不一致。');
      const index = rows.findIndex(item => item === current[0]);
      if (rows[index + 1]?.key !== request.to) throw Error('只允许切换到目录中紧邻的下一视频。');
      const videos = all('video').filter(visible);
      if (videos.length !== 1 || videos[0].ended !== true) throw Error('当前视频尚未真实播放结束。');
      const target = rows[index + 1].row;
      actionable(target);
      return {element: target, skip: false};
    }
    const q = question();
    if (q.signature !== request.signature) throw Error('题干或选项已变化，旧请求已取消。');
    if (request.kind === 'option') {
      if (!q.options[request.index]) throw Error('选项序号超出当前题目范围。');
      const element = q.options[request.index]; actionable(element);
      return {element, skip: selected(element) === request.selected};
    }
    if (request.kind === 'page') {
      const candidates = all('.el-pager .number', q.root).filter(element => visible(element) && /^\d+$/.test(text(element)) && Number(text(element)) === request.number);
      if (candidates.length !== 1) throw Error('目标题号未唯一显示。');
      const element = candidates[0]; actionable(element);
      return {element, skip: element.matches('.active, .current, [aria-current="page"]')};
    }
    if (request.kind === 'close') {
      if (request.selected.length !== q.options.length || !q.options.every((element, index) => selected(element) === request.selected[index])) {
        throw Error('关闭前的选中状态发生变化。');
      }
      const buttons = all('.dialog-footer .btn', q.root).filter(element => visible(element) && text(element).replace(/\s/g, '') === '关闭');
      if (buttons.length !== 1) throw Error('关闭按钮未唯一显示。');
      actionable(buttons[0]); return {element: buttons[0], skip: false};
    }
    throw Error('此动作不需要鼠标输入。');
  }
  function point(element) {
    actionable(element);
    const rect = element.getBoundingClientRect();
    const left = Math.max(0, rect.left), right = Math.min(innerWidth, rect.right);
    const top = Math.max(0, rect.top), bottom = Math.min(innerHeight, rect.bottom);
    if (right - left < 2 || bottom - top < 2) throw Error('目标没有可用的可视点击区域。');
    const x = (left + right) / 2, y = (top + bottom) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || (hit !== element && !element.contains(hit))) throw Error('目标被其他元素遮挡，未点击。');
    if (hit.closest('iframe, frame, object, embed')) throw Error('点击区域属于嵌入文档，未发送跨框架输入。');
    return {x, y, width: innerWidth, height: innerHeight};
  }
  function verifySession(message) {
    if (!sessionNonce || message.nonce !== sessionNonce || !P.course(location.href)) throw Error('输入授权已失效。');
  }
  async function prepare(message) {
    verifySession(message); const request = P.validate(message.request);
    const first = locate(request);
    if (first.skip) return {ok: true, noop: true};
    first.element.scrollIntoView({block: 'center', inline: 'center', behavior: 'instant'});
    const a = point(first.element);
    await wait(80);
    verifySession(message);
    const fresh = locate(request);
    if (fresh.skip) return {ok: true, noop: true};
    if (fresh.element !== first.element) throw Error('目标节点已被替换，未点击。');
    const b = point(fresh.element);
    if (Math.abs(a.x - b.x) > 0.75 || Math.abs(a.y - b.y) > 0.75) throw Error('目标仍在移动，未点击。');
    for (const [id, entry] of tickets) if (Date.now() - entry.at > 2500) tickets.delete(id);
    if (tickets.size > 32) throw Error('待核对输入过多，请稍后重试。');
    const ticket = crypto.randomUUID();
    tickets.set(ticket, {request, element: fresh.element, point: b, nonce: sessionNonce, at: Date.now()});
    return {ok: true, noop: false, ticket, ...b};
  }
  function confirm(message) {
    verifySession(message);
    const entry = tickets.get(message.ticket); tickets.delete(message.ticket);
    if (!entry || entry.nonce !== sessionNonce || Date.now() - entry.at > 2500) throw Error('输入复核票据已失效。');
    const fresh = locate(entry.request);
    if (fresh.skip) return {ok: true, noop: true};
    if (fresh.element !== entry.element) throw Error('点击前目标节点已变化。');
    const next = point(fresh.element);
    if (Math.abs(next.x - entry.point.x) > 0.75 || Math.abs(next.y - entry.point.y) > 0.75) throw Error('点击前目标位置已变化。');
    return {ok: true, noop: false, ...next};
  }
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || sender.tab || !message || !['zhs-input-bind', 'zhs-input-disarm', 'zhs-input-check', 'zhs-input-prepare', 'zhs-input-confirm', 'zhs-input-cancel'].includes(message.type)) return false;
    (async () => {
      if (message.type === 'zhs-input-bind') {
        if (!P.isId(message.nonce) || message.href !== location.href || !P.course(location.href)) throw Error('无法绑定当前共享课文档。');
        sessionNonce = message.nonce; tickets.clear();
        const response = await chrome.runtime.sendMessage({type: 'zhs-input-bind-ack', nonce: message.nonce});
        if (!response?.ok) { sessionNonce = null; throw Error('后台未确认文档绑定。'); }
        return {ok: true};
      }
      if (message.type === 'zhs-input-disarm') {
        if (message.nonce === sessionNonce) { sessionNonce = null; tickets.clear(); }
        return {ok: true};
      }
      if (message.type === 'zhs-input-check') { verifySession(message); return {ok: true, nonce: sessionNonce, href: location.href}; }
      if (message.type === 'zhs-input-prepare') return prepare(message);
      if (message.type === 'zhs-input-confirm') return confirm(message);
      if (message.type === 'zhs-input-cancel') {
        verifySession(message);
        for (const [id, entry] of tickets) if (entry.request.id.toLowerCase() === String(message.cancelId).toLowerCase()) tickets.delete(id);
        return {ok: true};
      }
      throw Error('未知扩展消息。');
    })().then(sendResponse, error => sendResponse({ok: false, error: String(error.message || error).slice(0, 240)}));
    return true;
  });
  addEventListener('pagehide', () => {
    const nonce = sessionNonce; sessionNonce = null; tickets.clear();
    if (nonce) void chrome.runtime.sendMessage({type: 'zhs-input-leaving', nonce}).catch(() => {});
  });
})();
