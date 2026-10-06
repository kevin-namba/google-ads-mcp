# google-ads-mcp

Google 広告（Google Ads API）を Claude などの MCP クライアントから操作するための MCP サーバーです。
`npx` で起動します。実績の取得、キーワードプランナー、検索広告と P-MAX の入稿、配信の開始・停止、予算の変更ができます。

## 必要なもの

| | 取得場所 |
|---|---|
| 開発者トークン | Google 広告の管理者（MCC）アカウントの [API センター](https://ads.google.com/aw/apicenter)。本番アカウントを触るには「基本（Basic）アクセス」以上が必要です |
| OAuth クライアント ID / シークレット | Google Cloud コンソールで Google Ads API を有効にし、種類「デスクトップ アプリ」の OAuth クライアントを作成 |
| refresh token | 下記の `auth` コマンドで取得 |
| 顧客 ID | Google 広告の管理画面右上の 10 桁の番号（広告を配信しているアカウントのもの。MCC の ID ではない） |

Node.js 18.17 以上が必要です。サービスアカウントでは動きません（Google 広告はアカウントにユーザーとして招待された Google アカウントが必要です）。

## セットアップ

### 1. refresh token を取得する

```bash
GOOGLE_ADS_CLIENT_ID=xxx GOOGLE_ADS_CLIENT_SECRET=yyy npx -y github:trip-clear/google-ad-mcp auth
```

ブラウザが開くので、Google 広告を操作できる Google アカウントで許可します。ターミナルに `GOOGLE_ADS_REFRESH_TOKEN=...` が表示されます。

### 2. MCP クライアントに登録する

Claude Code:

```bash
claude mcp add google-ads \
  -e GOOGLE_ADS_DEVELOPER_TOKEN=... \
  -e GOOGLE_ADS_CLIENT_ID=... \
  -e GOOGLE_ADS_CLIENT_SECRET=... \
  -e GOOGLE_ADS_REFRESH_TOKEN=... \
  -e GOOGLE_ADS_CUSTOMER_ID=123-456-7890 \
  -- npx -y github:trip-clear/google-ad-mcp
```

Claude Desktop など（`mcpServers` の設定）:

```json
{
  "mcpServers": {
    "google-ads": {
      "command": "npx",
      "args": ["-y", "github:trip-clear/google-ad-mcp"],
      "env": {
        "GOOGLE_ADS_DEVELOPER_TOKEN": "...",
        "GOOGLE_ADS_CLIENT_ID": "...",
        "GOOGLE_ADS_CLIENT_SECRET": "...",
        "GOOGLE_ADS_REFRESH_TOKEN": "...",
        "GOOGLE_ADS_CUSTOMER_ID": "123-456-7890"
      }
    }
  }
}
```

`github:trip-clear/google-ad-mcp` は、この GitHub リポジトリから直接取得して起動する指定です（npm には公開していません）。リポジトリを clone してある場合は、そのパスを渡しても同じように動きます（`npx -y /path/to/google-ad-mcp`）。

### 3. 疎通を確かめる

クライアントから `google_ads_account_info` を呼び、アカウント名と通貨が返れば接続できています。

## 環境変数

| 変数 | 必須 | 内容 |
|---|---|---|
| `GOOGLE_ADS_DEVELOPER_TOKEN` | ○ | 開発者トークン |
| `GOOGLE_ADS_CLIENT_ID` | ○ | OAuth クライアント ID |
| `GOOGLE_ADS_CLIENT_SECRET` | ○ | OAuth クライアントシークレット |
| `GOOGLE_ADS_REFRESH_TOKEN` | ○ | refresh token |
| `GOOGLE_ADS_CUSTOMER_ID` | | 既定の顧客 ID。各ツールの `customer_id` 引数で上書きできます |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | | MCC 経由で子アカウントを操作するときの MCC の ID |
| `GOOGLE_ADS_API_VERSION` | | API バージョン。既定 `v25` |
| `GOOGLE_ADS_READ_ONLY` | | `true` にすると書き込みツールを公開しません |

## ツール

読み取り:

| ツール | 内容 |
|---|---|
| `google_ads_list_accessible_customers` | 連携したアカウントが操作できる顧客 ID の一覧 |
| `google_ads_account_info` | アカウント名・通貨・タイムゾーン・MCC かどうか |
| `google_ads_report` | 期間の実績（アカウント / キャンペーン / 広告グループ別、日次も可） |
| `google_ads_list_objects` | キャンペーン / 広告グループ / 広告の一覧と状態・予算 |
| `google_ads_search` | 任意の GAQL を実行（検索語句、キーワード別実績など） |
| `google_ads_keywords` | キーワードプランナー（月間検索ボリューム・競合性・入札レンジ） |

書き込み（`GOOGLE_ADS_READ_ONLY=true` では非公開）:

| ツール | 内容 |
|---|---|
| `google_ads_create_budget` | キャンペーン予算を作成 |
| `google_ads_create_campaign` | キャンペーンを作成（検索 / P-MAX） |
| `google_ads_create_ad_group` | 広告グループを作成 |
| `google_ads_add_keywords` | キーワード / 除外キーワードを追加 |
| `google_ads_create_responsive_search_ad` | レスポンシブ検索広告を作成 |
| `google_ads_create_asset_group` | P-MAX のアセットグループを作成（画像はローカルパスか URL） |
| `google_ads_update_status` | 配信の開始（ENABLED）・停止（PAUSED） |
| `google_ads_update_budget` | 日予算を変更 |
| `google_ads_remove` | キャンペーン / 広告グループ / 広告を削除（元に戻せません） |
| `google_ads_mutate` | 上記で足りない操作を `googleAds:mutate` に直接送る |

入稿の順番は決まっています。

```
google_ads_create_budget
  └─ google_ads_create_campaign
       ├─ 検索:   google_ads_create_ad_group → google_ads_add_keywords / google_ads_create_responsive_search_ad
       └─ P-MAX: google_ads_create_asset_group
```

## 書き込みの安全策

Google Ads API の `adwords` スコープは読み取りと書き込みが分かれていません。このサーバーは次の形で事故を防ぎます。

- 作成するものはすべて既定で `PAUSED` です。配信の開始は `google_ads_update_status` を別に呼ぶ必要があります。
- 検索キャンペーンは、明示しない限り検索パートナーとディスプレイに配信しません。
- 見出し・説明文の本数と文字数（全角は 2 文字と数えます）は、Google に送る前に検算します。
- `google_ads_create_asset_group` と `google_ads_mutate` は `validate_only=true` で、何も変更せずに Google 側の検算だけ行えます。
- 分析だけに使うなら `GOOGLE_ADS_READ_ONLY=true` を設定してください。

書き込みツールを実際に実行するかどうかの承認は、MCP クライアント側の許可設定に任せています。書き込みツールを自動許可にしないことをおすすめします。

## 数字の読み方

- `costMicros` / `amountMicros` は、通貨に関係なく 100 万で割ると通貨 1 単位（円なら円）になります。
- `impressions` / `clicks` / `costMicros` は文字列で返ります。`conversions` は小数になりえます。
- `metrics.ctr` は 0〜1 の比率です（% ではありません）。
- `metrics.conversions` の定義は、Google 広告の管理画面で「コンバージョン列に含める」としたアクションの合計です。
- キーワードプランナーの `avg_monthly_searches` が `null` のときは 0 ではなく「データ無し」です。`competition` は広告枠の競合度であり、SEO の難易度ではありません。

## トラブルシューティング

| 症状 | 原因と対処 |
|---|---|
| `DEVELOPER_TOKEN_NOT_APPROVED` | 開発者トークンが Test のままです。基本アクセスを申請するか、テストアカウントで検証します |
| `USER_PERMISSION_DENIED` | 連携した Google アカウントがその顧客 ID のユーザーではありません。MCC 配下なら `GOOGLE_ADS_LOGIN_CUSTOMER_ID` を設定します |
| `CUSTOMER_NOT_FOUND` | 顧客 ID が違います。`google_ads_list_accessible_customers` で確認します |
| `invalid_grant` | refresh token が失効しています。`auth` で取り直します |
| 実績が常に空 | MCC の ID を指定しています。配信している子アカウントの ID を指定します |
| 広告の停止・削除で ID エラー | 広告の ID は `{広告グループID}~{広告ID}` です。一覧の `resourceName` をそのまま渡せます |

## 開発

```bash
npm install
npm test          # Google への通信はモック
node bin/cli.js   # stdio で起動
```

## ライセンス

MIT
