/**
 * fb-post.js
 * 每小時：彙整最近1小時新聞 → 生成快報員貼文 → PO到FB粉絲團 → 回應最新留言
 */
const https = require('https');
const fs    = require('fs');

const PAGE_ID    = process.env.FB_PAGE_ID || '61588120692664';
const FB_TOKEN   = process.env.FB_ACCESS_TOKEN;
const AI_KEY     = process.env.ANTHROPIC_API_KEY;
const AI_MODEL   = 'claude-3-5-haiku-20241022';

// ── Facebook Graph API ────────────────────────────────────────────────────────
function fb(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const sep  = path.includes('?') ? '&' : '?';
    const opts = {
      hostname: 'graph.facebook.com',
      path: `/v19.0${path}${sep}access_token=${FB_TOKEN}`,
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      timeout: 20000,
    };
    const req = https.request(opts, res => {
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => {
        let d;
        try { d = JSON.parse(Buffer.concat(buf).toString()); }
        catch { return reject(new Error('FB parse error')); }
        if (d.error) return reject(new Error(`FB: ${d.error.message}`));
        resolve(d);
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('FB timeout')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Anthropic Messages API ────────────────────────────────────────────────────
function claude(prompt) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: AI_MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });
    const req = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type':    'application/json',
        'x-api-key':       AI_KEY,
        'anthropic-version': '2023-06-01',
      },
      timeout: 30000,
    }, res => {
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => {
        let d;
        try { d = JSON.parse(Buffer.concat(buf).toString()); }
        catch { return reject(new Error('Claude parse error')); }
        if (d.error) return reject(new Error(`Claude: ${d.error.message}`));
        resolve(d.content?.[0]?.text || '');
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Claude timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!FB_TOKEN)  throw new Error('FB_ACCESS_TOKEN not set');
  if (!AI_KEY)    throw new Error('ANTHROPIC_API_KEY not set');

  // ─ Step 1: 最近1小時新聞 ─
  const allNews  = JSON.parse(fs.readFileSync('news.json', 'utf8'));
  const hourAgo  = new Date(Date.now() - 60 * 60 * 1000);
  const recent   = allNews.filter(n => new Date(n.at) >= hourAgo);
  console.log(`[新聞] 最近1小時共 ${recent.length} 則`);

  // ─ Step 2: 生成貼文並PO出 ─
  if (recent.length > 0) {
    const newsList = recent
      .map((n, i) => `${i + 1}. 【${n.source}】${n.title}${n.desc ? `\n   ${n.desc}` : ''}`)
      .join('\n\n');

    const postPrompt = `你是台灣新聞粉絲專頁的快報員，說話直接有力、帶緊迫感，像電視新聞播報員一樣。
請根據以下新聞整理一則 Facebook 貼文，要求：
- 第一行：震撼標題 + emoji（如 🚨⚡📢）
- 用「各位鄉親注意了！」「重磅消息！」等開場
- 3-5條重點，每條前加 🔹 emoji
- 語氣像播報緊急新聞，口語化、有力道
- 結尾加「👉 持續追蹤中，追蹤本粉專不錯過任何即時快報！」
- 最後加 hashtag：#台灣新聞 #即時快報 #${new Date().toLocaleDateString('zh-TW').replace(/\//g, '')}

以下是最近1小時的新聞：
${newsList}`;

    console.log('[Claude] 生成貼文中...');
    const postContent = await claude(postPrompt);
    console.log('[貼文預覽]\n' + postContent.slice(0, 200) + '...');

    await fb(`/${PAGE_ID}/feed`, 'POST', { message: postContent });
    console.log('✓ 已PO出FB貼文');
  } else {
    console.log('[貼文] 最近1小時無新聞，跳過發文');
  }

  // ─ Step 3: 回應最新留言 ─
  console.log('[留言] 抓取最新貼文留言...');
  let feed;
  try {
    feed = await fb(
      `/${PAGE_ID}/feed?fields=id,from,comments.limit(5){id,message,from,comments.limit(1){from}}&limit=8`
    );
  } catch (e) {
    console.error('[留言] 抓取失敗:', e.message);
    return;
  }

  let replyCount = 0;
  for (const post of feed.data || []) {
    for (const cmt of post.comments?.data || []) {
      // 跳過自己(粉專)的留言
      if (cmt.from?.id === PAGE_ID) continue;

      // 檢查是否已回覆
      const alreadyReplied = cmt.comments?.data?.some(r => r.from?.id === PAGE_ID);
      if (alreadyReplied) continue;

      const replyPrompt = `你是台灣新聞粉絲專頁的小編，個性活潑親切。
請針對以下粉絲留言做一個適當的回覆，要求：
- 50-100字以內
- 口語化、加適當emoji
- 若是問題盡量給有用回應
- 若是讚美感謝互動
- 若是負面留言，冷靜友善回應不起爭執
- 結尾可加「感謝支持本粉專！🙏」

粉絲留言：「${cmt.message}」

回覆：`;

      try {
        const reply = await claude(replyPrompt);
        await fb(`/${cmt.id}/comments`, 'POST', { message: reply });
        console.log(`✓ 回覆留言：「${cmt.message.slice(0, 30)}...」`);
        replyCount++;
      } catch (e) {
        console.error(`✗ 回覆失敗：${e.message}`);
      }

      if (replyCount >= 5) break; // 每次最多回5則
    }
    if (replyCount >= 5) break;
  }

  console.log(`\n完成：發文 ${recent.length > 0 ? 1 : 0} 則，回覆留言 ${replyCount} 則`);
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
