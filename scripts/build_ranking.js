/**
 * 差し入れランキング生成スクリプト
 *
 * 9/30 から: 楽天市場の「ランキング API」（ジャンル別の売れ筋順・1000 位まで）から、
 * config.json の枠（slots）の条件に合う商品を拾い、楽天の順位のまま並べて ranking.json を出す。
 * ランキングで埋まらなかった枠は、従来どおり商品検索 API（標準ソート＝売れ筋ベース）で 1 枠 1 商品を補う。
 * 前日の ranking.json と比べて、上がった／下がった／初登場 の印（mv）も付ける。
 *
 * 使い方:
 *   RAKUTEN_APP_ID=xxx RAKUTEN_ACCESS_KEY=yyy node scripts/build_ranking.js
 *   node scripts/build_ranking.js --mock   … API を呼ばずダミーデータで生成（ページの表示確認用）
 *
 * ランキングの客観性:
 *   - 掲載順 = 楽天のランキング順位（ジャンル別）。恣意的な並べ替えはしない
 *   - 検索で補った商品はランキング由来の後ろに、レビュー件数順で置く（src: 'search' で区別）
 *   （景表法の有利誤認リスク回避・企画の信頼性維持）
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
const COMMUNITY = config.community || {};
const RANKING = config.ranking || {};
const RANK_PAGES = Math.max(1, Math.min(34, RANKING.pages || 20));   // ジャンルごとに読むページ数（1 ページ 30 件）
const MAX_PER_SLOT = RANKING.maxPerSlot || 2;                          // 同じ枠（種類）から出す最大数
const PER_CAT = RANKING.perCategory || 10;                             // 1 枠あたりの掲載数
/* 検証用: COMMUNITY_URL で集計元を差し替え（ローカルの JSON ファイルも可） */
const COMMUNITY_URL = process.env.COMMUNITY_URL || COMMUNITY.url || '';

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

/* 2026年の楽天API刷新後の新エンドポイント（旧 app.rakuten.co.jp は2026-05-14停止）
   バージョンは廃止されると 400 {"error":"wrong_parameter","error_description":"API Configuration not found"}
   になり全スロットが落ちる。ドキュメントの「古いバージョン」から消えたら差し替えること。
   （20220601 は 2026-08-18 に廃止済みを確認 → 20260701 へ） */
const API = 'https://openapi.rakuten.co.jp/ichibams/api/IchibaItem/Search/20260701';
/* ランキング API（ジャンル別・30 件/ページ・最大 34 ページ）。バージョンは上から順に試し、通ったものを使う */
const RANK_APIS = [
  'https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20220601',
  'https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20260701',
  'https://openapi.rakuten.co.jp/ichibaranking/api/IchibaItem/Ranking/20260401'
];
let rankApi = null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const headers = { 'Origin': ORIGIN, 'User-Agent': 'sashiire-ranking/2.0 (+' + ORIGIN + '/sashiire/)' };

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

/* 楽天商品名の整形（表示用）。セール文言・期間・装飾を落として「ブランド 商品名 容量」に近づける */
function tidyName(name) {
  return String(name || '')
    .replace(/【[^】]*】/g, ' ')
    .replace(/［[^］]*］/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/＼[^／]*／/g, ' ')
    .replace(/＜[^＞]*＞/g, ' ')
    .replace(/≪[^≫]*≫/g, ' ')
    .replace(/《[^》]*》/g, ' ')
    .replace(/\d{1,2}\/\d{1,2}[^ 　]*?(まで|迄)/g, ' ')
    .replace(/(\d{1,2}月\d{1,2}日|\d{1,2}日)[^ 　]*?(まで|迄)/g, ' ')
    .replace(/\d{1,2}:\d{2}\s*(まで|迄)/g, ' ')
    .replace(/\d{1,2}\/\d{1,2}(\s*\d{1,2}:\d{2})?\s*[〜~～-]\s*(\d{1,2}\/\d{1,2})?(\s*\d{1,2}:\d{2})?/g, ' ')
    .replace(/\d{1,2}\/\d{1,2}/g, ' ')
    .replace(/\d{1,2}:\d{2}/g, ' ')
    .replace(/20\d{2}年?(度)?/g, ' ')
    .replace(/(本日限り|今だけ|\d+円ポッキリ|ポッキリ|期間限定|数量限定|新発売|話題の|大人気|人気No\.?\d*|ランキング\S*|受賞\S*)/g, ' ')
    .replace(/[★◆■▼☆●◎※]/g, ' ')
    .replace(/(送料無料|あす楽|即日発送|翌日配送|メール便|ネコポス|ゆうパケット|ポイント\d*倍|P\d+倍|公式|正規品|楽天\S*大賞\S*|\d+年連続\S*|クーポン\S*|最大\d+[%％]\S*|\d+[%％]OFF\S*|SALE|セール|限定|お買い得|激安|特価|訳あり)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
}
/* Amazon の検索語: 整形した商品名の先頭 3 語（数量・容量の語は除く）。短すぎるときは枠の検索語 */
function amazonQueryFor(name, fallback) {
  const toks = tidyName(name).split(/[\s　|｜／\/]+/)
    .filter(t => t.length >= 2 && t.length <= 20 && !/^[×xX]?\d+(個|本|袋|枚|箱|入|粒|錠|包|セット|g|ｇ|ml|ｍｌ|kg|L)/.test(t) && !/^\d+$/.test(t) && !/^[(（].*[)）]$/.test(t) && !/[。、！!？?♪]/.test(t));
  const q = toks.slice(0, 3).join(' ').slice(0, 40);
  return q.length >= 3 ? q : fallback;
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
  const res = await fetch(`${API}?${params}`, { headers });
  if (!res.ok) throw new Error(`Rakuten API ${res.status} for "${query}": ${(await res.text()).slice(0,200)}`);
  const data = await res.json();
  return data.Items || [];
}

/* ランキング API を 1 ページ読む。返る形（formatVersion の有無）の違いを吸収して商品の配列にする */
async function fetchRankingPage(genreId, page) {
  const apis = rankApi ? [rankApi] : RANK_APIS;
  let lastErr = null;
  for (const api of apis) {
    const params = new URLSearchParams({ applicationId: APP_ID, accessKey: ACCESS_KEY, genreId: String(genreId), page: String(page), formatVersion: '2' });
    if (!MOSHIMO.aId && RAKUTEN_AFF_ID) params.set('affiliateId', RAKUTEN_AFF_ID);
    const res = await fetch(`${api}?${params}`, { headers });
    if (!res.ok) { lastErr = new Error(`Rakuten Ranking API ${res.status} (${api.slice(-8)}) genre=${genreId} page=${page}: ${(await res.text()).slice(0,160)}`); await sleep(config.rules.requestIntervalMs); continue; }
    const data = await res.json();
    rankApi = api;
    return (data.Items || []).map(x => (x && x.Item) ? x.Item : x).filter(Boolean);
  }
  throw lastErr || new Error('ranking api unavailable');
}

/* ジャンルの売れ筋を上位から集める（ページ数は config.ranking.pages）。失敗したページは飛ばす */
async function fetchGenreRanking(genreId) {
  const out = [];
  for (let p = 1; p <= RANK_PAGES; p++) {
    try {
      const items = await fetchRankingPage(genreId, p);
      if (!items.length) break;
      items.forEach(it => { if (!it.rank) it.rank = (p - 1) * 30 + out.length % 30 + 1; out.push(it); });
    } catch (err) {
      console.warn(`WARN: ランキング genre=${genreId} page=${p} 取得失敗（スキップ）:`, err.message);
      if (p === 1) break;   // 1 ページ目から落ちる＝この API 自体が使えない
    } finally {
      await sleep(config.rules.requestIntervalMs);
    }
  }
  return out;
}

/* 商品が枠（slot）の条件に合うか。must（未指定ならクエリの先頭語）が含まれ、slot.ban が含まれないこと。
   strict（ランキング由来）は商品名＋キャッチコピーだけで判定する。説明文まで見ると
   「入浴剤にも使えます」のような一言でキッチンスポンジが入浴剤の枠に入る（9/30 に発生） */
function slotMatches(it, slot, strict) {
  const must = (slot.must && slot.must.length) ? slot.must : [String(slot.query).split(/\s+/)[0]];
  const nameText = `${it.itemName || ''} ${it.catchcopy || ''}`;
  const text = strict ? nameText : `${nameText} ${it.itemCaption || ''}`;
  if ((slot.ban || []).some(b => nameText.includes(b))) return false;
  return must.some(m => text.includes(m));
}
/* 用途違い・禁止語・低評価などの共通の除外 */
function itemOk(it, minReviewAvg, priceRule) {
  if (!it.itemUrl) return false;
  if (it.reviewCount > 0 && it.reviewAverage < minReviewAvg) return false;
  if (priceRule && (it.itemPrice < priceRule.min || it.itemPrice > priceRule.max)) return false;
  if (String(it.availability ?? '1') === '0') return false;
  const nameText = `${it.itemName || ''} ${it.catchcopy || ''}`;
  if ((config.rules.banWords || []).some(b => nameText.includes(b))) return false;
  if (NG && ngHit(nameText)) return false;   // 洋酒入りのお菓子などを、定番枠でも出さない
  return true;
}
function pickItem(items, minReviewAvg, slot) {
  for (const it of items) {
    if (!itemOk(it, minReviewAvg, null)) continue;
    if (!slotMatches(it, slot, false)) continue;
    return it;
  }
  return null;
}

/* ── みんなが探している差し入れ ─────────────────────────────
   併せーる・差し入れサイトの「差し入れを探す」で検索された言葉（3人以上が探したものだけ・
   運営者が非表示にした語は除外済み）を jyounetsu.site から受け取り、各語の代表商品を楽天から1つ選ぶ。
   掲載順は「探した人数」の降順（客観指標）。集計元に届かないときはこの枠だけ出さない（本体の更新は止めない） */
/* 表記ゆれ（カタカナ/ひらがな・全角半角・大文字小文字・空白）をならして比較する */
function norm(s) {
  return String(s || '').normalize('NFKC').toLowerCase()
    .replace(/[ァ-ヶ]/g, c => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・ー\-_]+/g, '');
}
async function fetchCommunityTerms() {
  if (!COMMUNITY.enabled || !COMMUNITY_URL) return [];
  try {
    let data;
    if (/^https?:/.test(COMMUNITY_URL)) {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15000);
      const res = await fetch(COMMUNITY_URL, { signal: ctl.signal, headers: { 'User-Agent': 'sashiire-ranking/2.0' } });
      clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      data = await res.json();
    } else {
      data = JSON.parse(fs.readFileSync(COMMUNITY_URL, 'utf8'));
    }
    return (data.items || []).filter(x => x && x.t && x.n > 0);
  } catch (err) {
    console.warn('WARN: みんなの検索ランキングを取得できませんでした（この枠はスキップ）:', err.message);
    return [];
  }
}
/* 禁止語（未成年も使うため：成人向け・酒・たばこ・医薬品など）。正本は jyounetsu.site/awase/api/ngwords.json
   （併せーる・差し入れサイトと共通）。読めないときは「みんなが探している差し入れ」枠を出さない（安全側） */
let NG = null;
async function loadNg() {
  const url = process.env.NG_URL || COMMUNITY.ngUrl;
  if (!url) throw new Error('community.ngUrl が未設定');
  let d;
  if (/^https?:/.test(url)) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'sashiire-ranking/2.0' } });
    clearTimeout(t);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    d = await res.json();
  } else {
    d = JSON.parse(fs.readFileSync(url, 'utf8'));
  }
  const n = a => (a || []).map(norm).filter(Boolean);
  if (!d || !d.words || !d.words.length) throw new Error('禁止語の一覧が空');
  NG = { words: n(d.words), exact: n(d.exact), allow: n(d.allow) };
}
function ngHit(text) {
  if (!NG) return true;
  let k = norm(text);
  if (NG.exact.includes(k)) return true;
  NG.allow.forEach(a => { k = k.split(a).join(''); });
  return NG.words.some(w => k.includes(w));
}
/* 検索語はユーザー入力なので、本体の除外語・追加の除外語・禁止語で商品名を確認する */
function communityPick(items, term) {
  const key = norm(term.split(/\s+/)[0]);
  const ban = (config.rules.banWords || []).concat(COMMUNITY.banWords || []);
  for (const it of items) {
    if (it.reviewCount > 0 && it.reviewAverage < config.rules.minReviewAvg) continue;
    if (!it.itemUrl) continue;
    const text = norm(`${it.itemName || ''} ${it.catchcopy || ''} ${it.itemCaption || ''}`);
    if (key && !text.includes(key)) continue;           // 関連性ガード（検索語の先頭語が含まれること）
    const nameText = `${it.itemName || ''} ${it.catchcopy || ''}`;
    if (ban.some(b => nameText.includes(b) || norm(nameText).includes(norm(b)))) continue;
    if (ngHit(nameText)) continue;
    return it;
  }
  return null;
}
async function buildCommunity() {
  if (!COMMUNITY.enabled) return null;
  if (!NG) { console.warn('WARN: 禁止語の一覧を読めないため「みんなが探している差し入れ」は出しません'); return null; }
  const terms = (await fetchCommunityTerms()).filter(x => !ngHit(x.t));
  if (!terms.length) return null;
  const max = COMMUNITY.max || 5;
  const items = [];
  for (const term of terms) {
    if (items.length >= max) break;
    let it = null;
    if (MOCK) {
      it = mockItem({ label: term.t }, items.length);
    } else {
      try {
        it = communityPick(await searchRakuten(term.t, COMMUNITY.price || { min: 200, max: 3000 }), term.t);
      } catch (err) {
        console.warn(`WARN: みんなの検索 "${term.t}" の取得に失敗（スキップ）:`, err.message);
      } finally {
        await sleep(config.rules.requestIntervalMs);
      }
    }
    if (!it) { console.warn(`WARN: みんなの検索 "${term.t}" は条件を満たす商品なし（スキップ）`); continue; }
    items.push(toItem(it, { label: term.t, note: `直近90日で${term.n}人が探しています`, query: term.t }, { people: term.n, src: 'search' }));
  }
  if (!items.length) return null;
  items.forEach((it, i) => { it.rank = i + 1; });   // 探した人数の順のまま
  return { id: 'community', title: COMMUNITY.title || 'みんなが探している差し入れ', lead: COMMUNITY.lead || '', community: true, items };
}
function toItem(it, slot, extra) {
  const img = (it.mediumImageUrls && it.mediumImageUrls[0]) || '';
  const name = tidyName(it.itemName);
  return Object.assign({
    label: slot.label,
    note: slot.note,
    name,
    code: String(it.itemCode || ''),
    price: it.itemPrice,
    image: typeof img === 'string' ? img : (img.imageUrl || ''),
    rakutenUrl: MOSHIMO.aId ? moshimoWrap(it.itemUrl) : (it.affiliateUrl || it.itemUrl),
    /* Amazon は商品名（ブランド＋商品）で検索。整形後に短すぎる名前は枠の検索語 */
    amazonUrl: amazonSearchUrl(amazonQueryFor(it.itemName, slot.query)),
    reviewAvg: it.reviewAverage || 0,
    reviewCount: it.reviewCount || 0,
    shop: it.shopName || ''
  }, extra || {});
}

const MOCK_NAMES = {
  sweets: ['ブルボン アルフォート ミニチョコレート 12個×10箱', '不二家 カントリーマアム 大袋 20枚', '森永 ラムネ 大粒 ヨーグルト味 ×6袋', '江崎グリコ ビスコ 小分けパック 2枚×24', 'アサヒ ミンティア ワイルド＆クール 50粒 ×10', '亀田製菓 ハッピーターン 個包装 108g', 'カバヤ さくさくぱんだ 個包装 大袋', '井村屋 片手で食べられる小さなようかん 7本', '明治 果汁グミ 個包装 アソート', 'ロッテ のど飴 個包装 大袋'],
  goods: ['花王 めぐりズム 蒸気でホットアイマスク 無香料 12枚', '花王 バブ 入浴剤 個包装 アソート 12錠', 'マンダム ギャツビー ボディペーパー 無香料 30枚', 'ニベア モイスチャーリップ 無香料', 'カバヤ 塩分チャージタブレット 個包装 3袋', 'ギャツビー あぶらとり紙 フィルムタイプ 75枚×3', 'ユニ・チャーム 超快適マスク 個包装 30枚', 'ジョンソン バンドエイド キズパワーパッド スリム', 'シルコット 除菌ウェットティッシュ 携帯用 ×3', '小林製薬 桐灰 貼らないカイロ 30個']
};
function mockItem(slot, i, catId) {
  const names = MOCK_NAMES[catId] || [];
  return {
    itemName: names[i] || `${slot.label} のサンプル商品（モック表示）`,
    itemCode: `mock:${catId || 'x'}-${i}`,
    itemPrice: 500 + i * 137,
    itemUrl: 'https://www.rakuten.co.jp/',
    mediumImageUrls: [],
    reviewAverage: 4.2,
    reviewCount: 1200 - i * 83,
    shopName: 'サンプルショップ',
    rank: i + 1
  };
}

/* 前回の ranking.json（比較用）。無ければ空 */
function loadPrev() {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, 'ranking.json'), 'utf8'));
    const m = {};
    (d.categories || []).forEach(c => { m[c.id] = {}; (c.items || []).forEach(it => { if (it.code) m[c.id][it.code] = it.rank; }); });
    return m;
  } catch (e) { return {}; }
}
/* 前日との比べ: new（初登場）／up（上がった）／down（下がった）／same */
function markMoves(cat, prev) {
  const p = prev[cat.id] || {};
  cat.items.forEach(it => {
    const was = it.code ? p[it.code] : undefined;
    if (was === undefined) { it.mv = 'new'; it.mvN = 0; }
    else if (was > it.rank) { it.mv = 'up'; it.mvN = was - it.rank; }
    else if (was < it.rank) { it.mv = 'down'; it.mvN = it.rank - was; }
    else { it.mv = 'same'; it.mvN = 0; }
  });
}

/* 1 カテゴリ分: ランキング由来（楽天の順位のまま）→ 足りない枠を検索で補う */
async function buildCategory(cat, month) {
  const slots = cat.slots.filter(s => !s.months || s.months.includes(month));
  const items = [];
  const perSlot = {};
  const seen = new Set();
  const require = cat.require || [];

  if (MOCK) {
    slots.slice(0, PER_CAT).forEach((slot, i) => items.push(toItem(mockItem(slot, i, cat.id), slot, { src: 'rank', rankSrc: (i + 1) * 3 })));
  } else if (cat.genres && cat.genres.length) {
    /* ジャンル別の売れ筋を集めて、楽天の順位順に並べる（複数ジャンルは順位でまとめて並べる） */
    let pool = [];
    for (const g of cat.genres) {
      const list = await fetchGenreRanking(g);
      console.log(`  genre ${g}: ${list.length} 件`);
      list.forEach(it => { it._genre = g; });
      pool = pool.concat(list);
    }
    pool.sort((a, b) => (a.rank || 9999) - (b.rank || 9999));
    for (const it of pool) {
      if (items.length >= PER_CAT) break;
      const code = String(it.itemCode || '');
      if (!code || seen.has(code)) continue;
      if (!itemOk(it, config.rules.minReviewAvg, cat.price)) continue;
      if (require.length && !require.some(w => `${it.itemName || ''} ${it.catchcopy || ''}`.includes(w))) continue;
      const slot = slots.find(s => slotMatches(it, s, true));
      if (!slot) continue;
      if ((perSlot[slot.label] || 0) >= MAX_PER_SLOT) continue;
      perSlot[slot.label] = (perSlot[slot.label] || 0) + 1;
      seen.add(code);
      items.push(toItem(it, slot, { src: 'rank', rankSrc: it.rank || null, genre: it._genre }));
    }
    console.log(`  ランキング由来: ${items.length} 件（枠: ${Object.keys(perSlot).join('・') || 'なし'}）`);
  }

  /* 補充: まだ商品が無い枠を検索で（従来の方式）。ランキング由来の後ろにレビュー件数順 */
  if (!MOCK && items.length < PER_CAT) {
    const fills = [];
    for (const slot of slots) {
      if (perSlot[slot.label]) continue;
      if (items.length + fills.length >= PER_CAT) break;
      let it = null;
      try {
        const found = (await searchRakuten(slot.query, cat.price)).filter(x => !seen.has(String(x.itemCode || '')));
        it = pickItem(found, config.rules.minReviewAvg, slot);
      } catch (err) {
        console.warn(`WARN: "${slot.query}" の取得に失敗（スキップ）:`, err.message);
      } finally {
        /* 楽天APIのレート制限（1req/秒）対策。失敗時こそ間隔を空ける */
        await sleep(config.rules.requestIntervalMs);
      }
      if (!it) { console.warn(`WARN: "${slot.query}" は条件を満たす商品なし（スキップ）`); continue; }
      seen.add(String(it.itemCode || ''));
      fills.push(toItem(it, slot, { src: 'search', rankSrc: null }));
    }
    fills.sort((a, b) => b.reviewCount - a.reviewCount);
    console.log(`  検索で補充: ${fills.length} 件`);
    items.push(...fills);
  }

  const top = items.slice(0, PER_CAT);
  top.forEach((it, i) => { it.rank = i + 1; });
  return { id: cat.id, title: cat.title, lead: cat.lead, items: top };
}

async function main() {
  const month = jstMonth();
  const prev = loadPrev();
  const out = {
    updated: jstDate(),
    updatedAt: new Date().toISOString(),
    month,
    basis: '楽天市場の売れ筋ランキング（ジャンル別）から、個包装など差し入れ向きの条件に合う商品を自動で選び、楽天の順位のまま掲載。足りない枠は検索の売れ筋順で補う。毎日自動更新',
    avoid: config.avoid || [],
    mock: MOCK || undefined,
    categories: []
  };

  /* 禁止語の一覧（定番枠の商品名チェックにも使う。読めないときは定番枠は従来どおり、みんなの枠は出さない） */
  if (COMMUNITY.enabled) { try { await loadNg(); } catch (err) { console.warn('WARN: 禁止語の一覧を読めませんでした:', err.message); } }

  for (const cat of config.categories) {
    console.log(`== ${cat.id}`);
    const built = await buildCategory(cat, month);
    markMoves(built, prev);
    out.categories.push(built);
  }

  /* みんなが探している差し入れ（あれば先頭に） */
  const community = await buildCommunity();
  if (community) { markMoves(community, prev); out.categories.unshift(community); }

  const json = JSON.stringify(out, null, 1);
  fs.writeFileSync(path.join(ROOT, 'ranking.json'), json);
  // ローカル確認・非常用の同梱コピー（siteフォルダがある環境のみ）
  if (fs.existsSync(path.join(ROOT, 'site'))) fs.writeFileSync(path.join(ROOT, 'site', 'ranking.json'), json);
  const total = out.categories.filter(c => !c.community).reduce((a, c) => a + c.items.length, 0);
  console.log(`ranking.json generated: ${total} items (${out.updated}${MOCK ? ' / MOCK' : ''})`);
  if (!MOCK && total === 0) { console.error('ERROR: 商品が1件も取得できませんでした'); process.exit(1); }
}

main().catch(err => { console.error(err); process.exit(1); });
