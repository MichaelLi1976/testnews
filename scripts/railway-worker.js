/**
 * railway-worker.js
 * 部署在 Railway 雲端，長期執行
 * 每分鐘檢查間隔，到時間就觸發對應的 GitHub Actions workflow
 */
const https = require('https');
const http  = require('http');

const GH_TOKEN = process.env.GH_TOKEN;
const REPO     = 'MichaelLi1976/testnews';

if (!GH_TOKEN) { console.error('❌ GH_TOKEN 未設定'); process.exit(1); }

let cfg      = { fetchIntervalMin: 5, postIntervalMin: 60 };
let lastFetch = 0;
let lastPost  = 0;
let tickCount = 0;

function log(msg) {
  process.stdout.write(`[${new Date().toISOString()}] ${msg}\n`);
}

/* ── 讀取 config.json（GitHub Contents API，零快取） ── */
function loadConfig() {
  return new Promise(resolve => {
    const req = https.request({
      hostname: 'api.github.com',
      path:     `/repos/${REPO}/contents/config.json`,
      headers: {
        'Authorization': `Bearer ${GH_TOKEN}`,
        'Accept':        'application/vnd.github+json',
        'User-Agent':    'RailwayWorker/1.0',
      },
      timeout: 10000,
    }, res => {
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => {
        try {
          const data    = JSON.parse(Buffer.concat(buf).toString());
          const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
          cfg = JSON.parse(decoded);
          log(`✓ config 讀取成功：fetch=${cfg.fetchIntervalMin}分 · post=${cfg.postIntervalMin}分`);
        } catch (e) {
          log(`⚠ config 讀取失敗：${e.message}`);
        }
        resolve();
      });
    });
    req.on('error',   e  => { log(`⚠ config error: ${e.message}`); resolve(); });
    req.on('timeout', () => { req.destroy(); log('⚠ config timeout'); resolve(); });
    req.end();
  });
}

/* ── 觸發 GitHub Actions workflow ── */
function triggerWorkflow(workflow) {
  return new Promise(resolve => {
    const body = JSON.stringify({ ref: 'master' });
    const req = https.request({
      hostname: 'api.github.com',
      path:     `/repos/${REPO}/actions/workflows/${workflow}/dispatches`,
      method:   'POST',
      headers: {
        'Authorization':        `Bearer ${GH_TOKEN}`,
        'Accept':               'application/vnd.github+json',
        'User-Agent':           'RailwayWorker/1.0',
        'Content-Type':         'application/json',
        'Content-Length':       Buffer.byteLength(body),
        'X-GitHub-Api-Version': '2022-11-28',
      },
      timeout: 15000,
    }, res => {
      if (res.statusCode === 204) { resolve(true); res.resume(); return; }
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => { log(`✗ ${workflow} HTTP ${res.statusCode}: ${Buffer.concat(buf)}`); resolve(false); });
    });
    req.on('error',   e  => { log(`❌ ${e.message}`); resolve(false); });
    req.on('timeout', () => { req.destroy(); log('❌ timeout'); resolve(false); });
    req.write(body); req.end();
  });
}

/* ── 每分鐘執行 ── */
async function tick() {
  tickCount++;
  const now = Date.now();

  // 每 5 分鐘重新讀取 config（快速響應設定變更）
  if (tickCount % 5 === 1) {
    await loadConfig();
  }

  // 檢查抓取間隔
  const fetchElapsed = (now - lastFetch) / 60000;
  if (fetchElapsed >= cfg.fetchIntervalMin) {
    log(`⏰ 觸發 fetch-news（已過 ${fetchElapsed.toFixed(1)} 分，設定 ${cfg.fetchIntervalMin} 分）`);
    const ok = await triggerWorkflow('fetch-news.yml');
    if (ok) { lastFetch = now; log('✓ fetch-news 觸發成功'); }
  } else {
    log(`⏳ fetch 距下次還有 ${(cfg.fetchIntervalMin - fetchElapsed).toFixed(1)} 分`);
  }

  // 檢查發文間隔
  const postElapsed = (now - lastPost) / 60000;
  if (postElapsed >= cfg.postIntervalMin) {
    log(`⏰ 觸發 fb-post（已過 ${postElapsed.toFixed(1)} 分，設定 ${cfg.postIntervalMin} 分）`);
    const ok = await triggerWorkflow('fb-post.yml');
    if (ok) { lastPost = now; log('✓ fb-post 觸發成功'); }
  } else {
    log(`⏳ post 距下次還有 ${(cfg.postIntervalMin - postElapsed).toFixed(1)} 分`);
  }
}

/* ── 健康檢查 HTTP server（Railway 需要有 port 才不會誤判為崩潰） ── */
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status:      'ok',
    uptime:      process.uptime().toFixed(0) + 's',
    ticks:       tickCount,
    config:      cfg,
    lastFetch:   lastFetch ? new Date(lastFetch).toISOString() : 'never',
    lastPost:    lastPost  ? new Date(lastPost).toISOString()  : 'never',
  }));
}).listen(PORT, () => log(`🌐 健康檢查 server 啟動 port:${PORT}`));

/* ── 啟動 ── */
log('🚀 Railway Worker 啟動');
loadConfig().then(() => {
  tick();                              // 立即執行一次
  setInterval(tick, 60 * 1000);       // 之後每分鐘執行
});
