const https = require('https');
const http  = require('http');
const fs    = require('fs');

// Priority feeds: LTN gives direct article links (no redirect)
// Google News as fallback
const FEEDS = [
  { url: 'https://news.ltn.com.tw/rss/all.xml',                          name: '自由時報' },
  { url: 'https://news.google.com/rss?gl=TW&hl=zh-TW&ceid=TW:zh-Hant', name: 'Google新聞' },
  { url: 'https://tw.news.yahoo.com/rss',                                name: 'Yahoo新聞' },
];
const MAX = 500;

function get(url, hops = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/2.0)', Accept: '*/*' },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        const next = /^https?:/.test(res.headers.location)
          ? res.headers.location : new URL(res.headers.location, url).href;
        res.resume(); return resolve(get(next, hops - 1));
      }
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(buf).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function decode(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g,  '<').replace(/&gt;/g,  '>')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ').trim();
}

function parse(xml) {
  return [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].flatMap(m => {
    const s = m[1];

    const cdata = tag => s.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1]?.trim();
    const plain = tag => s.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`))?.[1]?.trim();
    const v = tag => cdata(tag) || plain(tag) || '';

    const title = v('title');
    const link  = v('link')
      || s.match(/<link[^>]+href="([^"]+)"/)?.[1]?.trim()
      || v('guid')
      || '';
    const rawDesc = cdata('description') || plain('description') || '';
    const desc  = decode(rawDesc).slice(0, 200);
    const pub   = v('pubDate');

    return title && link ? [{ title, link, desc, pub }] : [];
  });
}

async function main() {
  const news = JSON.parse(fs.readFileSync('news.json', 'utf8'));
  const seen = new Set(news.map(n => n.link));
  console.log(`Existing: ${news.length} items`);

  for (const feed of FEEDS) {
    try {
      console.log(`Fetching ${feed.url}`);
      const { status, body } = await get(feed.url);
      console.log(`  status=${status} size=${body.length}`);
      if (status !== 200) { console.log('  non-200, skip'); continue; }

      const items = parse(body);
      console.log(`  parsed ${items.length} items`);

      const fresh = items.find(i => !seen.has(i.link));
      if (fresh) {
        news.unshift({
          title:  fresh.title,
          link:   fresh.link,
          desc:   fresh.desc,
          pub:    fresh.pub,
          source: feed.name,
          at:     new Date().toISOString(),
        });
        fs.writeFileSync('news.json', JSON.stringify(news.slice(0, MAX), null, 2));
        console.log('✓ Added:', fresh.title);
        return;
      }
      console.log('  all items already seen, try next feed');
    } catch (e) {
      console.error('✗', feed.url, e.message);
    }
  }
  console.log('No new items found.');
}

main().catch(e => { console.error(e.message); process.exit(0); });
