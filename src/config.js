// 設定の入口は環境変数だけ。MCP クライアントの `env` から渡す。

/** 顧客 ID を API が受け取る形（数字のみ）にする。`123-456-7890` も通す。 */
export function digits(value) {
  return String(value ?? "").replace(/\D/g, "");
}

function flag(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").trim().toLowerCase());
}

export function loadConfig(env = process.env) {
  return {
    developerToken: (env.GOOGLE_ADS_DEVELOPER_TOKEN || "").trim(),
    clientId: (env.GOOGLE_ADS_CLIENT_ID || "").trim(),
    clientSecret: (env.GOOGLE_ADS_CLIENT_SECRET || "").trim(),
    refreshToken: (env.GOOGLE_ADS_REFRESH_TOKEN || "").trim(),
    customerId: digits(env.GOOGLE_ADS_CUSTOMER_ID),
    loginCustomerId: digits(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID),
    // 概ね 1 年強でサンセットするので、リリースノートを見て上げる
    // https://developers.google.com/google-ads/api/docs/release-notes
    apiVersion: (env.GOOGLE_ADS_API_VERSION || "v25").trim(),
    readOnly: flag(env.GOOGLE_ADS_READ_ONLY),
  };
}
