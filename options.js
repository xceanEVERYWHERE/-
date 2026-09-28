// 中文说明：密钥只从扩展设置页写入后台，不回显已保存的密钥。
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  let revisions = null;
  const status = (message, error = false) => { byId('status').textContent = message; byId('status').dataset.error = String(error); };
  const busy = value => document.querySelectorAll('button').forEach(button => { button.disabled = value; });
  function accept(result) {
    if (!result?.ok) throw Error(result?.error || '设置读取或保存失败。');
    revisions = result.revisions;
    byId('model').value = result.config.model;
    for (const key of ['mute','next','autoSubmit']) byId(key).checked = result.config[key];
    byId('keyState').textContent = result.hasKey ? '已保存密钥；留空即可继续使用。' : '尚未保存密钥。关闭自动弹题后也可播放视频。';
  }
  async function load() {
    busy(true);
    try { accept(await chrome.runtime.sendMessage({type:'zhs-options-get'})); status('设置已读取。'); }
    catch (error) { status(error.message,true); }
    finally { busy(false); }
  }
  async function save(clear = false) {
    if (!revisions) { status('请先重新读取设置。',true); return; }
    const config = {model:byId('model').value.trim(), mute:byId('mute').checked, next:byId('next').checked, autoSubmit:byId('autoSubmit').checked};
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(config.model)) { status('模型名称格式不正确。',true); return; }
    const key = byId('apiKey').value.trim();
    const request = {type:'zhs-options-save',config,expectedRevisions:revisions};
    if (clear || key) request.apiKey = clear ? '' : key;
    busy(true); status('正在保存…');
    try {
      accept(await chrome.runtime.sendMessage(request)); byId('apiKey').value = '';
      status(clear ? '密钥已清除。' : '设置已保存。返回课程页，点击“开始”继续。');
    } catch (error) { status(error.message,true); }
    finally { busy(false); }
  }
  byId('settings').addEventListener('submit',event => { event.preventDefault(); void save(); });
  byId('clearKey').addEventListener('click',() => void save(true));
  byId('reload').addEventListener('click',() => void load());
  void load();
})();
