const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);

const deviceSel = $('device');
const refreshBtn = $('refresh');
const startBtn = $('start');
const stopBtn = $('stop');
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

refreshBtn.addEventListener('click', () => {
  vscode.postMessage({ type: 'refreshDevices' });
});
startBtn.addEventListener('click', () => {
  vscode.postMessage({
    type: 'start',
    serial: deviceSel.value,
    pkg: $('pkg').value.trim(),
    tag: $('tag').value.trim(),
    level: $('level').value,
    buffer: $('buffer').value,
    save: document.getElementById('save').checked,
  });
});
stopBtn.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

vscode.postMessage({ type: 'ready' });

