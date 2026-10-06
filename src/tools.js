// Google 広告のツール——ハンドラとスキーマを同じ場所に置く。
// 引数の名前も単位も必須項目もスキーマが決めるので、離れていると
// 「片方だけ直した」が起きる。
//
// 単位（公式 proto で確認済みのもの）:
//   * cost_micros / amount_micros は**通貨に依らず一律マイクロ**（100 万 = 通貨 1 単位）
//   * metrics.ctr は**比率（0〜1）**。% ではない
//   * metrics.conversions は double（小数になりうる）
//   * int64 のフィールドは proto3 JSON の規則で**文字列**として返る

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import { ToolError, Unavailable } from "./client.js";
import { textWidth } from "./text.js";

const MICROS = 1_000_000;
const MAX_ROWS = 1000;
// Google の画像アセットの上限（5120 KB）
const MAX_IMAGE_BYTES = 5120 * 1024;

function required(args, key) {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    throw new ToolError(`${key} は必須です`);
  }
  return value;
}

function micros(amount) {
  return String(Math.round(Number(amount) * MICROS));
}

function positiveAmount(args, key) {
  const amount = Number(required(args, key));
  if (!(amount > 0)) {
    throw new ToolError(`${key} は 0 より大きい金額です（通貨 1 単位。円なら円）`);
  }
  return amount;
}

function stringList(args, key, what) {
  const values = args[key] ?? [];
  if (!Array.isArray(values)) throw new ToolError(`${key} は配列です`);
  const cleaned = values.map((v) => String(v).trim()).filter(Boolean);
  if (what && !cleaned.length) throw new ToolError(`${key} は 1 つ以上の配列です（${what}）`);
  return cleaned;
}

// GAQL には値の埋め込み構文が無い。**呼び出し側の文字列をそのまま連結しない**
// ——形を検算してからでないと条件を書き換えられる。
function gaqlDate(value, label) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    throw new ToolError(`${label} は YYYY-MM-DD 形式で指定してください: ${JSON.stringify(value)}`);
  }
  return text;
}

function rowLimit(args, fallback) {
  const limit = Math.trunc(Number(args.row_limit ?? fallback));
  return Math.min(Math.max(limit || fallback, 1), MAX_ROWS);
}

// --------------------------------------------------------------------------
// 読み取り
// --------------------------------------------------------------------------

async function listAccessibleCustomers(_args, ads) {
  const ids = await ads.listAccessibleCustomers();
  return {
    customer_ids: ids,
    note:
      "連携した Google アカウントが直接アクセスできるアカウントの ID。名前は含まれない" +
      "（google_ads_account_info で確認する）。MCC 配下の子アカウントはここに出ないことがある。",
  };
}

async function accountInfo(args, ads) {
  const cid = ads.customerId(args);
  const rows = await ads.search(
    cid,
    "SELECT customer.id, customer.descriptive_name, customer.currency_code, " +
      "customer.time_zone, customer.manager, customer.test_account FROM customer LIMIT 1",
    "アカウント情報の取得",
  );
  if (!rows.length) throw new Unavailable("この顧客 ID の情報を取得できませんでした");
  const customer = rows[0].customer ?? {};
  const manager = Boolean(customer.manager);
  return {
    customer_id: cid,
    name: customer.descriptiveName ?? null,
    currency: customer.currencyCode ?? null,
    time_zone: customer.timeZone ?? null,
    manager,
    test_account: Boolean(customer.testAccount),
    api_version: ads.config.apiVersion,
    // MCC には広告が無い。選び間違えると「連携は通るのに実績が常に 0 行」になる
    ...(manager && {
      note: "これは管理者（MCC）アカウントです。広告が入っていないので実績は常に空になります。配信している子アカウントの ID を指定してください。",
    }),
  };
}

async function report(args, ads) {
  const level = String(args.level || "campaign");
  if (!["customer", "campaign", "ad_group"].includes(level)) {
    throw new ToolError("level は customer / campaign / ad_group のいずれかです");
  }
  const start = gaqlDate(required(args, "start_date"), "start_date");
  const end = gaqlDate(required(args, "end_date"), "end_date");
  const cid = ads.customerId(args);

  let fields = [
    "metrics.cost_micros",
    "metrics.impressions",
    "metrics.clicks",
    "metrics.conversions",
    "metrics.conversions_value",
  ];
  if (level === "campaign") {
    fields = ["campaign.id", "campaign.name", "campaign.status", ...fields];
  } else if (level === "ad_group") {
    fields = ["ad_group.id", "ad_group.name", "ad_group.status", "campaign.id", "campaign.name", ...fields];
  }
  if (args.by_date) fields.unshift("segments.date");

  const query =
    `SELECT ${fields.join(", ")} FROM ${level} ` + `WHERE segments.date BETWEEN '${start}' AND '${end}'`;
  const rows = await ads.search(cid, query, "実績の取得");
  return {
    customer_id: cid,
    level,
    period: { start, end },
    query,
    row_count: rows.length,
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
    note:
      "costMicros は 100 万で割ると通貨 1 単位（通貨に依らず一律）。conversions は小数になりうる。" +
      "int64 の項目は文字列で返る。CTR / CPC はこの応答から自分で計算すること。" +
      "CV が 0 件のとき CPA は「算出不可」であり 0 ではない。",
  };
}

const LIST_FIELDS = {
  campaign: [
    "campaign",
    [
      "campaign.id",
      "campaign.name",
      "campaign.status",
      "campaign.advertising_channel_type",
      "campaign.bidding_strategy_type",
      "campaign.campaign_budget",
      "campaign_budget.id",
      "campaign_budget.amount_micros",
    ],
  ],
  ad_group: [
    "ad_group",
    ["ad_group.id", "ad_group.name", "ad_group.status", "ad_group.cpc_bid_micros", "campaign.id", "campaign.name"],
  ],
  ad: [
    "ad_group_ad",
    [
      "ad_group_ad.ad.id",
      "ad_group_ad.ad.name",
      "ad_group_ad.ad.type",
      "ad_group_ad.ad.final_urls",
      "ad_group_ad.status",
      "ad_group.id",
      "ad_group.name",
      "campaign.id",
      "campaign.name",
    ],
  ],
};

async function listObjects(args, ads) {
  const kind = String(args.kind || "campaign");
  if (!LIST_FIELDS[kind]) throw new ToolError("kind は campaign / ad_group / ad のいずれかです");
  const cid = ads.customerId(args);
  const [resource, fields] = LIST_FIELDS[kind];
  // REMOVED は既定で除く（消したものが一覧に残ると、消し忘れに見える）
  const query =
    `SELECT ${fields.join(", ")} FROM ${resource} ` +
    `WHERE ${resource}.status != 'REMOVED' LIMIT ${rowLimit(args, 200)}`;
  const rows = await ads.search(cid, query, "一覧の取得");
  return {
    customer_id: cid,
    kind,
    row_count: rows.length,
    rows,
    note: "amountMicros は 100 万で割ると通貨 1 単位。日予算はキャンペーンにしかない（広告グループには存在しない）。",
  };
}

async function search(args, ads) {
  const query = String(required(args, "query")).trim();
  const cid = ads.customerId(args);
  const rows = await ads.search(cid, query, "GAQL の実行");
  const limit = rowLimit(args, MAX_ROWS);
  return {
    customer_id: cid,
    query,
    row_count: rows.length,
    rows: rows.slice(0, limit),
    truncated: rows.length > limit,
  };
}

async function keywords(args, ads) {
  const seeds = stringList(args, "keywords", "調べるキーワード");
  const cid = ads.customerId(args);

  const body = { keywordSeed: { keywords: seeds } };
  if (args.language_id) body.language = `languageConstants/${args.language_id}`;
  if (args.geo_target_ids?.length) {
    body.geoTargetConstants = args.geo_target_ids.map((g) => `geoTargetConstants/${g}`);
  }
  const data = await ads.post(cid, ":generateKeywordIdeas", body, "Keyword Planner の取得");

  const rows = (data?.results ?? []).map((entry) => {
    const metrics = entry.keywordIdeaMetrics ?? {};
    return {
      keyword: entry.text,
      avg_monthly_searches: metrics.avgMonthlySearches ?? null,
      competition: metrics.competition ?? null,
      competition_index: metrics.competitionIndex ?? null,
      // 単位はマイクロ。**ここで割らない**——通貨がアカウントごとに違うので、割ると単位が消える
      low_top_of_page_bid_micros: metrics.lowTopOfPageBidMicros ?? null,
      high_top_of_page_bid_micros: metrics.highTopOfPageBidMicros ?? null,
    };
  });
  return {
    customer_id: cid,
    row_count: rows.length,
    rows: rows.slice(0, MAX_ROWS),
    truncated: rows.length > MAX_ROWS,
    bid_unit: "micros",
    note:
      "入札額はマイクロ単位（1,000,000 = 通貨 1 単位）。通貨は顧客 ID の設定に従う。" +
      "avg_monthly_searches の null は 0 ではなく「データ無し」。" +
      "competition は広告枠の埋まり具合であって、SEO の難易度ではない。",
  };
}

// --------------------------------------------------------------------------
// 書き込み（入稿・配信操作）
//
// 作る順番は上から下へ固定される（下は上の resourceName を要る）:
//     予算 → キャンペーン → 広告グループ → キーワード / 広告
//                        └ P-MAX はアセットグループ
// --------------------------------------------------------------------------

// 新規作成の既定。**ENABLED を既定にしない**——作った瞬間に配信が始まると、
// 承認したのは「作成」なのに出稿まで通ってしまう。
const DEFAULT_STATUS = "PAUSED";
const WRITABLE_STATUSES = ["ENABLED", "PAUSED"];

function deliveryStatus(value) {
  const status = String(value || DEFAULT_STATUS).toUpperCase();
  const allowed = WRITABLE_STATUSES.join(" / ");
  if (status === "ACTIVE") {
    // Meta の語彙で来たときに「不正な値」で突き放さない。取り違えは必ず起きる
    throw new ToolError(`Google 広告に ACTIVE はありません。配信中は ENABLED です（指定できるのは ${allowed}）`);
  }
  if (status === "REMOVED") {
    // 削除は update ではなく remove オペレーションが公式の経路
    throw new ToolError(
      `Google 広告の削除は status では行いません。google_ads_remove を使ってください（指定できるのは ${allowed}）`,
    );
  }
  if (!WRITABLE_STATUSES.includes(status)) throw new ToolError(`status は ${allowed} のいずれかです`);
  return status;
}

// 状態変更・削除で触れるリソース（= mutate のエンドポイント名）。
// **ここに無いものは変えられない**——何の状態を変えるのかを文字列から
// 推測させると、広告を止めるつもりでキャンペーンごと止まる事故が起きる。
const STATUS_TARGETS = { campaign: "campaigns", ad_group: "adGroups", ad: "adGroupAds" };

// リソース名が複合キー（`{広告グループID}~{広告ID}`）になるもの。
const COMPOUND_IDS = new Set(["adGroupAds", "adGroupCriteria"]);

function target(args) {
  const kind = String(args.kind || "campaign");
  const endpoint = STATUS_TARGETS[kind];
  if (!endpoint) throw new ToolError(`kind は ${Object.keys(STATUS_TARGETS).join(" / ")} のいずれかです`);
  return { kind, endpoint };
}

/** `customers/{cid}/{kind}/{id}` を組み立てる。一覧の resourceName はそのまま通す。 */
function resourceName(cid, kind, id) {
  const text = String(id ?? "").trim();
  if (!text) throw new ToolError(`${kind} の ID が空です`);
  if (text.startsWith("customers/")) return text;
  if (COMPOUND_IDS.has(kind) && !text.includes("~")) {
    throw new ToolError(
      `${kind} の ID は「広告グループID~個別ID」の形です（例: 12345~67890）。一覧の resourceName をそのまま渡すこともできます`,
    );
  }
  return `customers/${cid}/${kind}/${text}`;
}

/** 更新オペレーション 1 件。updateMask は**変える項目だけ**から作る。 */
function updateOperation(name, changes) {
  return { update: { resourceName: name, ...changes }, updateMask: Object.keys(changes).join(",") };
}

async function createBudget(args, ads) {
  const amount = positiveAmount(args, "daily_amount");
  const name = required(args, "name");
  const cid = ads.customerId(args);
  const created = await ads.mutate(
    cid,
    "campaignBudgets",
    [
      {
        create: {
          name,
          amountMicros: micros(amount),
          deliveryMethod: "STANDARD",
          // 共有予算にすると、別のキャンペーンの消化に引きずられる
          explicitlyShared: false,
        },
      },
    ],
    "キャンペーン予算の作成",
  );
  return {
    budget_resource_name: created[0] ?? null,
    daily_amount: amount,
    note: "この予算をキャンペーンに割り当てるまで、まだ何も配信されません。",
  };
}

// 作れるキャンペーンの種類と、チャネルごとに使える入札戦略（先頭が既定）。
// **P-MAX は手動入札を受け付けない。**
const CHANNELS = { search: "SEARCH", performance_max: "PERFORMANCE_MAX" };
const STRATEGIES = {
  search: ["manual_cpc", "maximize_conversions"],
  performance_max: ["maximize_conversions", "maximize_conversion_value"],
};

function bidding(strategy, args) {
  if (strategy === "manual_cpc") return { manualCpc: { enhancedCpcEnabled: false } };
  if (strategy === "maximize_conversions") {
    return { maximizeConversions: args.target_cpa ? { targetCpaMicros: micros(args.target_cpa) } : {} };
  }
  // ROAS は倍率（2.5 = 250%）。**マイクロにしない**
  return { maximizeConversionValue: args.target_roas ? { targetRoas: Number(args.target_roas) } : {} };
}

async function createCampaign(args, ads) {
  const channel = String(args.channel || "search");
  if (!CHANNELS[channel]) throw new ToolError(`channel は ${Object.keys(CHANNELS).join(" / ")} のいずれかです`);
  const status = deliveryStatus(args.status);
  const allowed = STRATEGIES[channel];
  const strategy = String(args.bidding_strategy || allowed[0]);
  if (!allowed.includes(strategy)) {
    throw new ToolError(`${channel} で使える入札戦略は ${allowed.join(" / ")} です（指定: ${strategy}）`);
  }

  const campaign = {
    name: required(args, "name"),
    status,
    advertisingChannelType: CHANNELS[channel],
    campaignBudget: required(args, "budget_resource_name"),
    // EU 政治広告の申告（API の必須項目）。法的な申告なので、含む場合だけ明示させる
    containsEuPoliticalAdvertising: args.contains_eu_political_advertising
      ? "CONTAINS_EU_POLITICAL_ADVERTISING"
      : "DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING",
    ...bidding(strategy, args),
  };
  if (channel === "performance_max") {
    // 新規 P-MAX は Brand Guidelines が既定で有効になり、ビジネス名とロゴを
    // キャンペーン作成と同時に要求される。このサーバーの順路は
    // 「キャンペーン → アセットグループ」で、どちらもアセットグループ側に
    // 必ず入るので、ここでは無効にする
    campaign.brandGuidelinesEnabled = false;
  } else {
    // **明示しないと既定で検索パートナーとディスプレイにも出る。**
    // 気づくのが請求書の時点になるので、ここで閉じておく
    campaign.networkSettings = {
      targetGoogleSearch: true,
      targetSearchNetwork: Boolean(args.target_search_network),
      targetContentNetwork: Boolean(args.target_content_network),
      targetPartnerSearchNetwork: false,
    };
  }

  const cid = ads.customerId(args);
  const created = await ads.mutate(cid, "campaigns", [{ create: campaign }], "キャンペーンの作成");
  return {
    campaign_resource_name: created[0] ?? null,
    channel,
    delivery_status: status,
    note:
      (status === "PAUSED" ? "作成しただけで配信は始まっていません（開始は google_ads_update_status）。" : "") +
      (channel === "performance_max"
        ? "P-MAX はアセットグループが無いと配信できません。続けて google_ads_create_asset_group を実行してください。"
        : "このままでは広告グループも広告も無いので、続けて作ってください。"),
  };
}

async function createAdGroup(args, ads) {
  const status = deliveryStatus(args.status);
  const adGroup = {
    name: required(args, "name"),
    campaign: required(args, "campaign_resource_name"),
    status,
    type: "SEARCH_STANDARD",
  };
  if (args.cpc_bid) adGroup.cpcBidMicros = micros(args.cpc_bid);

  const cid = ads.customerId(args);
  const created = await ads.mutate(cid, "adGroups", [{ create: adGroup }], "広告グループの作成");
  return {
    ad_group_resource_name: created[0] ?? null,
    delivery_status: status,
    note: "キーワードと広告を追加するまで配信されません。",
  };
}

const MATCH_TYPES = ["EXACT", "PHRASE", "BROAD"];

async function addKeywords(args, ads) {
  const adGroup = required(args, "ad_group_resource_name");
  const texts = stringList(args, "keywords", "追加するキーワード");
  const matchType = String(args.match_type || "PHRASE").toUpperCase();
  if (!MATCH_TYPES.includes(matchType)) {
    throw new ToolError(`match_type は ${MATCH_TYPES.join(" / ")} のいずれかです`);
  }
  const negative = Boolean(args.negative);

  const operations = texts.map((text) => ({
    create: {
      adGroup,
      keyword: { text, matchType },
      negative,
      // 除外キーワードに status は付けられない（Google が弾く）
      ...(!negative && { status: "ENABLED" }),
    },
  }));
  const cid = ads.customerId(args);
  const created = await ads.mutate(cid, "adGroupCriteria", operations, "キーワードの追加");
  return {
    ad_group_resource_name: adGroup,
    match_type: matchType,
    negative,
    created_count: created.length,
    resource_names: created,
  };
}

/** 本数と文字数を検算したテキスト。足りない・多い・長いは全部ここで断る。 */
function limitedTexts(args, key, [minimum, maximum, length]) {
  const texts = stringList(args, key);
  if (texts.length < minimum) throw new ToolError(`${key} は ${minimum} 本以上必要です（いまは ${texts.length} 本）`);
  if (texts.length > maximum) throw new ToolError(`${key} は ${maximum} 本までです（いまは ${texts.length} 本）`);
  const over = texts.filter((t) => textWidth(t) > length);
  if (over.length) {
    throw new ToolError(
      `${key} は 1 本 ${length} 文字までです（全角は 2 文字と数えます）。超えているもの: ` +
        over.map((t) => `「${t}」(${textWidth(t)}文字)`).join(" / "),
    );
  }
  return texts;
}

// レスポンシブ検索広告の上限。[最小, 最大, 文字数]
const RSA_LIMITS = { headlines: [3, 15, 30], descriptions: [2, 4, 90] };

async function createResponsiveSearchAd(args, ads) {
  const status = deliveryStatus(args.status);
  const finalUrls = stringList(args, "final_urls", "遷移先の URL");
  const rsa = {
    headlines: limitedTexts(args, "headlines", RSA_LIMITS.headlines).map((text) => ({ text })),
    descriptions: limitedTexts(args, "descriptions", RSA_LIMITS.descriptions).map((text) => ({ text })),
  };
  // path1 が無いのに path2 だけ、は Google が弾く
  if (args.path1) {
    rsa.path1 = String(args.path1);
    if (args.path2) rsa.path2 = String(args.path2);
  }

  const adGroup = required(args, "ad_group_resource_name");
  const cid = ads.customerId(args);
  const created = await ads.mutate(
    cid,
    "adGroupAds",
    [{ create: { adGroup, status, ad: { finalUrls, responsiveSearchAd: rsa } } }],
    "レスポンシブ検索広告の作成",
  );
  return {
    ad_resource_name: created[0] ?? null,
    delivery_status: status,
    note: "配信は広告グループとキャンペーンの状態にも従います。",
  };
}

// --------------------------------------------------------------------------
// P-MAX（アセットグループ）
//
// **アセットグループと必須アセットは 1 回の mutate で作る**（Google の要求）。
// だから googleAds:mutate と一時リソース ID（負の数）を使う:
//   * 定義したあとでしか参照できない（参照される側を先に置く）
//   * 1 リクエスト内でリソース種別をまたいで一意な負の数にする
// --------------------------------------------------------------------------

// [fieldType, 最小, 最大, 文字数上限]
const PMAX_TEXT = {
  headlines: ["HEADLINE", 3, 15, 30],
  long_headlines: ["LONG_HEADLINE", 1, 5, 90],
  descriptions: ["DESCRIPTION", 2, 5, 90],
};
const BUSINESS_NAME_LENGTH = 25;

// [fieldType, 最小, 最大, 比率]。**比率はこちらで検算しない**——
// Google が弾いたらその本文をそのまま返す。
const PMAX_IMAGES = {
  marketing_images: ["MARKETING_IMAGE", 1, 20, "1.91:1（推奨 1200x628）"],
  square_marketing_images: ["SQUARE_MARKETING_IMAGE", 1, 20, "1:1（推奨 1200x1200）"],
  logos: ["LOGO", 1, 5, "1:1"],
  portrait_marketing_images: ["PORTRAIT_MARKETING_IMAGE", 0, 20, "4:5（推奨 960x1200）"],
  landscape_logos: ["LANDSCAPE_LOGO", 0, 20, "4:1（推奨 1200x300）"],
};

/** ローカルのパスか http(s) の URL から画像を読む。 */
async function loadImage(source) {
  let data;
  let filename;
  if (/^https?:\/\//i.test(source)) {
    let res;
    try {
      res = await fetch(source, { signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      throw new ToolError(`画像を取得できません: ${source}（${err?.message ?? err}）`);
    }
    if (!res.ok) throw new ToolError(`画像を取得できません: ${source}（HTTP ${res.status}）`);
    data = Buffer.from(await res.arrayBuffer());
    filename = basename(new URL(source).pathname) || "image";
  } else {
    const path = resolve(source.replace(/^~(?=\/|$)/, homedir()));
    try {
      data = await readFile(path);
    } catch (err) {
      throw new ToolError(`画像を読めません: ${path}（${err?.code ?? err?.message ?? err}）`);
    }
    filename = basename(path);
  }
  if (data.length > MAX_IMAGE_BYTES) {
    throw new ToolError(`画像が大きすぎます: ${source}（${Math.ceil(data.length / 1024)} KB。上限 5120 KB）`);
  }
  // アセット名はアカウント内で一意である必要がある。内容のハッシュを混ぜて
  // 「同じファイル名の別画像」で衝突しないようにする
  const digest = createHash("sha1").update(data).digest("hex").slice(0, 8);
  return { name: `${filename} (${digest})`.slice(0, 128), base64: data.toString("base64") };
}

async function createAssetGroup(args, ads) {
  const status = deliveryStatus(args.status);
  const campaign = required(args, "campaign_resource_name");
  const name = required(args, "name");
  const finalUrls = stringList(args, "final_urls", "遷移先の URL");

  // --- 送る前に全部数える（Google は 1 つ足りないだけで全体を拒否する）---
  const texts = []; // [fieldType, text]
  for (const [key, [fieldType, ...limits]] of Object.entries(PMAX_TEXT)) {
    for (const text of limitedTexts(args, key, limits)) texts.push([fieldType, text]);
  }
  const businessName = String(args.business_name ?? "").trim();
  if (!businessName) throw new ToolError("business_name（BUSINESS_NAME）は必須です");
  if (textWidth(businessName) > BUSINESS_NAME_LENGTH) {
    throw new ToolError(
      `business_name は ${BUSINESS_NAME_LENGTH} 文字までです（全角は 2 文字と数えます。いまは ${textWidth(businessName)} 文字）`,
    );
  }
  texts.push(["BUSINESS_NAME", businessName]);

  const images = []; // [fieldType, source]
  for (const [key, [fieldType, minimum, maximum, ratio]] of Object.entries(PMAX_IMAGES)) {
    const sources = stringList(args, key);
    if (sources.length < minimum) {
      throw new ToolError(
        `${key}（${fieldType}）は ${minimum} 枚以上必要です（いまは ${sources.length} 枚。比率 ${ratio}）`,
      );
    }
    if (sources.length > maximum) {
      throw new ToolError(`${key}（${fieldType}）は ${maximum} 枚までです（いまは ${sources.length} 枚）`);
    }
    for (const source of sources) images.push([fieldType, source]);
  }

  const cid = ads.customerId(args);
  const temp = (kind, index) => `customers/${cid}/${kind}/${index}`;
  const operations = [];
  const links = []; // [fieldType, 一時リソース名]
  let nextId = -1;

  for (const [fieldType, text] of texts) {
    const asset = temp("assets", nextId--);
    operations.push({ assetOperation: { create: { resourceName: asset, textAsset: { text } } } });
    links.push([fieldType, asset]);
  }
  for (const [fieldType, source] of images) {
    const image = await loadImage(source);
    const asset = temp("assets", nextId--);
    operations.push({
      assetOperation: {
        // ImageAsset.data は bytes。proto3 JSON では base64 文字列
        create: { resourceName: asset, name: image.name, imageAsset: { data: image.base64 } },
      },
    });
    links.push([fieldType, asset]);
  }
  // アセットグループは最後（参照される側が先に定義されている必要がある）
  const group = temp("assetGroups", nextId);
  operations.push({
    assetGroupOperation: { create: { resourceName: group, campaign, name, finalUrls, status } },
  });
  for (const [fieldType, asset] of links) {
    operations.push({ assetGroupAssetOperation: { create: { assetGroup: group, asset, fieldType } } });
  }

  const body = { mutateOperations: operations };
  if (args.validate_only) body.validateOnly = true;
  const data = await ads.post(cid, "googleAds:mutate", body, "アセットグループの作成");

  const created = (data?.mutateOperationResponses ?? [])
    .map((r) => r.assetGroupResult?.resourceName)
    .filter(Boolean);
  return {
    asset_group_resource_name: created[0] ?? null,
    campaign_resource_name: campaign,
    delivery_status: status,
    validate_only: Boolean(args.validate_only),
    text_asset_count: texts.length,
    image_asset_count: images.length,
    note: "配信はキャンペーンの状態にも従います。アセットの審査には時間がかかるので、直後は配信されないことがあります。",
  };
}

async function updateStatus(args, ads) {
  const { kind, endpoint } = target(args);
  if (!args.status) throw new ToolError("status は必須です");
  const status = deliveryStatus(args.status);
  const cid = ads.customerId(args);
  const name = resourceName(cid, endpoint, required(args, "object_id"));
  await ads.mutate(cid, endpoint, [updateOperation(name, { status })], "配信状態の変更");
  return { kind, resource_name: name, delivery_status: status };
}

// 削除は **remove オペレーション**を送る。status に REMOVED を書く更新では行わない
// （公式が示している削除の形は {"remove": "<resourceName>"} の 1 つだけ）。
async function remove(args, ads) {
  const { kind, endpoint } = target(args);
  const cid = ads.customerId(args);
  const name = resourceName(cid, endpoint, required(args, "object_id"));
  await ads.mutate(cid, endpoint, [{ remove: name }], "削除");
  return { kind, resource_name: name, removed: true };
}

async function updateBudget(args, ads) {
  const amount = positiveAmount(args, "daily_amount");
  const cid = ads.customerId(args);
  const name = resourceName(cid, "campaignBudgets", required(args, "budget_id"));
  await ads.mutate(cid, "campaignBudgets", [updateOperation(name, { amountMicros: micros(amount) })], "日予算の変更");
  return { resource_name: name, daily_amount: amount };
}

async function mutate(args, ads) {
  const operations = args.mutate_operations;
  if (!Array.isArray(operations) || !operations.length) {
    throw new ToolError("mutate_operations は 1 つ以上の配列です");
  }
  const body = { mutateOperations: operations };
  if (args.validate_only) body.validateOnly = true;
  const cid = ads.customerId(args);
  const data = await ads.post(cid, "googleAds:mutate", body, "Google Ads API への書き込み");
  return { validate_only: Boolean(args.validate_only), result: data };
}

// --------------------------------------------------------------------------
// ツール定義
// --------------------------------------------------------------------------

const DATE = { type: "string", description: "YYYY-MM-DD" };
const STRINGS = (description) => ({ type: "array", items: { type: "string" }, description });
const STATUS = { type: "string", enum: WRITABLE_STATUSES, description: "ENABLED / PAUSED。既定 PAUSED" };
const KIND = { type: "string", enum: Object.keys(STATUS_TARGETS), description: "campaign（既定）/ ad_group / ad" };
const OBJECT_ID = { type: "string", description: "ID か resourceName。kind=ad は 12345~67890 の形" };
const CUSTOMER_ID = {
  type: "string",
  description: "対象の顧客 ID（ハイフン有無どちらでも可）。省略時は GOOGLE_ADS_CUSTOMER_ID",
};

function tool(name, title, description, properties, requiredKeys, handler, flags = {}) {
  return {
    name,
    title,
    description,
    inputSchema: {
      type: "object",
      properties: flags.noCustomer ? properties : { ...properties, customer_id: CUSTOMER_ID },
      required: requiredKeys,
    },
    writes: Boolean(flags.writes),
    destructive: Boolean(flags.destructive),
    handler,
  };
}

const W = { writes: true };

export const TOOLS = [
  tool(
    "google_ads_list_accessible_customers",
    "操作できる Google 広告アカウントの一覧",
    "連携した Google アカウントが直接アクセスできる顧客 ID を一覧する。**読み取り専用。**" +
      "名前は返らないので、google_ads_account_info で確かめる。",
    {},
    [],
    listAccessibleCustomers,
    { noCustomer: true },
  ),
  tool(
    "google_ads_account_info",
    "Google 広告アカウントの情報を取得",
    "顧客アカウントの名前・通貨・タイムゾーン・MCC かどうかを返す。**読み取り専用。**" +
      "疎通確認と、予算を触る前の通貨確認に使う。",
    {},
    [],
    accountInfo,
  ),
  tool(
    "google_ads_report",
    "Google 広告の実績を取得",
    "Google 広告の実績（費用・表示・クリック・CV・CV 値）を取得する。**読み取り専用。**" +
      "costMicros は 100 万で割ると通貨 1 単位（**通貨に依らず一律**）。conversions は小数になりうる。" +
      "int64 の項目は proto3 JSON の規則で**文字列**として返る。CTR / CPC は返り値から自分で計算すること。",
    {
      start_date: DATE,
      end_date: DATE,
      level: {
        type: "string",
        enum: ["customer", "campaign", "ad_group"],
        description: "customer（アカウント合計）/ campaign / ad_group。既定は campaign",
      },
      by_date: { type: "boolean", description: "true にすると segments.date で日次に割る" },
    },
    ["start_date", "end_date"],
    report,
  ),
  tool(
    "google_ads_list_objects",
    "Google 広告のキャンペーン一覧を取得",
    "キャンペーン / 広告グループ / 広告を一覧する。**読み取り専用。**" +
      "配信状態は ENABLED / PAUSED（**ACTIVE ではない**）。日予算はキャンペーンにしか無い。" +
      "REMOVED は除外する。",
    {
      kind: { type: "string", enum: Object.keys(LIST_FIELDS), description: "campaign（既定）/ ad_group / ad" },
      row_limit: { type: "integer", description: `既定 200、上限 ${MAX_ROWS}` },
    },
    [],
    listObjects,
  ),
  tool(
    "google_ads_search",
    "GAQL で Google 広告を検索",
    "任意の GAQL（Google Ads Query Language）を googleAds:searchStream で実行する。**読み取り専用。**" +
      "型付きツールで取れない項目（検索語句・キーワード別実績・アセット・地域別など）に使う。" +
      "フィールド名は snake_case（例: SELECT campaign.name, metrics.clicks FROM campaign WHERE segments.date DURING LAST_30_DAYS）。" +
      "返り値のキーは camelCase、int64 は文字列。",
    {
      query: { type: "string", description: "GAQL クエリ" },
      row_limit: { type: "integer", description: `返す行数の上限。既定・上限とも ${MAX_ROWS}` },
    },
    ["query"],
    search,
  ),
  tool(
    "google_ads_keywords",
    "キーワードの検索ボリュームと入札単価を調査",
    "Keyword Planner でキーワードの月間平均検索ボリューム・競合性・入札レンジを取る。**読み取り専用。**" +
      "**入札額はマイクロ単位**（1,000,000 = 通貨 1 単位）。関連キーワードの候補も返る。",
    {
      keywords: STRINGS("調べるキーワード（1 つ以上）"),
      language_id: { type: "string", description: "言語の ID。日本語は 1005、英語は 1000" },
      geo_target_ids: STRINGS("地域の ID。日本は 2392、米国は 2840"),
    },
    ["keywords"],
    keywords,
  ),
  // ---- ここから書き込み。GOOGLE_ADS_READ_ONLY=true のときは公開しない ----
  tool(
    "google_ads_create_budget",
    "Google 広告のキャンペーン予算を作成",
    "キャンペーン予算を作る。**Google 広告では予算がキャンペーンとは別のリソース**なので、" +
      "キャンペーンより先にこれを作る。金額は通貨 1 単位（円なら円）で渡す——マイクロ換算はサーバー側で行う。",
    {
      name: { type: "string", description: "予算の名前（アカウント内で一意）" },
      daily_amount: { type: "number", description: "1 日あたりの予算。通貨 1 単位（円なら円）" },
    },
    ["name", "daily_amount"],
    createBudget,
    W,
  ),
  tool(
    "google_ads_create_campaign",
    "Google 広告のキャンペーンを作成",
    "キャンペーンを作る（検索 / P-MAX）。**既定は PAUSED**（作成と配信開始は別の操作にする）。" +
      "budget_resource_name は google_ads_create_budget の戻り値。" +
      "検索では検索パートナー・ディスプレイへの配信を既定で切ってある。" +
      "**P-MAX に手動入札は無く、広告グループも広告も無い**" +
      "（代わりに google_ads_create_asset_group でアセットグループを作る。無いと配信できない）。",
    {
      name: { type: "string" },
      budget_resource_name: { type: "string", description: "customers/{cid}/campaignBudgets/{id}" },
      channel: { type: "string", enum: Object.keys(CHANNELS), description: "search（既定）/ performance_max" },
      bidding_strategy: {
        type: "string",
        description:
          "search: manual_cpc（既定）/ maximize_conversions。" +
          "performance_max: maximize_conversions（既定）/ maximize_conversion_value",
      },
      target_cpa: { type: "number", description: "maximize_conversions のときの目標 CPA（通貨 1 単位）" },
      target_roas: { type: "number", description: "maximize_conversion_value のときの目標 ROAS（倍率。2.5 = 250%）" },
      target_search_network: { type: "boolean", description: "検索パートナーにも出すか。既定 false（search のみ）" },
      target_content_network: { type: "boolean", description: "ディスプレイにも出すか。既定 false（search のみ）" },
      contains_eu_political_advertising: {
        type: "boolean",
        description: "EU の政治広告を含むか（法的申告）。既定 false = 含まない。含む案件だけ true を明示する",
      },
      status: STATUS,
    },
    ["name", "budget_resource_name"],
    createCampaign,
    W,
  ),
  tool(
    "google_ads_create_ad_group",
    "Google 広告の広告グループを作成",
    "検索キャンペーンに広告グループを作る。**日予算は持てない**——Google 広告の予算はキャンペーンにしかない。既定は PAUSED。",
    {
      name: { type: "string" },
      campaign_resource_name: { type: "string", description: "customers/{cid}/campaigns/{id}" },
      cpc_bid: { type: "number", description: "上限クリック単価。通貨 1 単位（円なら円）" },
      status: STATUS,
    },
    ["name", "campaign_resource_name"],
    createAdGroup,
    W,
  ),
  tool(
    "google_ads_add_keywords",
    "Google 広告にキーワードを追加",
    "広告グループにキーワードを追加する。negative=true で除外キーワードになる" +
      "（**あとから通常のキーワードには変えられない**ので、間違えたら消して作り直すことになる）。",
    {
      ad_group_resource_name: { type: "string", description: "customers/{cid}/adGroups/{id}" },
      keywords: STRINGS("追加するキーワード"),
      match_type: { type: "string", enum: MATCH_TYPES, description: "EXACT / PHRASE（既定）/ BROAD" },
      negative: { type: "boolean", description: "除外キーワードにするか" },
    },
    ["ad_group_resource_name", "keywords"],
    addKeywords,
    W,
  ),
  tool(
    "google_ads_create_responsive_search_ad",
    "Google 広告の検索広告を作成",
    "レスポンシブ検索広告を作る。見出しは 3〜15 本（各 30 文字以内）、説明文は 2〜4 本（各 90 文字以内）。" +
      "**字数は全角を 2 と数える**ので、日本語では上限が半分（見出し 15 / 説明文 45）。既定は PAUSED。",
    {
      ad_group_resource_name: { type: "string", description: "customers/{cid}/adGroups/{id}" },
      headlines: STRINGS("見出し 3〜15 本。各 30 文字以内（全角は 2 文字）"),
      descriptions: STRINGS("説明文 2〜4 本。各 90 文字以内（全角は 2 文字）"),
      final_urls: STRINGS("遷移先 URL"),
      path1: { type: "string", description: "表示 URL のパス 1" },
      path2: { type: "string", description: "パス 2（path1 とセットでのみ有効）" },
      status: STATUS,
    },
    ["ad_group_resource_name", "headlines", "descriptions", "final_urls"],
    createResponsiveSearchAd,
    W,
  ),
  tool(
    "google_ads_create_asset_group",
    "P-MAX のアセットグループを作成",
    "P-MAX のアセットグループを作る（P-MAX に広告グループも広告も無い）。" +
      "テキスト・画像・アセットグループ・リンクを**1 回の mutate で作る**（Google の要求）。" +
      "画像は**ローカルのファイルパスか http(s) の URL**で指定する（1 枚 5120 KB まで）。" +
      "必須: 見出し 3〜15（30字）/ 長い見出し 1〜5（90字）/ 説明 2〜5（90字）/ ビジネス名 1（25字）/ " +
      "横長画像 1〜20（1.91:1）/ 正方形画像 1〜20（1:1）/ ロゴ 1〜5（1:1）。" +
      "**字数は全角を 2 と数える**ので、日本語では上限が半分。" +
      "**1 つでも足りないと Google がリクエスト全体を拒否する**ので、" +
      "先に validate_only=true で検算するとよい。既定は PAUSED。",
    {
      campaign_resource_name: { type: "string", description: "customers/{cid}/campaigns/{id}（P-MAX のもの）" },
      name: { type: "string", description: "アセットグループの名前" },
      final_urls: STRINGS("遷移先 URL"),
      headlines: STRINGS("見出し 3〜15 本。各 30 文字以内"),
      long_headlines: STRINGS("長い見出し 1〜5 本。各 90 文字以内"),
      descriptions: STRINGS("説明文 2〜5 本。各 90 文字以内"),
      business_name: { type: "string", description: "ビジネス名。25 文字以内" },
      marketing_images: STRINGS("横長画像のパスか URL 1〜20 件（1.91:1。推奨 1200x628）"),
      square_marketing_images: STRINGS("正方形画像のパスか URL 1〜20 件（1:1。推奨 1200x1200）"),
      logos: STRINGS("ロゴのパスか URL 1〜5 件（1:1）"),
      portrait_marketing_images: STRINGS("任意。縦長画像のパスか URL（4:5。推奨 960x1200）"),
      landscape_logos: STRINGS("任意。横長ロゴのパスか URL（4:1。推奨 1200x300）"),
      validate_only: { type: "boolean", description: "true なら Google 側で検算だけ行い、何も作らない" },
      status: STATUS,
    },
    [
      "campaign_resource_name",
      "name",
      "final_urls",
      "headlines",
      "long_headlines",
      "descriptions",
      "business_name",
      "marketing_images",
      "square_marketing_images",
      "logos",
    ],
    createAssetGroup,
    W,
  ),
  tool(
    "google_ads_update_status",
    "Google 広告の配信状態を変更",
    "キャンペーン / 広告グループ / 広告の配信を開始（ENABLED）・停止（PAUSED）する。" +
      "**配信中は ENABLED**（ACTIVE ではない）。ENABLED にすると課金が始まりうる。" +
      "広告（kind=ad）の ID は「広告グループID~広告ID」の複合キー。削除は google_ads_remove。",
    { kind: KIND, object_id: OBJECT_ID, status: { ...STATUS, description: "ENABLED / PAUSED" } },
    ["object_id", "status"],
    updateStatus,
    W,
  ),
  tool(
    "google_ads_update_budget",
    "Google 広告の日予算を変更",
    "キャンペーン予算の日予算を変える。**宛先はキャンペーンではなく予算リソース**" +
      "（google_ads_list_objects が返す campaignBudget.id）。金額は通貨 1 単位（円なら円）。",
    {
      budget_id: { type: "string", description: "予算の ID か resourceName。キャンペーン ID ではない" },
      daily_amount: { type: "number", description: "1 日あたりの予算。通貨 1 単位（円なら円）" },
    },
    ["budget_id", "daily_amount"],
    updateBudget,
    W,
  ),
  tool(
    "google_ads_remove",
    "Google 広告のキャンペーン・広告を削除",
    "キャンペーン / 広告グループ / 広告を削除する。**元に戻せない。**" +
      "止めたいだけなら google_ads_update_status で PAUSED にする。" +
      "広告（kind=ad）の ID は「広告グループID~広告ID」の複合キー。",
    { kind: KIND, object_id: OBJECT_ID },
    ["object_id"],
    remove,
    { writes: true, destructive: true },
  ),
  tool(
    "google_ads_mutate",
    "Google 広告へ操作を送信",
    "型付きツールで足りない書き込みを通す最後の手段（googleAds:mutate）。" +
      "validate_only=true にすると Google 側で検算だけ行い**何も変更しない**ので、" +
      "複雑な操作は先にこれで通してから本番に送ること。",
    {
      mutate_operations: {
        type: "array",
        items: { type: "object" },
        description: "MutateOperation の配列（campaignOperation など）",
      },
      validate_only: { type: "boolean", description: "true なら検算だけで、実際には変更しない" },
    },
    ["mutate_operations"],
    mutate,
    { writes: true, destructive: true },
  ),
];
