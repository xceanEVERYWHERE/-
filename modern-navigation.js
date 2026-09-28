/* 智慧课程固定切课桥：仅在 MAIN 环境读取当前 VideoCom 的公开接口，不接受代码或选择器。 */
(() => {
  'use strict';
  const REQUEST = 'data-zhs-modern-navigation-request';
  const RESPONSE = 'data-zhs-modern-navigation-response';
  const METHOD = 'VideoCom.exposed.nextVideo';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const KEY = /^(?:0|[1-9]\d{0,3}):lesson:\d+(?:\.\d+)+$/;
  const LESSON = '.chapter-item, .chapter-content-second';
  const CURRENT = '.current, .current_play, [aria-current="true"]';
  const ids = new Set(), media = new WeakMap();
  let lastIssued = null, issuing = false;
  const all = (selector, root = document) => [...root.querySelectorAll(selector)];
  const text = element => (element?.innerText || element?.textContent || '').replace(/\s+/g, ' ').trim();
  function course() {
    try {
      const url = new URL(location.href), values = url.searchParams.getAll('recruitAndCourseId');
      if (url.protocol !== 'https:' || url.host !== 'wisdom-mooc.zhihuishu.com' || url.username || url.password ||
          !/^\/study\/index\/?$/.test(url.pathname) || values.length !== 1 || !values[0].trim() || values[0].length > 512) return null;
      return values[0];
    } catch (_) { return null; }
  }
  const initialCourse = course();
  if (window !== top || !initialCourse) return;
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
  function blockers() {
    const controls = '.ai-class-exercise-dialog, .el-dialog, .el-message-box, .masterylevel-body, input[type="password"], .login-dialog, .login-modal, .geetest_panel, .geetest_holder, .geetest_window, .yidun_popup, .yidun_panel, .nc-container, .nc_wrapper, .captcha, .captcha-dialog';
    if (all(controls).some(visible) || all('iframe').some(frame => visible(frame) &&
      /captcha|geetest|yidun|验证码|安全验证/i.test((frame.getAttribute('src') || '') + ' ' + (frame.title || '')))) {
      throw Error('当前存在弹题、登录或安全验证，未执行切课。');
    }
  }
  function catalogue() {
    let groups = all('.el-collapse-item').filter(element => element.querySelector('.chapter-content') || element.querySelector(LESSON) ||
      /^第.{1,12}章/.test(text(element.querySelector('.el-collapse-item__header, [id^="el-collapse-head-"]'))));
    if (!groups.length) groups = all('.chapter-content').filter(element => !element.parentElement?.closest('.chapter-content'));
    const rows = groups.flatMap((group, chapter) => all(LESSON, group).filter(element => !element.querySelector(LESSON))
      .filter(element => /^\d+(?:\.\d+)+\s*\S/.test(text(element))).map(element => ({
        element, chapter, key: chapter + ':lesson:' + text(element).match(/^\d+(?:\.\d+)+/)[0]
      })));
    if (!rows.length || rows.length > 10000 || new Set(rows.map(row => row.key)).size !== rows.length) throw Error('视频目录缺失或标识重复。');
    const current = rows.filter(row => row.element.matches(CURRENT) || row.element.querySelector(CURRENT));
    if (current.length !== 1 || !visible(current[0].element)) throw Error('当前播放小节未唯一显示。');
    const index = rows.indexOf(current[0]);
    return {current: current[0], next: rows[index + 1] || null};
  }
  function player() {
    const containers = all('#container').filter(visible);
    if (containers.length !== 1) throw Error('当前播放器容器不唯一。');
    const container = containers[0], root = container.closest('.video-com');
    const videos = all('video').filter(visible), tree = document.querySelector('#app')?._vnode;
    if (!root || !tree || videos.length !== 1 || !container.contains(videos[0])) throw Error('当前播放器与可见视频不匹配。');
    const queue = [{vnode: tree, depth: 0}], seen = new WeakSet(), matches = new Set();
    const enqueue = (vnode, depth) => {
      if (!vnode || typeof vnode !== 'object' || seen.has(vnode)) return;
      if (depth > 80 || queue.length >= 3000) throw Error('播放器组件树超过检查范围。');
      queue.push({vnode, depth});
    };
    for (let index = 0; index < queue.length; index++) {
      const {vnode, depth} = queue[index];
      if (!vnode || typeof vnode !== 'object' || seen.has(vnode)) continue;
      seen.add(vnode);
      const component = vnode.component;
      if (component) {
        if (component.isUnmounted || component.isDeactivated) continue;
        const exposed = component.exposed;
        if (component.type?.__name === 'VideoCom' && component.subTree?.el === root &&
            ['nextVideo', 'setData', 'initVideo'].every(name => typeof exposed?.[name] === 'function')) matches.add(component);
        enqueue(component.subTree, depth + 1);
      }
      if (Array.isArray(vnode.children)) for (const child of vnode.children) enqueue(child, depth + 1);
      enqueue(vnode.suspense?.activeBranch, depth + 1);
    }
    if (matches.size !== 1) throw Error('未唯一找到当前播放器的 nextVideo 接口。');
    const component = [...matches][0], video = videos[0];
    if (!media.has(video)) {
      const state = {loads: 0}; media.set(video, state);
      video.addEventListener('loadstart', () => { state.loads++; });
    }
    return {container, root, component, exposed: component.exposed, nextVideo: component.exposed.nextVideo,
      video, src: video.currentSrc, loads: media.get(video).loads, duration: video.duration};
  }
  function validate(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) || typeof request.id !== 'string' || !UUID.test(request.id)) throw Error('请求标识无效。');
    const allowed = request.kind === 'status' ? ['id', 'kind'] : request.kind === 'next' ? ['id', 'kind', 'from', 'to'] : null;
    if (!allowed || Object.keys(request).length !== allowed.length || Object.keys(request).some(key => !allowed.includes(key))) throw Error('不支持的切课请求字段。');
    if (request.kind === 'next' && [request.from, request.to].some(value => typeof value !== 'string' || value.length > 120 || !KEY.test(value))) throw Error('视频目录标识无效。');
    return request;
  }
  function sameMedia(a, b) {
    return a.video === b.video && a.src === b.src && a.loads === b.loads && Object.is(a.duration, b.duration);
  }
  function sameSource(a, b) {
    return a.video === b.video && a.src === b.src && a.loads === b.loads;
  }
  function snapshot() {
    if (course() !== initialCourse) throw Error('课程地址已变化，请刷新目标课程页。');
    return {api: player(), directory: catalogue()};
  }
  function checkNext(request, state) {
    blockers();
    const {api, directory: {current, next}} = state;
    if (current.key !== request.from || !next || next.key !== request.to) throw Error('只允许当前小节的紧邻下一视频。');
    if (!visible(next.element)) throw Error('下一视频尚未显示，请展开目录后重试。');
    if (current.chapter !== next.chapter && (next.chapter !== current.chapter + 1 ||
        (!current.element.matches('.chapter-content-second') && next.element.matches('.chapter-content-second')))) throw Error('当前网站不支持此分组跨章，请手动选择下一节。');
    if (!api.video.ended || api.video.seeking || !Number.isFinite(api.duration) || api.duration <= 0) throw Error('当前视频尚未完整播放结束。');
    if (lastIssued && sameSource(lastIssued, api)) throw Error('上一次切课尚未确认新媒体，未重复调用。');
  }
  function perform(request) {
    const state = snapshot();
    if (request.kind === 'status') return {available: true, method: METHOD, currentKey: state.directory.current.key,
      nextKey: state.directory.next?.key || null, ended: !!state.api.video.ended};
    if (issuing) throw Error('上一次切课调用尚未结束。');
    checkNext(request, state);
    // 调用前再次从真实组件树和目录取值，禁止沿用已被替换的播放器或相邻目标。
    const fresh = snapshot(); checkNext(request, fresh);
    if (fresh.api.component !== state.api.component || fresh.api.exposed !== state.api.exposed ||
        fresh.api.nextVideo !== state.api.nextVideo || fresh.api.container !== state.api.container || !sameMedia(fresh.api, state.api) ||
        fresh.directory.current.element !== state.directory.current.element || fresh.directory.next.element !== state.directory.next.element) throw Error('切课前播放器或目录已变化。');
    issuing = true; lastIssued = fresh.api;
    try {
      const result = Reflect.apply(fresh.api.nextVideo, fresh.api.exposed, []);
      if (result && typeof result.then === 'function') return Promise.resolve(result).then(
        () => ({issued: true, method: METHOD}), () => { throw Error('播放器切课调用失败，未自动重试。'); }).finally(() => { issuing = false; });
      issuing = false; return {issued: true, method: METHOD};
    } catch (_) { issuing = false; throw Error('播放器切课调用失败，未自动重试。'); }
  }
  function publish(id, result, error) {
    const response = error ? {id, ok: false, available: false, error: String(error.message || error).slice(0, 240)} : {id, ok: true, ...result};
    document.documentElement.setAttribute(RESPONSE, JSON.stringify(response));
    document.documentElement.dispatchEvent(new CustomEvent('zhs-modern-navigation-result-v1'));
  }
  document.addEventListener('zhs-modern-navigation-v1', event => {
    if (event.target !== document.documentElement) return;
    const raw = document.documentElement.getAttribute(REQUEST);
    if (!raw || raw.length > 1000) return;
    let request;
    try {
      request = validate(JSON.parse(raw));
      document.documentElement.removeAttribute(REQUEST);
      const id = request.id.toLowerCase();
      if (ids.has(id)) throw Error('重复请求已拒绝。');
      if (ids.size >= 20000) throw Error('本页请求已达上限，请刷新后继续。');
      ids.add(id);
      const result = perform(request);
      if (result && typeof result.then === 'function') result.then(value => publish(request.id, value), error => publish(request.id, null, error));
      else publish(request.id, result);
    } catch (error) {
      if (request?.id && UUID.test(request.id)) publish(request.id, null, error);
    }
  }, true);
})();
