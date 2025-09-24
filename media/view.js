const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const deviceSel = $('device');
const toggleBtn = $('toggle');
const clearBtn = $('clear');
const exportBtn = $('export');
const importBtn = $('import');
const restartBtn = $('restart');
const scrollEndBtn = $('scrollEnd');
const logEl = $('log');
const findBar = $('findBar');
const findInput = $('findInput');
const findClear = $('findClear');
const findCase = $('findCase');
const findRegex = $('findRegex');
const findCounter = $('findCounter');
const findPrev = $('findPrev');
const findNext = $('findNext');
const statusEl = $('status');
const filterInput = $('filter');
const clearFilterBtn = $('clearFilter');
const matchCaseBtn = $('matchCase');
const softWrapBtn = $('softWrapBtn');
let DEBUG = true;
let currentPackage = '';
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
// 移除大文本持久化，避免状态膨胀导致恢复/切换卡顿
const STATE_MAX_TEXT_LENGTH = 0; // 保留常量但不再使用
let backlogText = '';
let filterText = '';
let matchCase = false;
let rebuildScheduled = false;
// 解析后的过滤表达式：OR 的每项是 AND 词数组
let filterAst = null; // Array<Array<string>> | null
let historyLoaded = false;
let saveStateScheduled = false;
const pidMap = new Map();
let pidMapDirty = false; // pidMap 增量合并标记，配合轻量节流
let pidMapRebuildTimer = null;
// find state
let findVisible = false;
let findMatchCase = false;
let findUseRegex = false;
let findQuery = '';
let findMatches = [];
let findIndex = 0;
let preserveScrollNextRebuild = false;
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
// 格式化输出：日期时间、PID-TID、Tag、Package、Priority、Message
const COL_TAG = 23; // Tag 固定宽度
const COL_PKG = 30; // Package 固定最大宽度（不足补空格，对齐）
const COL_PID = 11; // PID-TID 固定宽度，例如 21347-21569
function padEndFixed(s, n){ s = String(s || ''); return s.length >= n ? s.slice(0, n) : (s + ' '.repeat(n - s.length)); }
function padEndNoCut(s, n){ s = String(s || ''); return s.length >= n ? s : (s + ' '.repeat(n - s.length)); }
function middleEllipsisFixed(s, width){
  s = String(s || '');
  if (s.length <= width) return padEndNoCut(s, width);
  const head = Math.ceil((width - 3) / 2);
  const tail = Math.floor((width - 3) / 2);
  return s.slice(0, head) + '...' + s.slice(s.length - tail);
}
function splitTagAndPkg(tagField){
  const raw = String(tagField || '').trim();
  if (!raw) return { tag: '', pkg: '' };
  const idx = raw.lastIndexOf(' ');
  if (idx > 0) {
    const maybePkg = raw.slice(idx + 1).trim();
    const left = raw.slice(0, idx).trim();
    if (/^[\w.$-]+$/.test(maybePkg) && maybePkg.indexOf('.') !== -1) {
      return { tag: left, pkg: maybePkg };
    }
  }
  return { tag: raw, pkg: '' };
}
function formatDateWithYear(dt){
  // 输入：YYYY-MM-DD HH:MM:SS.mmm 或 MM-DD HH:MM:SS.mmm
  if (!dt) return '';
  if (/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}$/.test(dt)) return dt;
  if (/^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}$/.test(dt)) {
    const y = new Date().getFullYear();
    return y + '-' + dt.replace(/^(\d{2})-(\d{2})/, '$1-$2');
  }
  return dt;
}
function parseLogLine(line){
  // threadtime: 09-13 15:12:53.025 或 2025-09-13 15:12:53.025
  let m = line.match(/^(\d{2,4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+([^:]+):\s*(.*)$/);
  if (m) { const tp = splitTagAndPkg(m[5]); return { dt: formatDateWithYear(m[1]), pid: m[2], tid: m[3], pri: m[4], tag: tp.tag, pkg: tp.pkg, msg: m[6] }; }
  // time: 09-13 15:12:53.025 或 2025-09-13 15:12:53.025  P/TAG( PID ): msg
  m = line.match(/^(\d{2,4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+([VDIWEFS])\/([^\s(]+)\s*\(\s*(\d+)\s*\)\s*:\s*(.*)$/);
  if (m) { const tp = splitTagAndPkg(m[3]); return { dt: formatDateWithYear(m[1]), pid: m[4], tid: '', pri: m[2], tag: tp.tag, pkg: tp.pkg, msg: m[5] }; }
  // brief: P/TAG( PID ): msg
  m = line.match(/^([VDIWEFS])\/([^\s(]+)\s*\(\s*(\d+)\s*\)\s*:\s*(.*)$/);
  if (m) { const tp = splitTagAndPkg(m[2]); return { dt: '', pid: m[3], tid: '', pri: m[1], tag: tp.tag, pkg: tp.pkg, msg: m[4] }; }
  // fallback
  const lv = detectLevel(line).toUpperCase();
  return { dt: '', pid: '', tid: '', pri: lv, tag: '', pkg: '', msg: line };
}
function renderHtmlFromText(text){
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  let html = '';
  for (let i = 0; i < lines.length; i++){
    const line = lines[i];
    if (line === '' && i === lines.length - 1) break; // 末尾空行避免多余节点
    const obj = parseLogLine(line);
    // 未解析为结构化日志（无时间/PID/Tag/Package），例如 Usage/帮助文本/分隔符等：保持原始文本布局
    if (!obj.dt && !obj.pid && !obj.tag && !obj.pkg) {
      html += '<span>' + highlightSegment(line) + '</span>';
      continue;
    }
    const lv = (obj.pri || '').toLowerCase();
    const cls = lv ? (' lv-' + lv) : '';
    const pidTidRaw = obj.pid ? (obj.pid + (obj.tid ? ('-' + obj.tid) : '')) : '';
    const pidTid = padEndNoCut(pidTidRaw, COL_PID);
    const rawTag = obj.tag || '';
    const tag = middleEllipsisFixed(rawTag, COL_TAG);
    let pkgSrc = obj.pkg || '';
    if (!pkgSrc && obj.pid) {
      try {
        const name = pidMap.get(Number(obj.pid));
        if (name) pkgSrc = name;
        else {
          // 主动触发一次按需刷新（后端会节流）
          vscode.postMessage({ type: 'pidMiss', pid: Number(obj.pid) });
        }
      } catch(e){}
    }
    if (!pkgSrc) pkgSrc = currentPackage || '';
    const pkg = middleEllipsisFixed(pkgSrc, COL_PKG);
    const pri = (obj.pri || '').toUpperCase();
    const priBox = pri ? ('<span class="pri pri-' + pri.toLowerCase() + '" title="Priority ' + pri + '">' + pri + '</span>') : '';
    const parts = [obj.dt, pidTid, '<span class="cell-tag" title="' + escapeHtml(rawTag) + '">' + highlightSegment(tag) + '</span>'];
    if (pkg) parts.push('<span class="cell-pkg" title="' + escapeHtml(pkgSrc) + '">' + highlightSegment(pkg) + '</span>');
    parts.push(priBox, highlightSegment(obj.msg || ''));
    const composed = parts.filter(Boolean).join('  ').replace(/\s+$/,'');
    // 每行包裹在块级 <span> 中，便于选择单行（不再追加换行文本节点）
    html += '<span class="' + cls.trim() + '">' + composed + '</span>';
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
// --- Find bar ---
function updateFindCounter(){
  try { findCounter.textContent = (findMatches.length ? (String(findIndex+1) + '/' + String(findMatches.length)) : '0/0'); } catch(e){}
}
function openFind(){
  if (!findBar) return;
  findBar.hidden = false;
  findVisible = true;
  setTimeout(() => { try { findInput.focus(); findInput.select(); } catch(e){} }, 0);
  try { logEl.classList.add('has-find'); } catch(e){}
  // 若已有查询，按照当前可视区域重定位起始命中
  try {
    if (findQuery && findMatches && findMatches.length) {
      alignFindIndexToViewport();
      updateFindCounter();
    }
  } catch(e){}
}
function closeFind(){
  if (!findBar) return;
  findBar.hidden = true;
  findVisible = false;
  try { logEl.classList.remove('has-find'); } catch(e){}
}
function recomputeFind(){
  findQuery = String(findInput.value || '');
  findMatchCase = (findCase.getAttribute('aria-pressed') === 'true');
  findUseRegex = (findRegex.getAttribute('aria-pressed') === 'true');
  findMatches = [];
  findIndex = 0;
  if (!findQuery) { updateFindCounter(); return; }
  try {
    const text = backlogText || '';
    const hay = findMatchCase ? text : text.toLowerCase();
    const needle = findMatchCase ? findQuery : findQuery.toLowerCase();
    if (findUseRegex) {
      const flags = findMatchCase ? 'g' : 'gi';
      const re = new RegExp(findQuery, flags);
      let m; while ((m = re.exec(text))){ findMatches.push({ start: m.index, end: m.index + (m[0] ? m[0].length : 0) }); if (m.index === re.lastIndex) re.lastIndex++; }
    } else {
      let pos = 0; while (true){
        const idx = hay.indexOf(needle, pos);
        if (idx === -1) break;
        findMatches.push({ start: idx, end: idx + needle.length });
        pos = idx + Math.max(1, needle.length);
      }
    }
  } catch(e){}
  updateFindCounter();
  // 保持当前滚动位置；不自动滚到顶部
  preserveScrollNextRebuild = true;
  // 将当前命中对齐到视口
  alignFindIndexToViewport();
  scheduleRebuild();
}
function scrollToFindIndex(){
  if (!findMatches.length) return;
  const m = findMatches[findIndex];
  // 估算行：通过分割索引近似计算
  try {
    const pre = (backlogText || '').slice(0, m.start);
    const lineNum = pre.split(/\n/).length; // 1-based
    const lines = logEl.querySelectorAll('span');
    const target = lines[lineNum - 1];
    if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  } catch(e){}
}
function alignFindIndexToViewport(){
  if (!findMatches.length) return;
  try {
    const scrollTop = logEl.scrollTop;
    const viewBottom = scrollTop + logEl.clientHeight;
    const text = backlogText || '';
    // 通过累计行高近似定位
    let acc = 0; let lineStart = 0; const lines = text.split(/\n/);
    const lineOffsets = new Array(lines.length);
    for (let i = 0; i < lines.length; i++) {
      lineOffsets[i] = acc;
      acc += lines[i].length + 1; // +\n
    }
    // 当前视口对应的起止字符索引（粗略：按 1:1 文本高度映射）
    // 简化：以每行固定高度估算，找出视口中间附近的行，并匹配到最近命中
    const approxLine = Math.max(0, Math.min(lines.length - 1, Math.round((scrollTop / logEl.scrollHeight) * lines.length)));
    const approxOffset = lineOffsets[approxLine] || 0;
    // 找到第一个 >= approxOffset 的命中
    let idx = 0;
    while (idx < findMatches.length && findMatches[idx].start < approxOffset) idx++;
    if (idx >= findMatches.length) idx = findMatches.length - 1;
    findIndex = idx;
  } catch(e){}
}
function setToggle(btn, on){ btn.setAttribute('aria-pressed', on ? 'true' : 'false'); }
if (findClear) findClear.addEventListener('click', () => { findInput.value = ''; recomputeFind(); });
if (findCase) findCase.addEventListener('click', () => { findMatchCase = !findMatchCase; setToggle(findCase, findMatchCase); recomputeFind(); });
if (findRegex) findRegex.addEventListener('click', () => { findUseRegex = !findUseRegex; setToggle(findRegex, findUseRegex); recomputeFind(); });
if (findInput) findInput.addEventListener('input', recomputeFind);
if (findPrev) findPrev.addEventListener('click', () => { if (!findMatches.length) return; findIndex = (findIndex - 1 + findMatches.length) % findMatches.length; updateFindCounter(); scrollToFindIndex(); scheduleRebuild(); });
if (findNext) findNext.addEventListener('click', () => { if (!findMatches.length) return; findIndex = (findIndex + 1) % findMatches.length; updateFindCounter(); scrollToFindIndex(); scheduleRebuild(); });
document.addEventListener('keydown', (e) => {
  // 仅当 Webview 获得焦点时拦截快捷键，阻止冒泡到编辑器
  const isFind = (e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey);
  if (isFind) {
    e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if ((e).stopImmediatePropagation) (e).stopImmediatePropagation();
    openFind();
    return;
  }
  if (e.key === 'Escape' && findVisible) {
    e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if ((e).stopImmediatePropagation) (e).stopImmediatePropagation();
    closeFind();
    return;
  }
  if (!findVisible) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.stopPropagation) e.stopPropagation();
    if ((e).stopImmediatePropagation) (e).stopImmediatePropagation();
    if (!findMatches.length) return;
    if (e.shiftKey) { findIndex = (findIndex - 1 + findMatches.length) % findMatches.length; }
    else { findIndex = (findIndex + 1) % findMatches.length; }
    updateFindCounter();
    scrollToFindIndex();
    scheduleRebuild();
  }
}, true);

function highlightSegment(msg){
  if (!findVisible || !findQuery) return escapeHtml(msg);
  try {
    if (findUseRegex) {
      const flags = findMatchCase ? 'g' : 'gi';
      const re = new RegExp(findQuery, flags);
      let last = 0; let out = '';
      let idx = 0; let m;
      while ((m = re.exec(msg))) {
        const s = m.index; const e = m.index + (m[0] ? m[0].length : 0);
        out += escapeHtml(msg.slice(last, s));
        const cls = pickHlClass(idx++);
        out += '<span class="' + cls + '">' + escapeHtml(msg.slice(s, e)) + '</span>';
        last = e;
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      out += escapeHtml(msg.slice(last));
      return out;
    } else {
      const hay = findMatchCase ? msg : msg.toLowerCase();
      const needle = findMatchCase ? findQuery : findQuery.toLowerCase();
      if (!needle) return escapeHtml(msg);
      let last = 0; let out = '';
      let pos = 0; let idx = 0; let p;
      while ((p = hay.indexOf(needle, pos)) !== -1) {
        out += escapeHtml(msg.slice(last, p));
        const cls = pickHlClass(idx++);
        out += '<span class="' + cls + '">' + escapeHtml(msg.slice(p, p + needle.length)) + '</span>';
        last = p + needle.length;
        pos = last;
      }
      out += escapeHtml(msg.slice(last));
      return out;
    }
  } catch(e) { return escapeHtml(msg); }
}
function pickHlClass(k){
  try {
    if (!findMatches.length) return 'hl';
    return k === (findIndex % Math.max(1, findMatches.length)) ? 'hl-current' : 'hl';
  } catch(e) { return 'hl'; }
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
  // 最终兜底：若依然没有选中任何项，则选择第一个可用设备，避免下拉显示为空
  try {
    if ((!deviceSel.value || deviceSel.selectedIndex < 0) && deviceSel.options && deviceSel.options.length > 0) {
      deviceSel.selectedIndex = 0;
    }
  } catch(e){}
  // 设备选择也持久化一次
  scheduleSaveState();
  // 切回面板后设备列表到位：若尚未加载历史，则拉取一次
  if (!historyLoaded && deviceSel.value) {
    dlog('[history] request after devices');
    vscode.postMessage({ type: 'requestHistory', serial: deviceSel.value });
  }
  // 若首次填充设备后尚未启动过抓取，且此时已有选中设备，则提示一次“准备就绪”
  try {
    if (deviceSel && deviceSel.value && !historyLoaded) {
      setStatus('设备已就绪: ' + deviceSel.value);
    }
  } catch(e){}
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  switch(msg.type){
    case 'status':
      setStatus(msg.text);
      applyPausedStateFromStatus(msg.text);
      try {
        const text = String(msg.text || '');
        if (text.indexOf('已重启') !== -1 && !importMode) {
          // 强力刷新：重新请求历史并刷新设备列表
          if (deviceSel && deviceSel.value) {
            vscode.postMessage({ type: 'requestHistory', serial: deviceSel.value });
          }
          vscode.postMessage({ type: 'refreshDevices' });
        }
        // 导入模式下屏蔽“已退出/已停止/启动”等状态触发的视图/历史变动
        if (importMode && (/已退出|已停止|启动:/.test(text))) {
          return;
        }
      } catch(e){}
      break;
    case 'append':
      if (importMode) {
        // 导入模式下忽略实时追加，保持导入内容静态展示
        break;
      }
      append(msg.text);
      break;
    case 'devices': setDevices(msg.devices, msg.defaultSerial); break;
    case 'pidMap':
      try {
        const map = msg.map || {};
        for (const k in map) { if (Object.prototype.hasOwnProperty.call(map,k)) pidMap.set(Number(k), String(map[k])); }
        // 新的 PID 映射可能影响已渲染行：标记脏并在下一帧/最小时间窗后统一重建，避免抖动
        pidMapDirty = true;
        if (!pidMapRebuildTimer) {
          pidMapRebuildTimer = setTimeout(() => {
            pidMapRebuildTimer = null;
            if (pidMapDirty) {
              pidMapDirty = false;
              scheduleRebuild();
            }
          }, 50); // 50ms 时间窗内的多次更新合并
        }
      } catch(e){}
      break;
    case 'config':
      try { currentPackage = String((msg.config && msg.config.pkg) || ''); } catch(e) { currentPackage = ''; }
      // 包名变化影响整列布局，需要重建
      scheduleRebuild();
      break;
    case 'importDump': {
      // 导入文本：清空现有显示与缓存，直接渲染导入内容
      let text = String(msg.text || '');
      // 对超大导入做尾部截断，避免一次性渲染过大内容导致空白
      const MAX_IMPORT_CHARS = MAX_LOG_TEXT_LENGTH; // 约2MB
      const MAX_IMPORT_LINES = 50000;
      if (text.length > MAX_IMPORT_CHARS) {
        text = text.slice(text.length - MAX_IMPORT_CHARS);
        // 对齐到换行，避免半行开头
        const firstNl = text.indexOf('\n');
        if (firstNl > 0) text = text.slice(firstNl + 1);
      }
      // 进一步限制行数
      try {
        const lines = text.split(/\r?\n/);
        if (lines.length > MAX_IMPORT_LINES) {
          text = lines.slice(lines.length - MAX_IMPORT_LINES).join('\n');
        }
      } catch(e){}
      backlogText = text;
      historyLoaded = true;
      // 重置视图为导入内容（考虑过滤器可能为空或已清空）
      const display = filterText ? filterTextChunk(backlogText) : backlogText;
      logEl.innerHTML = renderHtmlFromText(display);
      // 进入导入后固定开启软换行
      if (softWrapBtn) softWrapBtn.setAttribute('aria-pressed','true');
      logEl.classList.add('wrap');
      // 滚动到底，避免上方残留
      try { logEl.scrollTop = logEl.scrollHeight; } catch(e){}
      // 在状态栏提示
      try { setStatus('已显示导入日志（约 ' + Math.max(0, text.split(/\n/).length - 1) + ' 行）'); } catch(e){}
      break; }
    case 'importMode':
      importMode = true;
      importName = truncateMiddle(String(msg.name || 'Imported.txt'), 48);
      // 置灰：暂停/重启/清空
      toggleBtn.setAttribute('disabled', 'true');
      toggleBtn.classList.add('disabled');
      if (restartBtn) { restartBtn.setAttribute('disabled','true'); restartBtn.classList.add('disabled'); }
      if (clearBtn) { clearBtn.setAttribute('disabled','true'); clearBtn.classList.add('disabled'); }
      // 清理任何未刷新的实时缓冲，避免导入后残留动态日志
      pendingWhileNotFollowing = '';
      queuedAppend = '';
      flushScheduled = false;
  // 清空可见区并重置 backlog，确保导入文本为唯一来源
  logEl.innerHTML = '';
  backlogText = '';
  // 清除过滤条件，避免导入后被旧过滤规则过滤成空
  try {
    filterText = '';
    if (filterInput) filterInput.value = '';
    compileFilterAst(filterText);
    if (filterInput && filterInput.parentElement && filterInput.parentElement.classList) {
      filterInput.parentElement.classList.remove('has-value');
    }
  } catch(e){}
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
      // 可见时若设备选择仍为空或显示“未检测到设备”，主动刷新一次设备列表
      try {
        const onlyOne = deviceSel && deviceSel.options && deviceSel.options.length === 1 ? deviceSel.options[0] : null;
        const emptyShown = onlyOne && !onlyOne.value && /未检测到设备/.test(String(onlyOne.textContent || ''));
        if (!deviceSel || !deviceSel.options || deviceSel.options.length === 0 || emptyShown) {
          dlog('[devices] visible -> refresh because empty');
          vscode.postMessage({ type: 'refreshDevices' });
        }
      } catch(e){}
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
    if (restartBtn) { restartBtn.removeAttribute('disabled'); restartBtn.classList.remove('disabled'); }
    if (clearBtn) { clearBtn.removeAttribute('disabled'); clearBtn.classList.remove('disabled'); }
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
  if (importMode) return;
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

// Restart：停止并基于当前选择与上次配置重新启动
if (restartBtn) {
  restartBtn.addEventListener('click', () => {
    if (importMode) return;
    setStatus('正在重启…');
    vscode.postMessage({ type: 'restart', serial: deviceSel.value });
    dlog('[click] restart');
  });
}

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
    const prevScrollTop = preserveScrollNextRebuild ? logEl.scrollTop : null;
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
    if (preserveScrollNextRebuild && prevScrollTop != null) {
      try { logEl.scrollTop = prevScrollTop; } catch(e){}
      preserveScrollNextRebuild = false;
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
    // 组装可搜索文本：原始行 + 解析出的 Tag + 通过 pidMap/当前包名推导出的 Package
    let searchLine = line;
    try {
      const obj = parseLogLine(line);
      if (obj) {
        let pkgSrc = obj.pkg || '';
        if (!pkgSrc && obj.pid) {
          try { const name = pidMap.get(Number(obj.pid)); if (name) pkgSrc = name; } catch(e){}
        }
        if (!pkgSrc) pkgSrc = currentPackage || '';
        const extra = [obj.tag || '', pkgSrc || ''].filter(Boolean).join(' ');
        if (extra) searchLine = line + ' ' + extra;
      }
    } catch(e){}
    const hay = matchCase ? searchLine : searchLine.toLowerCase();
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
      const softWrap = !!(softWrapChk && softWrapChk.checked);
      const device = (deviceSel && deviceSel.value) ? deviceSel.value : '';
      vscode.setState({
        filterText: filterText,
        matchCase: matchCase,
        softWrap: softWrap,
        device: device,
        historyLoaded: !!historyLoaded,
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
      // 不再从 state 恢复 backlogText，避免切换卡顿；保持 historyLoaded 用于决定是否请求历史
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
    if (importMode) {
      // 导入模式下忽略任何实时历史下发，避免覆盖导入内容
      return;
    }
    backlogText = msg.text || '';
    historyLoaded = true;
    scheduleRebuild();
  }
});

