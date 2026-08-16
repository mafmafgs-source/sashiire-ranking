# コスプレ差し入れランキング

コスプレ併せへの差し入れ・プチプラコスメの定番を、楽天市場の売れ筋データから**毎日自動でランキング生成**する仕組み。

## 仕組み

```
config.json（クエリのホワイトリスト＝コスプレ知識の置き場）
   │  毎日6:00 JST（GitHub Actions）
   ▼
scripts/build_ranking.js ──楽天市場API（openapi.rakuten.co.jp）──▶ ranking.json（GitHub Pagesが配信・CORS可）
                                              ▲
index.html（ロリポップ /sashiire/ にFTPアップ）──fetch──┘
```

- **商品選定** = 楽天の標準ソート（売れ筋ベース）先頭から、在庫あり・価格帯内・低評価でないものを1枠1商品
- **掲載順** = レビュー件数の降順（客観指標。恣意的な並べ替えはしない）
- **季節枠** = `months` 指定で自動入替（夏＝塩分・冷感／冬＝カイロ・チョコ。チョコは夏に溶けるので除外）
- **関連性ガード** = 各枠の `must`（含まれるべき語）＋ `rules.banWords`（名入れ・還暦など用途違いの除外語）
- **Amazonリンク** = ホワイトリストのクエリをそのまま検索リンク化（タグ付与・本家アソシエイト）
- **楽天リンク** = もしもアフィリエイトのリンク形式で包む（configのmoshimoを空にすると本家rakutenAffiliateIdにフォールバック）
- カラーコンタクトは高度管理医療機器（広告規制の配慮）のため意図的に扱わない

## セットアップ（残タスク）

1. Settings → Secrets and variables → Actions に登録（**2つとも必須**）:
   - `RAKUTEN_APP_ID` … 楽天のアプリID
   - `RAKUTEN_ACCESS_KEY` … 楽天のアクセスキー（pk_…。**公開リポジトリのconfigには絶対に書かない**）
2. Settings → Pages → Branch: `main` / `(root)` → Save（ranking.json の配信用）
3. Actions タブ → `update-ranking` → Run workflow（初回手動実行）
4. Amazonアソシエイト管理画面のサイト情報に `jyounetsu.site` が登録されているか確認
5. `index.html` をロリポップの `/sashiire/` にFTPアップ

## ローカル確認（APIキーなしでOK）

```
node scripts/build_ranking.js --mock
```

## 運用

- 商品の入れ替え・追加は **config.json の slots を編集するだけ**（コードは触らない）
- 変な商品が紛れたら: その枠に `must` を足すか `rules.banWords` に追加
- Actionsが失敗しても前回のranking.jsonが残るのでページは壊れない（更新日表示で気づける）
- 将来: クリック実測ランキング／「もらって嬉しかった」投票、併せPlannerアプリの忘れ物タブからranking.jsonを読む統合
