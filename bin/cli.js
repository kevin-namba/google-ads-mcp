#!/usr/bin/env node
// 入口。引数なしなら MCP サーバー（stdio）、`auth` なら refresh token の取得。
//
// **stdout は MCP の通信路**なので、サーバーとして動いている間は stdout に
// 何も書かない（ログは stderr）。

const command = process.argv[2];

if (command === "auth") {
  const { runAuth } = await import("../src/auth.js");
  await runAuth(process.argv.slice(3));
} else if (command === "--help" || command === "-h" || command === "help") {
  process.stdout.write(
    [
      "google-ads-mcp — Google 広告（Google Ads API）の MCP サーバー",
      "",
      "使い方:",
      "  google-ads-mcp          MCP サーバーを stdio で起動する",
      "  google-ads-mcp auth     ブラウザで Google と連携し、refresh token を表示する",
      "",
      "環境変数:",
      "  GOOGLE_ADS_DEVELOPER_TOKEN     開発者トークン（必須）",
      "  GOOGLE_ADS_CLIENT_ID           OAuth クライアント ID（必須）",
      "  GOOGLE_ADS_CLIENT_SECRET       OAuth クライアントシークレット（必須）",
      "  GOOGLE_ADS_REFRESH_TOKEN       refresh token（必須。auth で取得できる）",
      "  GOOGLE_ADS_CUSTOMER_ID         既定の顧客 ID（ツールの customer_id で上書き可）",
      "  GOOGLE_ADS_LOGIN_CUSTOMER_ID   MCC 経由で操作するときの管理者アカウント ID",
      "  GOOGLE_ADS_API_VERSION         API バージョン（既定 v25）",
      "  GOOGLE_ADS_READ_ONLY           true で書き込みツールを公開しない",
      "",
    ].join("\n"),
  );
} else if (command) {
  process.stderr.write(`不明なコマンドです: ${command}（--help で使い方を表示）\n`);
  process.exit(2);
} else {
  const { runServer } = await import("../src/server.js");
  await runServer();
}
