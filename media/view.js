const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const deviceSel = $('device');
const toggleBtn = $('toggle');
const clearBtn = $('clear');
const logEl = $('log');
const statusEl = $('status');
let DEBUG = true;
function dlog(){ if (!DEBUG) return; try { console.log.apply(console, arguments); } catch(e){} }

function setStatus(t){ statusEl.textContent = t; }

// 当用户停留在底部时才自动跟随到底，否则保持用户当前位置
let autoFollow = true;
let pendingWhileNotFollowing = '';
let queuedAppend = '';
let flushScheduled = false;
function isAtBottom(){
  // 放宽阈值，避免因内容持续增长导致“永远不在底部”的情况
  return (logEl.scrollTop + logEl.clientHeight) >= (logEl.scrollHeight - 40);
}
function enableFollowAndStick(){
  autoFollow = true;
  // 合并未跟随期间的缓冲
  if (pendingWhileNotFollowing) {
    queuedAppend += pendingWhileNotFollowing;
    pendingWhileNotFollowing = '';
    scheduleFlush();
  }
  logEl.scrollTop = logEl.scrollHeight;
  setStatus('已恢复跟随滚动');
  dlog('[follow] manual restore');
}
function scheduleFlush(){
  if (flushScheduled) return;
  flushScheduled = true;
  requestAnimationFrame(() => {
    flushScheduled = false;
    if (!queuedAppend) return;
    const stick = autoFollow && isAtBottom();
    // 以文本节点追加，避免 textContent+= 造成 O(n) 拷贝
    logEl.appendChild(document.createTextNode(queuedAppend));
    dlog('[flush] appended len=', queuedAppend.length, 'stick=', stick);
    queuedAppend = '';
    if (stick) {
      logEl.scrollTop = logEl.scrollHeight;
    }
  });
}
function append(t){
  // 未跟随时不修改 DOM，避免卡顿；先缓冲，提示有新日志
  if (!autoFollow || !isAtBottom()) {
    pendingWhileNotFollowing += t;
    setStatus('已停止跟随滚动（有新日志待合并）');
    dlog('[append] buffered (len+=', t.length, ') totalPending=', pendingWhileNotFollowing.length);
    return;
  }
  // 跟随时汇总追加，下一帧一次性刷新
  queuedAppend += t;
  dlog('[append] queued (len+=', t.length, ') totalQueued=', queuedAppend.length);
  scheduleFlush();
}
function clearLog(){
  // 清空可见日志与前端缓冲
  logEl.textContent = '';
  pendingWhileNotFollowing = '';
  queuedAppend = '';
  flushScheduled = false;
  // 重置跟随状态并滚动到底部（空内容即顶部）
  autoFollow = true;
  logEl.scrollTop = logEl.scrollHeight;
  setStatus('已清空');
  dlog('[click] clear');
  // 通知后端清空其缓冲
  vscode.postMessage({ type: 'clear' });
}
function setDevices(devs){
  deviceSel.innerHTML = '';
  if (!devs || devs.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '未检测到设备';
    deviceSel.appendChild(opt);
    return;
  }
  for (const d of devs){
    const opt = document.createElement('option');
    opt.value = d.serial;
    opt.textContent = d.model ? (d.serial + ' (' + d.model + ')') : d.serial;
    deviceSel.appendChild(opt);
  }
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  switch(msg.type){
    case 'status': setStatus(msg.text); break;
    case 'append': append(msg.text); break;
    case 'devices': setDevices(msg.devices); break;
    case 'debug': DEBUG = !!msg.enabled; dlog('DEBUG set to', DEBUG); break;
    case 'config':
      try {
        if (msg.config) {
          $('pkg').value = msg.config.pkg || '';
          $('tag').value = msg.config.tag || '*';
          $('level').value = msg.config.level || 'D';
          $('buffer').value = msg.config.buffer || 'main';
          const saveEl = document.getElementById('save');
          if (saveEl) saveEl.checked = !!msg.config.save;
          dlog('[config] applied', msg.config);
        }
      } catch (e) {}
      break;
  }
});

// 点击设备下拉框时，如果只有“未检测到设备”，则触发刷新
deviceSel.addEventListener('click', () => {
  if (deviceSel.options.length === 1 && deviceSel.options[0].value === '') {
    dlog('[devices] click -> refresh');
    vscode.postMessage({ type: 'refreshDevices' });
  }
});
// 监听日志区域滚动：离开底部则停止跟随，回到底部则恢复跟随
logEl.addEventListener('scroll', () => {
  const atBottom = isAtBottom();
  if (autoFollow !== atBottom) {
    autoFollow = atBottom;
    if (autoFollow) {
      // 回到底部时合并缓冲并保持跟随
      if (pendingWhileNotFollowing) {
        queuedAppend += pendingWhileNotFollowing;
        dlog('[scroll] merge pending len=', pendingWhileNotFollowing.length);
        pendingWhileNotFollowing = '';
        scheduleFlush();
      }
      setStatus('已恢复跟随滚动');
      dlog('[scroll] follow=true');
    } else {
      setStatus('已停止跟随滚动');
      dlog('[scroll] follow=false');
    }
  }
});

// 快捷恢复：双击日志区域、点击状态栏、按 End 键
logEl.addEventListener('dblclick', () => enableFollowAndStick());
statusEl.addEventListener('click', () => enableFollowAndStick());
window.addEventListener('keydown', (e) => {
  if (e.key === 'End') {
    enableFollowAndStick();
  }
});

let uiPaused = false; // 仅用于按钮文字切换
toggleBtn.addEventListener('click', () => {
  if (uiPaused) {
    // 恢复
    vscode.postMessage({
      type: 'start',
      serial: deviceSel.value,
      pkg: $('pkg').value.trim(),
      tag: $('tag').value.trim(),
      level: $('level').value,
      buffer: $('buffer').value,
      save: document.getElementById('save').checked,
    });
    dlog('[click] resume');
    toggleBtn.textContent = '暂停';
    uiPaused = false;
  } else {
    // 暂停
    vscode.postMessage({ type: 'pause' });
    dlog('[click] pause');
    toggleBtn.textContent = '恢复';
    uiPaused = true;
  }
});

// 绑定清空按钮
clearBtn.addEventListener('click', clearLog);

vscode.postMessage({ type: 'ready' });
// 首帧：避免扩展后台自动启动时按钮文字状态与真实状态不一致
window.addEventListener('load', () => {
  toggleBtn.textContent = uiPaused ? '恢复' : '暂停';
});

