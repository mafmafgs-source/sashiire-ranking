/**
 * 差し入れランキング生成スクリプト
 *
 * config.json のクエリリスト（ホワイトリスト）ごとに楽天市場API（標準ソート=売れ筋ベース）で
 * 代表商品を1つ選び、レビュー件数順に並べて ranking.json を出力する。
 *
 * 使い方:
 *   RAKUTEN_APP_ID=xxx RAKUTEN_ACCESS_KEY=yyy node scripts/build_ranking.js
 *   node scripts/build_ranking.js --mock   … API を呼ばずダミーデータで生成（ページの表示確認用）
 *
 * ランキングの客観性:
 *   - 商品選定 = 楽天の標準ソート先頭（売れ筋ベース）から条件を満たす最初の商品
 *   - 掲載順   = 選ばれた商品のレビュー件数の降順
 *   恣意的な並べ替えはしない（景表法の有利誤認リスク回避・企画の信頼性維持）
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const MOCK = process.argv.includes('--mock');
const APP_ID = process.env.RAKUTEN_APP_ID || '';
const ACCESS_KEY = process.env.RAKUTEN_ACCESS_KEY || '';
const AMAZON_TAG = config.amazonTag || '';
const MOSHIMO = config.moshimo || {};
const RAKUTEN_AFF_ID = config.rakutenAffiliateId || '';
const ORIGIN = config.siteOrigin || 'https://jyounetsu.site';

/* 収益の生命線バリデーション（モック時はスキップ） */
if (!MOCK) {
  if (!APP_ID) { console.error('ERROR: 環境変数 RAKUTEN_APP_ID が未設定です'); process.exit(1); }
  if (!ACCESS_KEY) { console.error('ERROR: 環境変数 RAKUTEN_ACCESS_KEY が未設定です（新APIの必須認証）'); process.exit(1); }
  if (!AMAZON_TAG) { console.error('ERROR: config.json の amazonTag が空です（Amazonリンクの収益がゼロになるため中断）'); process.exit(1); }
  if (!MOSHIMO.aId && !RAKUTEN_AFF_ID) { console.error('ERROR: 楽天の成果先が未設定です（moshimo.aId か rakutenAffiliateId のどちらかが必要）'); process.exit(1); }
}

/* もしもアフィリエイトの「どこでもリンク」形式で楽天URLを成果計測付きに包む */
function moshimoWrap(rakutenUrl) {
  if (!MOSHIMO.aId) return rakutenUrl;
  return `https://af.moshimo.com/af/c/click?a_id=${encodeURIComponent(MOSHIMO.aId)}&p_id=${encodeURIComponent(MOSHIMO.pId)}&pc_id=${encodeURIComponent(MOSHIMO.pcId)}&pl_id=${encodeURIComponent(MOSHIMO.plId)}&url=${encodeURIComponent(rakutenUrl)}`;
}

/* 2026年の楽天API刷新後の新エンドポイント（旧 app.rakuten.co.jp は2026-05-14停止） */
const API = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20220601';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* JST基準の現在月（季節枠の判定に使用） */
function jstMonth() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return now.getUTCMonth() + 1;
}
function jstDate() {
  const now = new Date(Date.now() + 9 * 3600 * 1000);
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${String(now.getUTCDate()).padStart(2, '0')}`;
}

function amazonSearchUrl(query) {
  return `https://www.amazon.co.jp/s?k=${encodeURIComponent(query)}${AMAZON_TAG ? `&tag=${encodeURIComponent(AMAZON_TAG)}` : ''}`;
}

/* 楽天商品名の軽い整形（表示用。検索には使わない） */
function tidyName(name) {
  return String(name || '')
    .replace(/【[^】]*】/g, '')
    .replace(/[★◆■▼☆●]/g, '')
    .replace(/(送料無料|あす楽|即日発送|メール便|ポイント\d*倍|公式|正規品)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}

async function searchRakuten(query, priceRule) {
  const params = new URLSearchParams({
    applicationId: APP_ID,
    accessKey: ACCESS_KEY,
    keyword: query,
    hits: '10',
    sort: 'standard',
    minPrice: String(priceRule.min),
    maxPrice: String(priceRule.max),
    availability: '1',
    formatVersion: '2'
  });
  /* もしも未設定時は本家アフィリエイトIDでAPIに成果付きURLを生成させる */
  if (!MOSHIMO.aId && RAKUTEN_AFF_ID) params.set('affiliateId', RAKUTEN_AFF_ID);
  const res = await fetch(`${API}?${params}`, {
    /* 新APIは「許可されたWebサイト」に登録したドメインのOriginヘッダが必須 */
    headers: { 'Origin': ORIGIN, 'User-Agent': 'sashiire-ranking/1.0 (+' + ORIGIN + '/sashiire/)' }
  });
  if (!res.ok) throw new Error(`Rakuten API ${res.status} for "${query}": ${(await res.text()).slice(0,200)}`);
  const data = await res.json();
  return data.Items || [];
}

function pickItem(items, minReviewAvg, slot) {
  /* 関連性ガード: must（未指定ならクエリの先頭語）が商品名・説明文に含まれない商品は
     キーワード盛りの無関係商品とみなして除外 */
  const must = (slot.must && slot.must.length) ? slot.must : [String(slot.query).split(/\s+/)[0]];
  const ban = (config.rules.banWords || []);
  for (const it of items) {
    if (it.reviewCount > 0 && it.reviewAverage < minReviewAvg) continue; // 低評価は除外（レビュー0件は許容）
    if (!it.itemUrl) continue;
    const text = `${it.itemName || ''} ${it.catchcopy || ''} ${it.itemCaption || ''}`;
    if (!must.some(m => text.includes(m))) continue;
    /* 用途違い（名入れギフト・記念品・業務用等）は商品名・キャッチコピーで除外 */
    const nameText = `${it.itemName || ''} ${it.catchcopy || ''}`;
    if (ban.some(b => nameText.includes(b))) continue;
    return it;
  }
  return null;
}

function mockItem(slot, i) {
  return {
    itemName: `${slot.label} のサンプル商品（モック表示）`,
    itemPrice: 500 + i * 137,
    itemUrl: 'https://www.rakuten.co.jp/',
    mediumImageUrls: [],
    reviewAverage: 4.2,
    reviewCount: 1200 - i * 83,
    shopName: 'サンプルショップ'
  };
}

async function main() {
  const month = jstMonth();
  const out = {
    updated: jstDate(),
    updatedAt: new Date().toISOString(),
    month,
    basis: '楽天市場の売れ筋（標準ソート）から各枠の代表商品を自動選定し、レビュー件数順に掲載。毎日自動更新',
    mock: MOCK || undefined,
    categories: []
  };

  for (const cat of config.categories) {
    const slots = cat.slots.filter(s => !s.months || s.months.includes(month));
    const items = [];
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      let it = null;
      if (MOCK) {
        it = mockItem(slot, i);
      } else {
        try {
          const found = await searchRakuten(slot.query, cat.price);
          it = pickItem(found, config.rules.minReviewAvg, slot);
          await sleep(config.rules.requestIntervalMs); // 楽天APIのレート制限（1req/秒）対策
        } catch (err) {
          console.warn(`WARN: "${slot.query}" の取得に失敗（スキップ）:`, err.message);
        }
      }
      if (!it) { console.warn(`WARN: "${slot.query}" は条件を満たす商品なし（スキップ）`); continue; }
      const img = (it.mediumImageUrls && it.mediumImageUrls[0]) || '';
      items.push({
        label: slot.label,
        note: slot.note,
        name: tidyName(it.itemName),
        price: it.itemPrice,
        image: typeof img === 'string' ? img : (img.imageUrl || ''),
        rakutenUrl: MOSHIMO.aId ? moshimoWrap(it.itemUrl) : (it.affiliateUrl || it.itemUrl),
        amazonUrl: amazonSearchUrl(slot.query),
        reviewAvg: it.reviewAverage || 0,
        reviewCount: it.reviewCount || 0,
        shop: it.shopName || ''
      });
    }
    /* 掲載順 = レビュー件数の降順（客観指標） */
    items.sort((a, b) => b.reviewCount - a.reviewCount);
    items.forEach((it, i) => { it.rank = i + 1; });
    out.categories.push({ id: cat.id, title: cat.title, lead: cat.lead, items });
  }

  const json = JSON.stringify(out, null, 1);
  fs.writeFileSync(path.join(ROOT, 'ranking.json'), json);
  // ローカル確認・非常用の同梱コピー（siteフォルダがある環境のみ）
  if (fs.existsSync(path.join(ROOT, 'site'))) fs.writeFileSync(path.join(ROOT, 'site', 'ranking.json'), json);
  const total = out.categories.reduce((a, c) => a + c.items.length, 0);
  console.log(`ranking.json generated: ${total} items (${out.updated}${MOCK ? ' / MOCK' : ''})`);
  if (!MOCK && total === 0) { console.error('ERROR: 商品が1件も取得できませんでした'); process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
