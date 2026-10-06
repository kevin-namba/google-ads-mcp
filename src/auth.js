// `google-ads-mcp auth` — ブラウザで Google と連携し、refresh token を取る。
//
// OAuth クライアントは Google Cloud コンソールで「デスクトップ アプリ」として
// 作る（ループバックの redirect URI は任意のポートで通る）。

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const SCOPE = "https://www.googleapis.com/auth/adwords";

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url.replaceAll("&", "^&")]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  } catch {
    // 開けなくても、表示した URL を手で開けば進められる
  }
}

export async function runAuth(argv = []) {
  const clientId = option(argv, "client-id") || process.env.GOOGLE_ADS_CLIENT_ID;
  const clientSecret = option(argv, "client-secret") || process.env.GOOGLE_ADS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    process.stderr.write(
      "OAuth クライアントが指定されていません。\n" +
        "GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET を環境変数で渡すか、\n" +
        "--client-id <ID> --client-secret <SECRET> を付けてください。\n",
    );
    process.exit(2);
  }

  const state = randomBytes(16).toString("hex");
  const server = createServer();
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;

  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPE,
      // offline + consent でないと refresh token が返らない（2 回目以降は省かれる）
      access_type: "offline",
      prompt: "consent",
      state,
    });

  process.stdout.write(`ブラウザで次の URL を開いて、Google 広告を操作するアカウントで許可してください:\n\n${authUrl}\n\n`);
  openBrowser(authUrl);

  const code = await new Promise((done, fail) => {
    server.on("request", (req, res) => {
      const params = new URL(req.url, redirectUri).searchParams;
      if (!params.has("code") && !params.has("error")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      if (params.get("state") !== state) {
        res.end("<p>state が一致しません。もう一度やり直してください。</p>");
        fail(new Error("state が一致しません"));
      } else if (params.has("error")) {
        res.end("<p>連携が許可されませんでした。このタブは閉じて構いません。</p>");
        fail(new Error(`連携が許可されませんでした: ${params.get("error")}`));
      } else {
        res.end("<p>連携できました。このタブを閉じて、ターミナルに戻ってください。</p>");
        done(params.get("code"));
      }
    });
  }).finally(() => server.close());

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.refresh_token) {
    process.stderr.write(`refresh token を取得できませんでした（HTTP ${res.status}）: ${JSON.stringify(data)}\n`);
    process.exit(1);
  }

  process.stdout.write(
    "連携できました。MCP サーバーの環境変数に次を設定してください" +
      "（パスワードと同じ扱いで保管してください）:\n\n" +
      `GOOGLE_ADS_REFRESH_TOKEN=${data.refresh_token}\n`,
  );
}
