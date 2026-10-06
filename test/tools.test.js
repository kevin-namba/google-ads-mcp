import assert from "node:assert/strict";
import { test } from "node:test";

import { createClient } from "../src/client.js";
import { loadConfig } from "../src/config.js";
import { callTool, visibleTools } from "../src/server.js";
import { textWidth } from "../src/text.js";
import { TOOLS } from "../src/tools.js";

const ENV = {
  GOOGLE_ADS_DEVELOPER_TOKEN: "dev",
  GOOGLE_ADS_CLIENT_ID: "id",
  GOOGLE_ADS_CLIENT_SECRET: "secret",
  GOOGLE_ADS_REFRESH_TOKEN: "refresh",
  GOOGLE_ADS_CUSTOMER_ID: "123-456-7890",
  GOOGLE_ADS_LOGIN_CUSTOMER_ID: "111-222-3333",
};

/** Google への呼び出しを記録し、`respond(url, body)` の戻り値を JSON で返す fetch。 */
function harness(respond = () => ({}), env = ENV) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url).includes("oauth2.googleapis.com")) {
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    }
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), headers: init.headers, body });
    const result = respond(String(url), body);
    return result instanceof Response ? result : new Response(JSON.stringify(result));
  };
  const config = loadConfig(env);
  const ads = createClient(config, fetchImpl);
  const run = async (name, args) => {
    const res = await callTool(visibleTools(config), ads, name, args);
    return { ...JSON.parse(res.content[0].text), isError: res.isError };
  };
  return { calls, run };
}

test("全角は 2、半角と半角カナは 1 と数える", () => {
  assert.equal(textWidth("abc"), 3);
  assert.equal(textWidth("東京のホテル"), 12);
  assert.equal(textWidth("ﾎﾃﾙ"), 3);
  assert.equal(textWidth("Ａ１"), 4);
});

test("report: 全チャンクを連結し、ヘッダと URL を正しく組む", async () => {
  const { calls, run } = harness(() => [{ results: [{ a: 1 }] }, { results: [{ a: 2 }, { a: 3 }] }]);
  const out = await run("google_ads_report", { start_date: "2026-09-01", end_date: "2026-09-30", by_date: true });
  assert.equal(out.status, "ok");
  assert.equal(out.row_count, 3);
  assert.equal(calls[0].url, "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:searchStream");
  assert.equal(calls[0].headers["developer-token"], "dev");
  assert.equal(calls[0].headers["login-customer-id"], "1112223333");
  assert.match(calls[0].body.query, /^SELECT segments\.date, campaign\.id.* FROM campaign WHERE segments\.date BETWEEN '2026-09-01' AND '2026-09-30'$/);
});

test("report: 日付の形をしていない値は送らない", async () => {
  const { calls, run } = harness();
  const out = await run("google_ads_report", { start_date: "2026-09-01' OR 1=1 --", end_date: "2026-09-30" });
  assert.equal(out.isError, true);
  assert.equal(calls.length, 0);
});

test("customer_id 引数は環境変数の既定より優先される", async () => {
  const { calls, run } = harness(() => [{ results: [] }]);
  await run("google_ads_list_objects", { customer_id: "999-888-7777" });
  assert.match(calls[0].url, /customers\/9998887777\//);
});

test("keywords: 顧客に直接生えるメソッドはスラッシュを挟まない", async () => {
  const { calls, run } = harness(() => ({ results: [{ text: "ホテル", keywordIdeaMetrics: {} }] }));
  const out = await run("google_ads_keywords", { keywords: ["ホテル"], language_id: "1005", geo_target_ids: ["2392"] });
  assert.match(calls[0].url, /customers\/1234567890:generateKeywordIdeas$/);
  assert.equal(calls[0].body.language, "languageConstants/1005");
  assert.equal(out.rows[0].avg_monthly_searches, null);
});

test("create_budget: 金額はマイクロの文字列で送る", async () => {
  const { calls, run } = harness(() => ({ results: [{ resourceName: "customers/1234567890/campaignBudgets/1" }] }));
  const out = await run("google_ads_create_budget", { name: "b", daily_amount: 3000 });
  assert.equal(out.budget_resource_name, "customers/1234567890/campaignBudgets/1");
  assert.match(calls[0].url, /\/campaignBudgets:mutate$/);
  assert.equal(calls[0].body.operations[0].create.amountMicros, "3000000000");
  assert.equal(calls[0].body.operations[0].create.explicitlyShared, false);
});

test("create_campaign: 検索は PAUSED で、検索パートナーとディスプレイを切る", async () => {
  const { calls, run } = harness(() => ({ results: [{ resourceName: "c" }] }));
  await run("google_ads_create_campaign", { name: "c", budget_resource_name: "b" });
  const campaign = calls[0].body.operations[0].create;
  assert.equal(campaign.status, "PAUSED");
  assert.equal(campaign.networkSettings.targetSearchNetwork, false);
  assert.equal(campaign.networkSettings.targetContentNetwork, false);
  assert.deepEqual(campaign.manualCpc, { enhancedCpcEnabled: false });
});

test("create_campaign: P-MAX に手動入札は通さず、networkSettings も送らない", async () => {
  const { calls, run } = harness(() => ({ results: [{ resourceName: "c" }] }));
  const bad = await run("google_ads_create_campaign", {
    name: "c", budget_resource_name: "b", channel: "performance_max", bidding_strategy: "manual_cpc",
  });
  assert.equal(bad.isError, true);
  assert.equal(calls.length, 0);

  await run("google_ads_create_campaign", {
    name: "c", budget_resource_name: "b", channel: "performance_max",
    bidding_strategy: "maximize_conversion_value", target_roas: 2.5,
  });
  const campaign = calls[0].body.operations[0].create;
  assert.equal(campaign.networkSettings, undefined);
  assert.deepEqual(campaign.maximizeConversionValue, { targetRoas: 2.5 });
});

test("update_status: ACTIVE と REMOVED は送らずに案内を返す", async () => {
  const { calls, run } = harness();
  const active = await run("google_ads_update_status", { object_id: "1", status: "ACTIVE" });
  assert.match(active.error, /ENABLED/);
  const removed = await run("google_ads_update_status", { object_id: "1", status: "REMOVED" });
  assert.match(removed.error, /google_ads_remove/);
  assert.equal(calls.length, 0);
});

test("update_status / remove: 広告は複合キーを要求し、updateMask は変える項目だけ", async () => {
  const { calls, run } = harness(() => ({ results: [{}] }));
  const bad = await run("google_ads_update_status", { kind: "ad", object_id: "67890", status: "PAUSED" });
  assert.equal(bad.isError, true);

  await run("google_ads_update_status", { kind: "ad", object_id: "12345~67890", status: "PAUSED" });
  assert.match(calls[0].url, /\/adGroupAds:mutate$/);
  assert.deepEqual(calls[0].body.operations[0], {
    update: { resourceName: "customers/1234567890/adGroupAds/12345~67890", status: "PAUSED" },
    updateMask: "status",
  });

  await run("google_ads_remove", { object_id: "customers/1234567890/campaigns/5" });
  assert.deepEqual(calls[1].body.operations[0], { remove: "customers/1234567890/campaigns/5" });
});

test("responsive_search_ad: 全角で上限を超える見出しは送る前に断る", async () => {
  const { calls, run } = harness();
  const out = await run("google_ads_create_responsive_search_ad", {
    ad_group_resource_name: "g",
    headlines: ["東京駅から徒歩五分の好立地にあるホテル", "見出し2", "見出し3"],
    descriptions: ["説明1", "説明2"],
    final_urls: ["https://example.com"],
  });
  assert.match(out.error, /headlines は 1 本 30 文字まで/);
  assert.equal(calls.length, 0);
});

test("add_keywords: 除外キーワードには status を付けない", async () => {
  const { calls, run } = harness(() => ({ results: [{ resourceName: "k" }] }));
  await run("google_ads_add_keywords", { ad_group_resource_name: "g", keywords: ["無料"], negative: true });
  assert.deepEqual(calls[0].body.operations[0].create, {
    adGroup: "g", keyword: { text: "無料", matchType: "PHRASE" }, negative: true,
  });
});

test("API のエラー本文は要約せずに返す", async () => {
  const { run } = harness(() => new Response('{"error":{"message":"USER_PERMISSION_DENIED"}}', { status: 403 }));
  const out = await run("google_ads_account_info", {});
  assert.equal(out.status, "unavailable");
  assert.match(out.reason, /HTTP 403.*USER_PERMISSION_DENIED/);
});

test("設定が足りないときは、足りない変数を名指しする", async () => {
  const { run } = harness(undefined, { GOOGLE_ADS_DEVELOPER_TOKEN: "dev", GOOGLE_ADS_CUSTOMER_ID: "1" });
  const out = await run("google_ads_account_info", {});
  assert.match(out.reason, /GOOGLE_ADS_CLIENT_ID \/ GOOGLE_ADS_CLIENT_SECRET \/ GOOGLE_ADS_REFRESH_TOKEN/);
});

test("読み取り専用モードでは書き込みツールを公開しない", async () => {
  const visible = visibleTools(loadConfig({ GOOGLE_ADS_READ_ONLY: "true" }));
  assert.ok(visible.length > 0 && visible.every((t) => !t.writes));
  assert.ok(TOOLS.some((t) => t.writes));
  const { run } = harness(undefined, { ...ENV, GOOGLE_ADS_READ_ONLY: "true" });
  assert.match((await run("google_ads_mutate", { mutate_operations: [{}] })).error, /不明なツール/);
});
