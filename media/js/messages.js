// 消息分发与处理（拆分自 view.js）。
// 依赖：view.js 中已声明的全局函数与变量（dlog、setStatus、applyPausedStateFromStatus、
// append、setDevices、scheduleRebuild 等）。

(() => {
  if (!window || !window.Msg || !window.onMessage) return;

  onMessage('status', (msg) => {
    setStatus(msg.text);
    applyPausedStateFromStatus(msg.text);
    try {
      const text = String(msg.text || '');
      if (text.indexOf('已重启') !== -1 && !importMode) {
        vscode.postMessage({ type: 'refreshDevices' });
      }
      if (importMode && (/已退出|已停止|启动:/.test(text))) return;
    } catch(e){}
  });

  onMessage('append', (msg) => { if (!importMode) append(msg.text); });

  onMessage('devices', (msg) => { setDevices(msg.devices, msg.defaultSerial); });

  onMessage('pidMap', (msg) => {
    try {
      const map = msg.map || {};
      for (const k in map) { if (Object.prototype.hasOwnProperty.call(map,k)) pidMap.set(Number(k), String(map[k])); }
      pidMapDirty = true;
      if (!pidMapRebuildTimer) {
        pidMapRebuildTimer = setTimeout(() => {
          pidMapRebuildTimer = null;
          if (pidMapDirty) { pidMapDirty = false; scheduleRebuild(); }
        }, 50);
      }
    } catch(e){}
  });

  onMessage('config', (msg) => {
    try { currentPackage = String((msg.config && msg.config.pkg) || ''); } catch(e) { currentPackage = ''; }
    scheduleRebuild();
  });

  onMessage('visible', () => {
    if (!historyLoaded && deviceSel.value) {
      dlog('[history] request on visible');
      vscode.postMessage({ type: 'requestHistory', serial: deviceSel.value });
    }
    try {
      const onlyOne = deviceSel && deviceSel.options && deviceSel.options.length === 1 ? deviceSel.options[0] : null;
      const emptyShown = onlyOne && !onlyOne.value && /未检测到设备/.test(String(onlyOne.textContent || ''));
      if (!deviceSel || !deviceSel.options || deviceSel.options.length === 0 || emptyShown) {
        dlog('[devices] visible -> refresh because empty');
        vscode.postMessage({ type: 'refreshDevices' });
      }
    } catch(e){}
    try {
      preserveScrollNextRebuild = true;
      virt.lineHeight = 0;
      virt.wrapUnits = null;
      virt.wrapPrefix = null;
    } catch(e){}
    scheduleRebuild();
  });
})();


