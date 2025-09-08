const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const deviceSel = $('device');
const toggleBtn = $('toggle');
const clearBtn = $('clear');
const logEl = $('log');
const statusEl = $('status');
const filterInput = $('filter');
const matchCaseBtn = $('matchCase');
const softWrapChk = $('softWrap');
let DEBUG = true;
function dlog(){ if (!DEBUG) return; try { console.log.apply(console, arguments); } catch(e){} }

function setStatus(t){ statusEl.textContent = t; }

// 当用户停留在底部时才自动跟随到底，否则保持用户当前位置
let autoFollow = true;
let pendingWhileNotFollowing = '';
let queuedAppend = '';
let flushScheduled = false;
const MAX_LOG_TEXT_LENGTH = 2_000_000; // 最多约 2MB 文本，超过则从头部裁剪
let backlogText = '';
let filterText = '';
let matchCase = false;
let rebuildScheduled = false;
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
    // 更新原始日志备份（用于过滤重建）
    backlogText += queuedAppend;
    if (backlogText.length > MAX_LOG_TEXT_LENGTH) {
      backlogText = backlogText.slice(backlogText.length - MAX_LOG_TEXT_LENGTH);
    }
    // 以文本节点追加，避免 textContent+= 造成 O(n) 拷贝；若有过滤器，则仅追加匹配子集
    const displayChunk = filterText ? filterTextChunk(queuedAppend) : queuedAppend;
    if (displayChunk) {
      logEl.appendChild(document.createTextNode(displayChunk));
    }
    dlog('[flush] appended len=', queuedAppend.length, 'stick=', stick);
    queuedAppend = '';
    // 裁剪过长内容，避免 DOM 与文本无限增长
    if (logEl.textContent && logEl.textContent.length > MAX_LOG_TEXT_LENGTH) {
      const overflow = logEl.textContent.length - MAX_LOG_TEXT_LENGTH;
      // 截断前 N 个字符；为避免打断多字节序列，这里处理纯文本足够安全
      logEl.textContent = logEl.textContent.slice(overflow);
      dlog('[trim] removed', overflow, 'chars');
    }
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
  backlogText = '';
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

// 过滤：输入即刻应用；采用逐帧重建，避免频繁 DOM 重排
function scheduleRebuild(){
  if (rebuildScheduled) return;
  rebuildScheduled = true;
  requestAnimationFrame(() => {
    rebuildScheduled = false;
    const stick = autoFollow && isAtBottom();
    const text = filterText ? filterTextChunk(backlogText) : backlogText;
    logEl.textContent = text;
    if (softWrapChk && softWrapChk.checked) {
      logEl.classList.add('wrap');
    } else {
      logEl.classList.remove('wrap');
    }
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  });
}
function filterTextChunk(text){
  if (!filterText) return text;
  const lines = text.split(/\r?\n/);
  const needle = matchCase ? filterText : filterText.toLowerCase();
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hay = matchCase ? line : line.toLowerCase();
    if (hay.indexOf(needle) !== -1) {
      out += line;
      if (i < lines.length - 1) out += '\n';
    } else {
      if (i < lines.length - 1) {
        // 丢弃该行但保留换行对齐
      }
    }
  }
  return out;
}
filterInput.addEventListener('input', (e) => {
  filterText = String(e.target.value || '');
  try { vscode.setState({ filterText: filterText, matchCase: matchCase }); } catch(e){}
  scheduleRebuild();
});
matchCaseBtn.addEventListener('click', () => {
  matchCase = !matchCase;
  matchCaseBtn.classList.toggle('on', matchCase);
  try { vscode.setState({ filterText: filterText, matchCase: matchCase }); } catch(e){}
  scheduleRebuild();
});

// 换行（Soft-wrap）
softWrapChk.addEventListener('change', () => {
  if (softWrapChk.checked) {
    logEl.classList.add('wrap');
  } else {
    logEl.classList.remove('wrap');
  }
  try {
    const st = vscode.getState && vscode.getState();
    vscode.setState({
      filterText: filterText,
      matchCase: matchCase,
      softWrap: !!softWrapChk.checked,
    });
  } catch(e){}
});

vscode.postMessage({ type: 'ready' });
// 首帧：避免扩展后台自动启动时按钮文字状态与真实状态不一致
window.addEventListener('load', () => {
  toggleBtn.textContent = uiPaused ? '恢复' : '暂停';
  // 恢复过滤器状态
  try {
    const st = vscode.getState && vscode.getState();
    if (st) {
      if (typeof st.filterText === 'string') {
        filterText = st.filterText;
        filterInput.value = st.filterText;
      }
      if (typeof st.matchCase === 'boolean') {
        matchCase = !!st.matchCase;
        matchCaseBtn.classList.toggle('on', matchCase);
      }
      if (typeof st.softWrap === 'boolean') {
        softWrapChk.checked = !!st.softWrap;
        if (softWrapChk.checked) logEl.classList.add('wrap');
      }
      // 初次进入根据状态重建视图
      scheduleRebuild();
    }
  } catch(e){}
});

