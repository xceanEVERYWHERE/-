/* 中文说明：页面只能请求固定的语义动作，不能传入选择器、代码、坐标或调试命令。 */
(() => {
  'use strict';
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const HOST = 'studyvideoh5.zhihuishu.com';
  function course(value) {
    try {
      const url = new URL(value);
      const ids = url.searchParams.getAll('recruitAndCourseId');
      if (url.protocol !== 'https:' || url.host !== HOST || url.username || url.password ||
          !/^\/stuStudy\/?$/.test(url.pathname) || ids.length !== 1 || !ids[0].trim() || ids[0].length > 512) return null;
      return {href: url.href, courseId: ids[0]};
    } catch (_) { return null; }
  }
  function signature(value) {
    if (typeof value !== 'string' || value.length > 30000) return false;
    try {
      const data = JSON.parse(value);
      return Array.isArray(data) && data.length === 2 && typeof data[0] === 'string' &&
        data[0].trim().length > 0 && data[0].length <= 3000 && Array.isArray(data[1]) &&
        data[1].length >= 2 && data[1].length <= 10 && data[1].every(item =>
          typeof item === 'string' && item.trim().length > 0 && item.length <= 2000);
    } catch (_) { return false; }
  }
  function validate(request) {
    if (!request || typeof request !== 'object' || Array.isArray(request) ||
        typeof request.id !== 'string' || !UUID.test(request.id)) throw Error('请求必须带有有效 UUID。');
    const allowed = {
      status: ['id', 'kind'], cancel: ['id', 'kind', 'cancelId'],
      option: ['id', 'kind', 'signature', 'index', 'selected'],
      page: ['id', 'kind', 'signature', 'number'],
      close: ['id', 'kind', 'signature', 'selected'],
      lesson: ['id', 'kind', 'from', 'to'],
    }[request.kind];
    if (!allowed || Object.keys(request).length !== allowed.length ||
        Object.keys(request).some(key => !allowed.includes(key))) throw Error('请求字段或动作不受支持。');
    if (['option', 'page', 'close'].includes(request.kind) && !signature(request.signature)) throw Error('题目签名无效。');
    if (request.kind === 'option' && (!Number.isInteger(request.index) || request.index < 0 || request.index > 9 ||
        typeof request.selected !== 'boolean')) throw Error('选项请求无效。');
    if (request.kind === 'page' && (!Number.isInteger(request.number) || request.number < 1 || request.number > 999)) throw Error('题号无效。');
    if (request.kind === 'close' && (!Array.isArray(request.selected) || request.selected.length < 2 ||
        request.selected.length > 10 || !request.selected.every(value => typeof value === 'boolean'))) throw Error('关闭前的选中状态无效。');
    if (request.kind === 'lesson' && [request.from, request.to].some(value =>
      typeof value !== 'string' || !/^(?:0|[1-9]\d{0,3}):lesson:[^\s\x00-\x1f]{1,80}$/u.test(value))) throw Error('视频目录标识无效。');
    if (request.kind === 'cancel' && (typeof request.cancelId !== 'string' || !UUID.test(request.cancelId) ||
        request.cancelId.toLowerCase() === request.id.toLowerCase())) throw Error('取消请求的目标 ID 无效。');
    return Object.fromEntries(allowed.map(key => [key, Array.isArray(request[key]) ? [...request[key]] : request[key]]));
  }
  globalThis.ZhsInputProtocol = Object.freeze({course, validate, isId: value => typeof value === 'string' && UUID.test(value)});
})();
