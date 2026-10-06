// Google Ads API（REST）への唯一の経路。認証・ヘッダ・エラーの形をここに集める。
//
// 認証は OAuth（`adwords` スコープ）＋**開発者トークン**の二段。
// `adwords` は読み書きが分かれていないので、書き込みを止めたいときは
// GOOGLE_ADS_READ_ONLY か、MCP クライアント側の許可設定で守る。

import { digits } from "./config.js";

const TIMEOUT_MS = 60_000;
const TOKEN_URL = "https://oauth2.googleapis.com/token";

/** 引数の誤り。送る前にこちらで断ったもの。 */
export class ToolError extends Error {}

/** 設定不足・API のエラーなど「いまは実行できない」。hint に次の一手を書く。 */
export class Unavailable extends Error {
  constructor(reason, hint = "") {
    super(reason);
    this.hint = hint;
  }
}

const SETUP_HINT =
  "MCP サーバーの環境変数（GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET / " +
  "GOOGLE_ADS_REFRESH_TOKEN）を確かめてください。refresh token は " +
  "`npx -y github:trip-clear/google-ad-mcp auth` で取得できます。";

const ACCESS_HINT =
  "連携した Google アカウントがこの顧客 ID を操作できるか、MCC 配下なら " +
  "GOOGLE_ADS_LOGIN_CUSTOMER_ID が入っているか、開発者トークンのアクセスレベルが " +
  "本番アカウントに足りているか（Test では本番を触れません）を確かめてください。";

export function createClient(config, fetchImpl = globalThis.fetch) {
  let cached = null; // { token, expiresAt }

  async function send(url, init, what) {
    try {
      return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new Unavailable(`${what}: Google に到達できません: ${String(err?.message ?? err).slice(0, 200)}`);
    }
  }

  // 足りないものは**それぞれ別の文言**で返す。次にやることが全部違うので、
  // ひとまとめの「未設定です」にすると利用者が総当たりすることになる。
  async function accessToken() {
    if (!config.developerToken) {
      throw new Unavailable(
        "GOOGLE_ADS_DEVELOPER_TOKEN が設定されていません",
        "Google 広告の管理者（MCC）アカウントの API センター（https://ads.google.com/aw/apicenter）で開発者トークンを取得してください。",
      );
    }
    const missing = [
      ["GOOGLE_ADS_CLIENT_ID", config.clientId],
      ["GOOGLE_ADS_CLIENT_SECRET", config.clientSecret],
      ["GOOGLE_ADS_REFRESH_TOKEN", config.refreshToken],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) {
      throw new Unavailable(`${missing.join(" / ")} が設定されていません`, SETUP_HINT);
    }
    if (cached && cached.expiresAt > Date.now()) return cached.token;

    const res = await send(
      TOKEN_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          refresh_token: config.refreshToken,
        }),
      },
      "アクセストークンの発行",
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Unavailable(
        `アクセストークンを発行できません（HTTP ${res.status}）: ${text.slice(0, 300)}`,
        "invalid_grant は refresh token の失効です。`npx -y github:trip-clear/google-ad-mcp auth` で取り直してください。",
      );
    }
    const data = JSON.parse(text);
    cached = {
      token: data.access_token,
      expiresAt: Date.now() + (Number(data.expires_in || 3600) - 60) * 1000,
    };
    return cached.token;
  }

  async function headers() {
    const result = {
      Authorization: `Bearer ${await accessToken()}`,
      "developer-token": config.developerToken,
      "Content-Type": "application/json",
    };
    // MCC 配下のアカウントを触るときに要る。**付け忘れると権限不足と同じ
    // エラーになる**ので、値があるなら常に付ける
    if (config.loginCustomerId) result["login-customer-id"] = config.loginCustomerId;
    return result;
  }

  async function call(method, url, body, what) {
    const res = await send(
      url,
      { method, headers: await headers(), body: body === undefined ? undefined : JSON.stringify(body) },
      what,
    );
    const text = await res.text();
    if (!res.ok) {
      // エラー本文はそのまま添える——Google Ads の 400 は、どのフィールドが
      // どう悪いのかが本文にしか書かれていない。要約すると原因が消える
      throw new Unavailable(`${what}に失敗しました（HTTP ${res.status}）: ${text.slice(0, 1500)}`, ACCESS_HINT);
    }
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new Unavailable("Google Ads の応答を解釈できませんでした");
    }
  }

  const base = () => `https://googleads.googleapis.com/${config.apiVersion}`;

  return {
    config,

    /** ツールの `customer_id` 引数 → 環境変数の既定、の順で顧客 ID を決める。 */
    customerId(args = {}) {
      const id = digits(args.customer_id) || config.customerId;
      if (!id) {
        throw new Unavailable(
          "対象の Google 広告アカウント（顧客 ID）が決まっていません",
          "引数 customer_id を渡すか、GOOGLE_ADS_CUSTOMER_ID を設定してください。" +
            "操作できるアカウントは google_ads_list_accessible_customers で確認できます。",
        );
      }
      return id;
    },

    /**
     * 顧客 ID 配下のメソッドを POST する。`path` の付き方は 2 通りあるので、
     * 先頭が `:` ならスラッシュを挟まない（取り違えると 404 になる）:
     *   customers/{cid}/campaigns:mutate   … リソースを持つメソッド
     *   customers/{cid}:generateKeywordIdeas … 顧客に直接生えるメソッド
     */
    post(customerId, path, body, what) {
      const root = `${base()}/customers/${customerId}`;
      return call("POST", path.startsWith(":") ? `${root}${path}` : `${root}/${path}`, body, what);
    },

    /**
     * GAQL を 1 回投げて、全チャンクの行を平らにして返す。
     * searchStream の REST 応答は**チャンクの配列**（[{results: [...]}, ...]）。
     * 1 つ目だけ読むと大きい期間でだけ行が欠けるので、必ず全部を連結する。
     */
    async search(customerId, query, what = "データの取得") {
      const data = await this.post(customerId, "googleAds:searchStream", { query }, what);
      const chunks = Array.isArray(data) ? data : [data];
      return chunks.flatMap((chunk) => chunk?.results ?? []);
    },

    /**
     * `{endpoint}:mutate` を 1 回投げて、作られた resourceName を返す。
     * **partialFailure は付けない**——一部だけ成功した中途半端な状態が
     * 「成功」として返ると、どこまで出来たのかを人が調べて回ることになる。
     */
    async mutate(customerId, endpoint, operations, what) {
      const data = await this.post(customerId, `${endpoint}:mutate`, { operations }, what);
      return (data?.results ?? []).map((r) => String(r.resourceName ?? ""));
    },

    async listAccessibleCustomers() {
      const data = await call("GET", `${base()}/customers:listAccessibleCustomers`, undefined, "アカウント一覧の取得");
      return (data?.resourceNames ?? []).map((name) => String(name).split("/").pop());
    },
  };
}
