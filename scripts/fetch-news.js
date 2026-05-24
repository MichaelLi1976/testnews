const https = require('https');
const fs = require('fs');

const FEEDS = [
  'https://www.cna.com.tw/rss/aall.aspx',
  'https://feeds.ltn.com.tw/rss/all',
  'https://www.ettoday.net/news/rss.xml',
];
const MAX = 300;

function get(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 12000, headers: { 'User-Agent': 'NewsBot/1.0' } }, res => {
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => resolve(Buffer.concat(buf).toString('utf8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

function parse(xml) {
  return [...xml.matchAll(/<item[^>]*>([\s\S]*?)<\/item>/gi)].flatMap(m => {
    const s = m[1];
    const v = tag =>
      s.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`))?.[1]?.trim() ||
      s.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`))?.[1]?.trim() || '';
    const title = v('title');
    const link  = v('link') || s.match(/<link[^>]+href="([^"]+)"/)?.[1]?.trim() || '';
    const desc  = v('description').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const pub   = v('pubDate');
    return title && link ? [{ title, link, desc, pub }] : [];
  });
}

function sourceName(url) {
  if (url.includes('cna'))      return '中央社';
  if (url.includes('ltn'))      return '自由時報';
  if (url.includes('ettoday')) return 'ETtoday';
  return '新聞';
}

async function main() {
  const news = JSON.parse(fs.readFileSync('news.json', 'utf8'));
  const seen = new Set(news.map(n => n.link));

  for (const feed of FEEDS) {
    try {
      const xml  = await get(feed);
      const item = parse(xml).find(i => !seen.has(i.link));
      if (item) {
        news.unshift({ title: item.title, link: item.link, desc: item.desc,
                       pub: item.pub, source: sourceName(feed),
                       at: new Date().toISOString() });
        fs.writeFileSync('news.json', JSON.stringify(news.slice(0, MAX), null, 2));
        console.log('✓', item.title);
        return;
      }
    } catch (e) { console.error('✗', feed, e.message); }
  }
  console.log('No new items.');
}

main().catch(e => { console.error(e.message); process.exit(0); });
