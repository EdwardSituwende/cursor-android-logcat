const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const deviceSel = $('device');
const toggleBtn = $('toggle');
const clearBtn = $('clear');
const exportBtn = $('export');
const importBtn = $('import');
const scrollEndBtn = $('scrollEnd');
const logEl = $('log');
const statusEl = $('status');
const filterInput = $('filter');
const clearFilterBtn = $('clearFilter');
const matchCaseBtn = $('matchCase');
const softWrapBtn = $('softWrapBtn');
let DEBUG = true;
let importMode = false;
let importName = '';
function dlog(){ if (!DEBUG) return; try { console.log.apply(console, arguments); } catch(e){} }

function setStatus(t){ statusEl.textContent = t; }

function applyPausedStateFromStatus(statusText){
  try {
    if (typeof statusText !== 'string') return;
    if (statusText.indexOf('已暂停') !== -1 || statusText.indexOf('立即暂停') !== -1) {
      uiPaused = true;
      setToggleUi(true);
      return;
    }
    if (statusText.indexOf('已恢复') !== -1 || statusText.indexOf('启动:') !== -1) {
      uiPaused = false;
      setToggleUi(false);
      return;
    }
  } catch(e){}
}
// 当用户停留在底部时才自动跟随到底，否则保持用户当前位置
let autoFollow = true;
let pendingWhileNotFollowing = '';
let queuedAppend = '';
let flushScheduled = false;
const MAX_LOG_TEXT_LENGTH = 2_000_000; // 最多约 2MB 文本，超过则从头部裁剪
const STATE_MAX_TEXT_LENGTH = 800_000; // 状态存储的最大文本长度（避免过大占用）
let backlogText = '';
let filterText = '';
let matchCase = false;
let rebuildScheduled = false;
// 解析后的过滤表达式：OR 的每项是 AND 词数组
let filterAst = null; // Array<Array<string>> | null
let historyLoaded = false;
let saveStateScheduled = false;
// 颜色渲染：转义与按行着色
function escapeHtml(s){
  return s.replace(/[&<>"']/g, (ch) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;','\'':'&#39;'}[ch]));
}
function detectLevel(line){
  // 兼容多种 logcat 输出格式：
  // 1) time:  09-09 10:25:55.407  PID TID  W  TAG: msg
  // 2) brief: W/TAG( PID ): msg
  // 3) threadtime 等其它变体
  // 优先匹配 “<level>/<tag>”
  let m = line.match(/(?:^|\s)([VDIWEFS])\/[\w$.:-]+/);
  if (m && m[1]) return m[1].toLowerCase();
  // 回退：匹配独立的单字母 level token（周围为空白）
  m = line.match(/(?:^|\s)([VDIWEFS])(?:\s|$)/);
  if (m && m[1]) return m[1].toLowerCase();
  return '';
}
function renderHtmlFromText(text){
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  let html = '';
  for (let i = 0; i < lines.length; i++){
    const line = lines[i];
    if (line === '' && i === lines.length - 1) break; // 末尾空行避免多余节点
    const lv = detectLevel(line);
    const cls = lv ? (' lv-' + lv) : '';
    html += '<span class="' + cls.trim() + '">' + escapeHtml(line) + '</span>\n';
  }
  return html;
}
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
      // 追加高亮 HTML
      logEl.insertAdjacentHTML('beforeend', renderHtmlFromText(displayChunk));
    }
    dlog('[flush] appended len=', queuedAppend.length, 'stick=', stick);
    queuedAppend = '';
    // 若超长，直接基于 backlog 重建，避免混合裁剪破坏标记
    if (backlogText.length >= MAX_LOG_TEXT_LENGTH) {
      const text = filterText ? filterTextChunk(backlogText) : backlogText;
      logEl.innerHTML = renderHtmlFromText(text);
    }
    // 持久化前端状态
    scheduleSaveState();
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
  logEl.innerHTML = '';
  pendingWhileNotFollowing = '';
  queuedAppend = '';
  flushScheduled = false;
  backlogText = '';
  historyLoaded = false;
  // 重置跟随状态并滚动到底部（空内容即顶部）
  autoFollow = true;
  logEl.scrollTop = logEl.scrollHeight;
  setStatus('已清空');
  dlog('[click] clear');
  // 通知后端清空其缓冲
  vscode.postMessage({ type: 'clear' });
  // 持久化前端状态
  scheduleSaveState();
}
function buildSuggestedFilename(){
  const serial = (deviceSel && deviceSel.value) ? deviceSel.value : 'device';
  const dt = new Date();
  const pad = (n) => String(n).padStart(2,'0');
  const name = 'AndroidLog-' + serial + '-' + dt.getFullYear() + pad(dt.getMonth()+1) + pad(dt.getDate()) + '-' + pad(dt.getHours()) + pad(dt.getMinutes()) + pad(dt.getSeconds()) + '.txt';
  return name.replace(/\s+/g,'_');
}
function truncateMiddle(name, maxLen){
  try {
    const s = String(name || '');
    if (s.length <= maxLen) return s;
    const head = Math.ceil((maxLen - 3) / 2);
    const tail = Math.floor((maxLen - 3) / 2);
    return s.slice(0, head) + '...' + s.slice(s.length - tail);
  } catch { return name; }
}
function getFullLogText(){
  // 合并 backlog + 未刷新的 queued + 未跟随期间的 pending
  let text = backlogText || '';
  if (queuedAppend) text += queuedAppend;
  if (pendingWhileNotFollowing) text += pendingWhileNotFollowing;
  return text;
}
function exportLogs(){
  const text = getFullLogText();
  if (!text) { setStatus('当前无日志可导出'); return; }
  const suggested = buildSuggestedFilename();
  vscode.postMessage({ type: 'exportLogs', text: text, suggested: suggested });
}
function setDevices(devs, defaultSerial){
  deviceSel.innerHTML = '';
  if (!devs || devs.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = importMode && importName ? importName : '未检测到设备';
    deviceSel.appendChild(opt);
    return;
  }
  // 在线优先排序
  const score = (d) => {
    const s = (d && d.status) ? String(d.status).toLowerCase() : '';
    if (!s || s === 'device') return 0; // online
    if (s === 'unauthorized') return 2;
    return 1; // offline / unknown
  };
  const sorted = [...devs].sort((a,b) => score(a) - score(b));
  for (const d of sorted){
    const opt = document.createElement('option');
    opt.value = d.serial;
    const base = d.model ? (d.serial + '(' + d.model + ')') : d.serial;
    const s = (d && d.status) ? String(d.status).toLowerCase() : '';
    let suffix = '';
    if (s && s !== 'device') {
      if (s === 'offline') suffix = '-OFFLINE';
      else if (s === 'unauthorized') suffix = '-UNAUTHORIZED';
      else suffix = '-' + s.toUpperCase();
    }
    opt.textContent = base + suffix;
    deviceSel.appendChild(opt);
  }
  if (defaultSerial) {
    try { deviceSel.value = defaultSerial; } catch(e){}
  }
  if (importMode && importName) {
    // 导入模式：在首位插入导入文件项并选中
    try {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = importName;
      deviceSel.insertBefore(opt, deviceSel.firstChild);
      deviceSel.value = '';
    } catch(e){}
  }
  // 若状态中保存过设备，优先恢复该选择
  try {
    const st = vscode.getState && vscode.getState();
    if (st && st.device) {
      try { deviceSel.value = st.device; } catch(e){}
    }
  } catch(e){}
  // 设备选择也持久化一次
  scheduleSaveState();
  // 切回面板后设备列表到位：若尚未加载历史，则拉取一次
  if (!historyLoaded && deviceSel.value) {
    dlog('[history] request after devices');
    vscode.postMessage({ type: 'requestHistory', serial: deviceSel.value });
  }
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  switch(msg.type){
    case 'status': setStatus(msg.text); applyPausedStateFromStatus(msg.text); break;
    case 'append': append(msg.text); break;
    case 'devices': setDevices(msg.devices, msg.defaultSerial); break;
    case 'importDump':
      // 导入文本：清空现有显示与缓存，直接渲染导入内容
      backlogText = msg.text || '';
      historyLoaded = true;
      scheduleRebuild();
      break;
    case 'importMode':
      importMode = true;
      importName = truncateMiddle(String(msg.name || 'Imported.txt'), 48);
      // 置灰暂停按钮
      toggleBtn.setAttribute('disabled', 'true');
      toggleBtn.classList.add('disabled');
      setStatus('已进入导入模式');
      // 用导入项刷新设备列表顶部显示
      setDevices([], '');
      break;
    case 'debug': DEBUG = !!msg.enabled; dlog('DEBUG set to', DEBUG); break;
    case 'visible':
      // 面板重新可见：若还没有缓存，则尝试拉取一次历史
      if (!historyLoaded && deviceSel.value) {
        dlog('[history] request on visible');
        vscode.postMessage({ type: 'requestHistory', serial: deviceSel.value });
      }
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

deviceSel.addEventListener('change', () => {
  // 用户切换设备：清空显示，告知后端切换实时流，并拉取该设备历史
  backlogText = '';
  logEl.innerHTML = '';
  historyLoaded = false;
  if (importMode) {
    // 退出导入模式，恢复可交互
    importMode = false;
    importName = '';
    toggleBtn.removeAttribute('disabled');
    toggleBtn.classList.remove('disabled');
    // 通知后端取消导入状态
    try { vscode.postMessage({ type: 'status', text: '退出导入模式' }); } catch(e){}
  }
  if (deviceSel.value) {
    dlog('[device] select -> switch stream and request history');
    vscode.postMessage({ type: 'selectDevice', serial: deviceSel.value });
    vscode.postMessage({ type: 'requestHistory', serial: deviceSel.value });
  }
  scheduleSaveState();
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
function setToggleUi(paused){
  const iconPause = document.getElementById('iconPause');
  const iconPlay = document.getElementById('iconPlay');
  const toggleLabel = document.getElementById('toggleLabel');
  if (importMode) {
    // 导入模式：强制显示为“暂停”且禁用
    if (iconPause) iconPause.classList.remove('hidden');
    if (iconPlay) iconPlay.classList.add('hidden');
    if (toggleLabel) toggleLabel.textContent = '暂停';
    toggleBtn.setAttribute('aria-label', '暂停');
    toggleBtn.setAttribute('title', '暂停');
    toggleBtn.setAttribute('disabled', 'true');
    return;
  }
  if (paused) {
    if (iconPause) iconPause.classList.add('hidden');
    if (iconPlay) iconPlay.classList.remove('hidden');
    if (toggleLabel) toggleLabel.textContent = '恢复';
    toggleBtn.setAttribute('aria-label', '恢复');
    toggleBtn.setAttribute('title', '恢复');
  } else {
    if (iconPause) iconPause.classList.remove('hidden');
    if (iconPlay) iconPlay.classList.add('hidden');
    if (toggleLabel) toggleLabel.textContent = '暂停';
    toggleBtn.setAttribute('aria-label', '暂停');
    toggleBtn.setAttribute('title', '暂停');
  }
}

toggleBtn.addEventListener('click', () => {
  if (uiPaused) {
    // 恢复
    vscode.postMessage({
      type: 'start',
      serial: deviceSel.value,
      // save option removed
    });
    dlog('[click] resume');
    // 实际文案切换在收到“已恢复/启动”状态后处理
  } else {
    // 暂停
    vscode.postMessage({ type: 'pause' });
    dlog('[click] pause');
    // 实际文案切换在收到“已暂停”状态后处理
  }
});

// 绑定清空与导出按钮
clearBtn.addEventListener('click', clearLog);
if (exportBtn) {
  exportBtn.addEventListener('click', () => exportLogs());
}
if (importBtn) {
  importBtn.addEventListener('click', () => {
    // 进入导入流程：任何正在运行的抓取由后端负责停止
    vscode.postMessage({ type: 'importLogs' });
  });
}
if (clearFilterBtn) {
  const doClear = () => {
    filterInput.value = '';
    filterText = '';
    compileFilterAst(filterText);
    scheduleSaveState();
    scheduleRebuild();
    try { filterInput.parentElement.classList.remove('has-value'); } catch(e){}
    setStatus('已清除过滤');
  };
  clearFilterBtn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    doClear();
  });
  filterInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (filterText && filterText.trim())) {
      e.preventDefault();
      doClear();
    }
  });
}
if (scrollEndBtn) {
  scrollEndBtn.addEventListener('click', () => enableFollowAndStick());
}

// 过滤：输入即刻应用；采用逐帧重建，避免频繁 DOM 重排
function scheduleRebuild(){
  if (rebuildScheduled) return;
  rebuildScheduled = true;
  requestAnimationFrame(() => {
    rebuildScheduled = false;
    const stick = autoFollow && isAtBottom();
    const text = filterText ? filterTextChunk(backlogText) : backlogText;
    logEl.innerHTML = renderHtmlFromText(text);
    // 导入模式默认开启软换行
    if (importMode) {
      logEl.classList.add('wrap');
      if (softWrapBtn) {
        softWrapBtn.setAttribute('aria-pressed','true');
      }
    }
    if (softWrapBtn && softWrapBtn.getAttribute('aria-pressed') === 'true') {
      logEl.classList.add('wrap');
    } else {
      logEl.classList.remove('wrap');
    }
    if (stick) logEl.scrollTop = logEl.scrollHeight;
  });
}
function filterTextChunk(text){
  if (!filterText || !filterAst || filterAst.length === 0) return text;
  const lines = text.split(/\r?\n/);
  let out = '';
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hay = matchCase ? line : line.toLowerCase();
    if (lineMatchesAst(hay)) {
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
function lineMatchesAst(hay){
  // OR 组：任一组满足（组内为 AND）
  for (let gi = 0; gi < filterAst.length; gi++){
    const andTerms = filterAst[gi];
    let all = true;
    for (let ti = 0; ti < andTerms.length; ti++){
      if (hay.indexOf(andTerms[ti]) === -1) { all = false; break; }
    }
    if (all) return true;
  }
  return false;
}
function compileFilterAst(raw){
  if (!raw) { filterAst = null; return; }
  const src = matchCase ? raw : raw.toLowerCase();
  const orParts = src.split('|');
  const ast = [];
  for (let i = 0; i < orParts.length; i++){
    const part = orParts[i].trim();
    if (!part) continue;
    const andTerms = part.split(/\s+/).filter(Boolean);
    if (andTerms.length > 0) ast.push(andTerms);
  }
  filterAst = ast.length > 0 ? ast : null;
}
function scheduleSaveState(){
  if (saveStateScheduled) return;
  saveStateScheduled = true;
  requestAnimationFrame(() => {
    saveStateScheduled = false;
    try {
      let textForState = backlogText || '';
      if (textForState.length > STATE_MAX_TEXT_LENGTH) {
        textForState = textForState.slice(textForState.length - STATE_MAX_TEXT_LENGTH);
      }
      const softWrap = !!(softWrapChk && softWrapChk.checked);
      const device = (deviceSel && deviceSel.value) ? deviceSel.value : '';
      vscode.setState({
        filterText: filterText,
        matchCase: matchCase,
        softWrap: softWrap,
        device: device,
        historyLoaded: !!historyLoaded,
        backlogText: textForState,
      });
    } catch(e){}
  });
}
filterInput.addEventListener('input', (e) => {
  filterText = String(e.target.value || '');
  compileFilterAst(filterText);
  scheduleSaveState();
  scheduleRebuild();
  // 若当前 backlog 为空，尝试从设备拉取历史日志供过滤
  if (!backlogText) {
    vscode.postMessage({ type: 'requestHistory', serial: deviceSel.value });
  }
  try {
    const wrap = filterInput.parentElement;
    if (wrap && wrap.classList) {
      if (filterText && filterText.trim()) wrap.classList.add('has-value');
      else wrap.classList.remove('has-value');
    }
  } catch(e){}
});
matchCaseBtn.addEventListener('click', () => {
  matchCase = !matchCase;
  matchCaseBtn.classList.toggle('on', matchCase);
  matchCaseBtn.setAttribute('aria-pressed', matchCase ? 'true' : 'false');
  // 大小写变化会影响编译
  compileFilterAst(filterText);
  scheduleSaveState();
  scheduleRebuild();
});

// 换行（Soft-wrap）
if (softWrapBtn) {
  softWrapBtn.addEventListener('click', () => {
    const current = softWrapBtn.getAttribute('aria-pressed') === 'true';
    const next = !current;
    softWrapBtn.setAttribute('aria-pressed', next ? 'true' : 'false');
    if (next) logEl.classList.add('wrap'); else logEl.classList.remove('wrap');
    scheduleSaveState();
  });
}

vscode.postMessage({ type: 'ready' });
// 首帧：避免扩展后台自动启动时按钮文字状态与真实状态不一致
window.addEventListener('load', () => {
  // 恢复过滤器状态
  try {
    const st = vscode.getState && vscode.getState();
    if (st) {
      if (typeof st.filterText === 'string') {
        filterText = st.filterText;
        filterInput.value = st.filterText;
        compileFilterAst(filterText);
      }
      if (typeof st.matchCase === 'boolean') {
        matchCase = !!st.matchCase;
        matchCaseBtn.classList.toggle('on', matchCase);
        matchCaseBtn.setAttribute('aria-pressed', matchCase ? 'true' : 'false');
      }
      if (typeof st.softWrap === 'boolean') {
        const on = !!st.softWrap;
        if (softWrapBtn) softWrapBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (on) logEl.classList.add('wrap');
      }
      if (typeof st.backlogText === 'string' && st.backlogText) {
        backlogText = st.backlogText;
        historyLoaded = !!st.historyLoaded || true;
      }
      // 初次进入根据状态重建视图
      scheduleRebuild();
    }
  } catch(e){}
  // 初始化切换按钮 UI（默认显示“暂停”）
  setToggleUi(uiPaused);
});

// 接收后端下发的历史日志转储
window.addEventListener('message', (e) => {
  const msg = e.data;
  if (msg && msg.type === 'historyDump') {
    backlogText = msg.text || '';
    historyLoaded = true;
    scheduleRebuild();
  }
});

