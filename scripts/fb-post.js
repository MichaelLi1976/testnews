/**
 * fb-post.js
 * 每小時：彙整最近1小時新聞 → Claude 生成快報員貼文 → POST 到 Pabbly Webhook
 * Pabbly 負責實際PO到FB粉專（不再直接打 Facebook API）
 */
const https = require('https');
const fs    = require('fs');

const PABBLY_WEBHOOK = process.env.PABBLY_WEBHOOK_URL;  // Pabbly Webhook URL
const AI_KEY         = process.env.GROQ_API_KEY;
const AI_MODEL       = 'llama-3.3-70b-versatile';

// ── Groq API (OpenAI-compatible) ───────────────────────────────────────────────
function claude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: AI_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.groq.com',
      path: '/openai/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${AI_KEY}`,
      },
      timeout: 30000,
    }, res => {
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => {
        const d = JSON.parse(Buffer.concat(buf).toString());
        if (d.error) return reject(new Error(`Groq: ${d.error.message}`));
        resolve(d.choices?.[0]?.message?.content || '');
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Groq timeout')); });
    req.write(body);
    req.end();
  });
}

// ── 送到 Pabbly Webhook ───────────────────────────────────────────────────────
function postToPabbly(payload) {
  return new Promise((resolve, reject) => {
    const u    = new URL(PABBLY_WEBHOOK);
    const body = JSON.stringify(payload);
    const req  = https.request({
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout:  15000,
    }, res => {
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(buf).toString() }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Pabbly timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (!PABBLY_WEBHOOK) throw new Error('PABBLY_WEBHOOK_URL not set');
  if (!AI_KEY)         throw new Error('ANTHROPIC_API_KEY not set');

  // 最近1小時的新聞
  const allNews = JSON.parse(fs.readFileSync('news.json', 'utf8'));
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const recent  = allNews.filter(n => new Date(n.at) >= hourAgo);

  console.log(`[新聞] 最近1小時共 ${recent.length} 則`);
  if (recent.length === 0) { console.log('沒有新聞，跳過發文'); return; }

  // Claude 生成快報員貼文
  const newsList = recent
    .map((n, i) => `${i + 1}. 【${n.source}】${n.title}${n.desc ? `\n   ${n.desc}` : ''}`)
    .join('\n\n');

  const prompt = `你是台灣新聞粉絲專頁的快報員，說話直接有力、帶緊迫感，像電視新聞播報員。
根據以下新聞整理一則 Facebook 貼文，要求：
- 第一行：震撼標題 + emoji（如 🚨⚡📢）
- 開場用「各位鄉親注意了！」「重磅消息！」等
- 3-5個重點，每點前加 🔹 或相關 emoji
- 口語化、有力道，像播報緊急新聞
- 結尾：「👉 持續追蹤中，追蹤本粉專不錯過即時快報！」
- 最後加 hashtag：#台灣新聞 #即時快報

新聞：
${newsList}`;

  console.log('[Claude] 生成貼文中...');
  const message = await claude(prompt);
  console.log('[預覽] ' + message.slice(0, 120) + '...');

  // 送到 Pabbly
  const result = await postToPabbly({
    message,
    timestamp: new Date().toISOString(),
    news_count: recent.length,
  });
  console.log(`✓ 已送至 Pabbly (HTTP ${result.status})`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
