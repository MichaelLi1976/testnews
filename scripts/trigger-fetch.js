/**
 * trigger-fetch.js
 * 每1分鐘由 Windows 排程工作執行
 * 根據 config.json 的 fetchIntervalMin 決定是否觸發 fetch-news.yml
 */
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const { execSync } = require('child_process');

const GH_TOKEN      = process.env.GH_TOKEN;
const REPO          = 'MichaelLi1976/testnews';
const ROOT          = path.join(__dirname, '..');
const CONFIG_FILE   = path.join(ROOT, 'config.json');
const LAST_FILE     = path.join(ROOT, 'logs', 'last-fetch.txt');
const LOG_FILE      = path.join(ROOT, 'logs', 'trigger.log');

function log(msg) {
  const ts   = new Date().toLocaleTimeString('zh-TW');
  const line = `[${ts}] ${msg}\n`;
  process.stdout.write(line);
  try { fs.appendFileSync(LOG_FILE, line); } catch(_) {}
}

if (!GH_TOKEN) { log('❌ GH_TOKEN 未設定'); process.exit(1); }

// ── 同步 config.json ──────────────────────────────────────────────────────────
try {
  execSync(`git -C "${ROOT}" pull origin master -q`, { timeout: 15000, stdio: 'pipe' });
} catch(_) {}

// ── 讀取設定 ──────────────────────────────────────────────────────────────────
let config = { fetchIntervalMin: 5 };
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch(_) {}
const intervalMin = Number(config.fetchIntervalMin) || 5;

// ── 檢查是否到時間 ────────────────────────────────────────────────────────────
const now = Date.now();
let lastFetch = 0;
try { lastFetch = parseInt(fs.readFileSync(LAST_FILE, 'utf8').trim()) || 0; } catch(_) {}

const elapsedMin = (now - lastFetch) / 60000;
if (elapsedMin < intervalMin) {
  log(`⏳ 距下次抓取還有 ${(intervalMin - elapsedMin).toFixed(1)} 分鐘（設定：${intervalMin} 分）`);
  process.exit(0);
}

// ── 觸發 fetch-news.yml ───────────────────────────────────────────────────────
const body = JSON.stringify({ ref: 'master' });
const req = https.request({
  hostname: 'api.github.com',
  path:     `/repos/${REPO}/actions/workflows/fetch-news.yml/dispatches`,
  method:   'POST',
  headers: {
    'Authorization':        `Bearer ${GH_TOKEN}`,
    'Accept':               'application/vnd.github+json',
    'User-Agent':           'NewsBot-Trigger/1.0',
    'Content-Type':         'application/json',
    'Content-Length':       Buffer.byteLength(body),
    'X-GitHub-Api-Version': '2022-11-28',
  },
  timeout: 15000,
}, res => {
  if (res.statusCode === 204) {
    log(`✓ fetch-news 觸發 (HTTP 204)｜間隔：${intervalMin} 分`);
    fs.writeFileSync(LAST_FILE, now.toString());
    res.resume();
    return;
  }
  const buf = [];
  res.on('data', c => buf.push(c));
  res.on('end', () => { log(`✗ HTTP ${res.statusCode}: ${Buffer.concat(buf)}`); process.exit(1); });
});
req.on('error',   e  => { log(`❌ ${e.message}`); process.exit(1); });
req.on('timeout', () => { req.destroy(); log('❌ timeout'); process.exit(1); });
req.write(body);
req.end();
