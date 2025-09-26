// 简易聚类 WebWorker：接收 { type:'build', text, maxClusters, maxSamples }
self.onmessage = function(e){
  const msg = e.data || {};
  if (msg.type !== 'build') return;
  const text = String(msg.text || '');
  const CLUSTER_MAX = Number(msg.maxClusters || 2000);
  const CLUSTER_SAMPLES_MAX = Number(msg.maxSamples || 5);
  function normalize(line){
    try {
      // 仅基于消息文本做简化占位
      let s = String(line || '');
      s = s
        .replace(/0x[0-9a-fA-F]+/g, ' HEX ')
        .replace(/\b\d+\b/g, ' NUM ')
        .replace(/[A-Fa-f0-9]{8}(-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}/g, ' UUID ')
        .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, ' IP ')
        .replace(/[\/][\w\-.]+(?:[\/][\w\-.]+)+/g, ' PATH ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
      return s;
    } catch(e){ return String(line || '').toLowerCase(); }
  }
  const lines = text.split(/\r?\n/);
  const map = new Map();
  for (let i = 0; i < lines.length; i++){
    const ln = lines[i];
    if (!ln) continue;
    const key = normalize(ln);
    const hit = map.get(key);
    if (!hit) map.set(key, { rep: ln, count: 1, samples: [ln] });
    else { hit.count++; if (hit.samples.length < CLUSTER_SAMPLES_MAX) hit.samples.push(ln); }
    if (map.size > CLUSTER_MAX) break;
  }
  const arr = Array.from(map.values()).sort((a,b) => b.count - a.count);
  self.postMessage({ type: 'built', clusters: arr });
};


