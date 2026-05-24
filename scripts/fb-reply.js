/**
 * fb-reply.js
 * 自動回覆 Facebook 粉專最新留言
 * - 從 FB Graph API 取得近期貼文的最新留言
 * - 使用 Groq AI (llama-3.3-70b) 生成繁體中文情境回覆
 * - 追蹤已回覆留言 ID，避免重複
 * - 將結果寫入 replied-comments.json（由 CI 提交）
 *
 * 環境變數（GitHub Secrets）:
 *   FB_PAGE_TOKEN  — Facebook Page Access Token (pages_manage_posts + pages_read_user_content)
 *   FB_PAGE_ID     — 預設粉專 ID（可被 config.json 的 fbPageIds 覆蓋）
 *   GROQ_API_KEY   — Groq API Key
 */
'use strict';

const https = require('https');
const fs    = require('fs');
const path  = require('path');

/* ── 環境設定 ─────────────────────────────────────────────────────────────── */
const FB_TOKEN   = process.env.FB_PAGE_TOKEN;
const FB_DEF_ID  = process.env.FB_PAGE_ID;
const AI_KEY     = process.env.GROQ_API_KEY;
const AI_MODEL   = 'llama-3.3-70b-versatile';
const FB_VER     = 'v21.0';

if (!FB_TOKEN)  { console.error('❌ FB_PAGE_TOKEN not set'); process.exit(1); }
if (!AI_KEY)    { console.error('❌ GROQ_API_KEY not set');  process.exit(1); }

/* ── 讀取設定 ─────────────────────────────────────────────────────────────── */
const cfg = JSON.parse(fs.readFileSync('config.json', 'utf8'));
const REPLIES_PER_RUN = cfg.repliesPerRun || 3;

// fbPageIds 優先取自 config.json，否則 fallback 到環境變數
const PAGE_IDS = (Array.isArray(cfg.fbPageIds) && cfg.fbPageIds.length > 0)
  ? cfg.fbPageIds.map(id => String(id).trim()).filter(Boolean)
  : (FB_DEF_ID ? [FB_DEF_ID] : []);

if (PAGE_IDS.length === 0) {
  console.error('❌ 未設定任何粉專 ID。請在 config.json 的 fbPageIds 填入 Page ID，或設定 FB_PAGE_ID 環境變數。');
  process.exit(1);
}

console.log(`[設定] 每次回覆上限：${REPLIES_PER_RUN} 則，處理粉專：${PAGE_IDS.join(', ')}`);

/* ── 讀取已回覆記錄 ──────────────────────────────────────────────────────── */
const REPLIED_FILE = 'replied-comments.json';
let repliedLog = [];
try {
  repliedLog = JSON.parse(fs.readFileSync(REPLIED_FILE, 'utf8'));
} catch {
  repliedLog = [];
}
const repliedIds = new Set(repliedLog.map(r => r.id));
console.log(`[記錄] 已有 ${repliedLog.length} 則回覆記錄`);

/* ── HTTP 工具 ───────────────────────────────────────────────────────────── */
function httpsGet(urlStr) {
  return new Promise((resolve, reject) => {
    const u   = new URL(urlStr);
    const req = https.get(
      { hostname: u.hostname, path: u.pathname + u.search, timeout: 25000,
        headers: { 'User-Agent': 'NewsBot-ReplyAgent/1.0' } },
      res => {
        const buf = [];
        res.on('data', c => buf.push(c));
        res.on('end', () => {
          try {
            const d = JSON.parse(Buffer.concat(buf).toString());
            if (d.error) return reject(new Error(`FB API: ${d.error.message} (code ${d.error.code})`));
            resolve(d);
          } catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('FB GET timeout')); });
  });
}

function httpsPost(hostname, urlPath, bodyStr, contentType = 'application/x-www-form-urlencoded') {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname,
        path: urlPath,
        method: 'POST',
        headers: {
          'Content-Type':   contentType,
          'Content-Length': Buffer.byteLength(bodyStr),
          'User-Agent':     'NewsBot-ReplyAgent/1.0',
        },
        timeout: 30000,
      },
      res => {
        const buf = [];
        res.on('data', c => buf.push(c));
        res.on('end', () => {
          try {
            const d = JSON.parse(Buffer.concat(buf).toString());
            if (d.error) return reject(new Error(`FB API: ${d.error.message} (code ${d.error.code})`));
            resolve(d);
          } catch (e) { reject(new Error(`JSON parse failed: ${e.message}`)); }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('POST timeout')); });
    req.write(bodyStr);
    req.end();
  });
}

/* ── FB Graph API 包裝 ───────────────────────────────────────────────────── */
function fbGet(endpoint) {
  // endpoint 已含 access_token 參數
  return httpsGet(`https://graph.facebook.com/${FB_VER}${endpoint}`);
}

function fbPostComment(commentId, message) {
  const params = new URLSearchParams({ message, access_token: FB_TOKEN });
  return httpsPost(
    'graph.facebook.com',
    `/${FB_VER}/${commentId}/comments`,
    params.toString()
  );
}

/* ── Groq AI 生成回覆 ────────────────────────────────────────────────────── */
async function generateReply(postText, commentText, commenterName) {
  const prompt =
`你是台灣新聞粉絲專頁「即時快報」的社群管理員，請用繁體中文回覆以下留言。

回覆規則：
1. 親切自然、口語化，像朋友聊天，絕不生硬
2. 與貼文主題和留言內容直接相關
3. 長度 30～60 字（太短顯得敷衍，太長不符社群習慣）
4. 不以「您好」「親愛的」開頭
5. 若留言是問題 → 簡短回答或引導關注後續報導
6. 若留言是意見/感想 → 表達認同或感謝，並呼應新聞重點
7. 適當使用 1～2 個 emoji 增加親切感

貼文摘要（前200字）：
${postText.slice(0, 200)}

留言者：${commenterName}
留言內容：${commentText}

請直接輸出回覆文字，不加任何前綴說明：`;

  const body = JSON.stringify({
    model: AI_MODEL,
    max_tokens: 150,
    temperature: 0.82,
    messages: [{ role: 'user', content: prompt }],
  });

  const result = await httpsPost(
    'api.groq.com',
    '/openai/v1/chat/completions',
    body,
    'application/json'
  );

  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Groq 回傳空回覆');

  // 確保不超過 FB 單則留言長度限制 (8000 chars, 我們限制更短)
  return text.slice(0, 500);
}

/* ── 主程式 ──────────────────────────────────────────────────────────────── */
async function main() {
  let totalReplied = 0;
  const newEntries = [];

  for (const pageId of PAGE_IDS) {
    if (totalReplied >= REPLIES_PER_RUN) break;

    console.log(`\n══ 粉專 ${pageId} ══`);

    /* 1. 取得最近 5 則貼文 */
    let posts = [];
    try {
      const feed = await fbGet(
        `/${pageId}/feed?fields=id,message,story,created_time&limit=5&access_token=${FB_TOKEN}`
      );
      posts = feed.data || [];
      console.log(`  找到 ${posts.length} 則貼文`);
    } catch (e) {
      console.error(`  ✗ 取得貼文失敗：${e.message}`);
      continue;
    }

    /* 2. 逐篇貼文取留言 */
    for (const post of posts) {
      if (totalReplied >= REPLIES_PER_RUN) break;

      const postText  = (post.message || post.story || '').trim() || '（無文字內容）';
      const postIdRaw = post.id;                    // format: pageId_numericId
      const postNumId = postIdRaw.includes('_')
        ? postIdRaw.split('_').slice(1).join('_')
        : postIdRaw;
      const postUrl  = `https://www.facebook.com/permalink.php?story_fbid=${postNumId}&id=${pageId}`;

      let comments = [];
      try {
        const c = await fbGet(
          `/${postIdRaw}/comments?fields=id,message,from,created_time&limit=10&filter=stream&access_token=${FB_TOKEN}`
        );
        comments = c.data || [];
      } catch (e) {
        console.error(`  ✗ 貼文 ${postIdRaw} 留言取得失敗：${e.message}`);
        continue;
      }

      /* 3. 過濾：排除已回覆、粉專自己的留言、空白留言 */
      const pending = comments.filter(c =>
        !repliedIds.has(c.id) &&
        c.from?.id !== pageId &&
        (c.message || '').trim().length > 0
      );

      console.log(`  貼文 ${postIdRaw}：共 ${comments.length} 留言，待回覆 ${pending.length}`);

      /* 4. 逐則生成 & 發布回覆 */
      for (const comment of pending) {
        if (totalReplied >= REPLIES_PER_RUN) break;

        const commenterName = comment.from?.name || '網友';
        const commentText   = comment.message.trim();

        console.log(`  ▶ ${commenterName}：${commentText.slice(0, 60)}${commentText.length > 60 ? '…' : ''}`);

        /* 生成 AI 回覆 */
        let replyText;
        try {
          replyText = await generateReply(postText, commentText, commenterName);
          console.log(`    AI: ${replyText}`);
        } catch (e) {
          console.warn(`    ⚠ AI 生成失敗（${e.message}），跳過此則`);
          continue;
        }

        /* 發布回覆 */
        try {
          const res = await fbPostComment(comment.id, replyText);
          console.log(`    ✓ 已回覆（新留言 ID：${res.id}）`);
        } catch (e) {
          const msg = e.message || '';
          console.error(`    ✗ 發布失敗：${msg}`);
          // Rate limit → 立即停止本次
          if (msg.toLowerCase().includes('rate') || msg.includes('(32)') || msg.includes('(613)')) {
            console.warn('  ⚠ 遇到 Rate Limit，本次提前結束');
            break;
          }
          // 其他錯誤：標記為已嘗試（放入 set），避免無限重試
          repliedIds.add(comment.id);
          continue;
        }

        /* 記錄 */
        const entry = {
          id:           comment.id,
          pageId,
          postId:       postIdRaw,
          postUrl,
          postTitle:    postText.slice(0, 100),
          commenterName,
          commentText,
          replyText,
          repliedAt:    new Date().toISOString(),
        };
        repliedIds.add(comment.id);
        newEntries.push(entry);
        totalReplied++;
      }
    }
  }

  console.log(`\n[完成] 本次共回覆 ${totalReplied} 則`);

  /* 5. 更新 replied-comments.json（新紀錄在最前，最多保留 200 筆） */
  if (newEntries.length > 0) {
    repliedLog = [...newEntries, ...repliedLog].slice(0, 200);
    fs.writeFileSync(REPLIED_FILE, JSON.stringify(repliedLog, null, 2));
    console.log(`✓ 已更新 ${REPLIED_FILE}（共 ${repliedLog.length} 筆記錄）`);
  } else {
    console.log('沒有新回覆，不更新檔案。');
  }
}

main().catch(e => {
  console.error('❌ 未預期錯誤：', e.message);
  process.exit(1);
});
