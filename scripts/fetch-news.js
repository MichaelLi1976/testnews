const https = require('https');
const http  = require('http');
const fs    = require('fs');

const FEEDS = [
  // Google News Taiwan — always fresh, no auth
  'https://news.google.com/rss?gl=TW&hl=zh-TW&ceid=TW:zh-Hant',
  // CNA 中央社
  'https://www.cna.com.tw/rss/aall.aspx',
  // ETtoday
  'https://www.ettoday.net/news/rss.xml',
  // UDN 聯合新聞網
  'https://udn.com/rssfeed/news/2/0?ch=news',
];
const MAX = 300;

function get(url, hops = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
        'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
      },
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        const next = res.headers.location.startsWith('http') ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return resolve(get(next, hops - 1));
      }
      const buf = [];
      res.on('data', c => buf.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(buf).toString('utf8') }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
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
    const desc  = v('description').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const pub   = v('pubDate');
    return title && link ? [{ title, link, desc, pub }] : [];
  });
}

function sourceName(url) {
  if (url.includes('google.com')) return 'Google新聞';
  if (url.includes('cna'))       return '中央社';
  if (url.includes('ltn'))       return '自由時報';
  if (url.includes('ettoday'))   return 'ETtoday';
  if (url.includes('udn'))       return '聯合新聞網';
  return '新聞';
}

async function main() {
  const news = JSON.parse(fs.readFileSync('news.json', 'utf8'));
  const seen = new Set(news.map(n => n.link));
  console.log(`Existing: ${news.length} items`);

  for (const feed of FEEDS) {
    try {
      console.log(`Fetching ${feed}`);
      const { status, body } = await get(feed);
      console.log(`  status=${status} size=${body.length}`);
      if (status !== 200) { console.log('  non-200, skip'); continue; }

      const items = parse(body);
      console.log(`  parsed=${items.length} items`);
      if (!items.length) { console.log('  first300:', body.slice(0, 300)); continue; }

      const fresh = items.find(i => !seen.has(i.link));
      if (fresh) {
        news.unshift({ title: fresh.title, link: fresh.link, desc: fresh.desc,
                       pub: fresh.pub, source: sourceName(feed),
                       at: new Date().toISOString() });
        fs.writeFileSync('news.json', JSON.stringify(news.slice(0, MAX), null, 2));
        console.log('✓ Added:', fresh.title);
        return;
      }
      console.log('  all seen, try next feed');
    } catch (e) {
      console.error('✗', feed, e.message);
    }
  }
  console.log('No new items.');
}

main().catch(e => { console.error(e.message); process.exit(0); });
