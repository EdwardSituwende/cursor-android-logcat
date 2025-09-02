const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const deviceSel = $('device');
const toggleBtn = $('toggle');
const logEl = $('log');
const statusEl = $('status');

function setStatus(t){ statusEl.textContent = t; }
function append(t){ logEl.textContent += t; logEl.scrollTop = logEl.scrollHeight; }
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
  }
});

// 点击设备下拉框时，如果只有“未检测到设备”，则触发刷新
deviceSel.addEventListener('click', () => {
  if (deviceSel.options.length === 1 && deviceSel.options[0].value === '') {
    vscode.postMessage({ type: 'refreshDevices' });
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
    toggleBtn.textContent = '暂停';
    uiPaused = false;
  } else {
    // 暂停
    vscode.postMessage({ type: 'pause' });
    toggleBtn.textContent = '恢复';
    uiPaused = true;
  }
});

vscode.postMessage({ type: 'ready' });

