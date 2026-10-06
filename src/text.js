// Google 広告の「文字数」の数え方。

// 東アジア文字幅（UAX #11）の W / F にあたる主な範囲。半角カナ（H）と
// 曖昧幅（A。± や § など）は 1 のまま——ここを 2 に倒すと、Google が
// 受け付けるテキストをこちらだけが断ることになる。
const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe6f],
  [0xff01, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/**
 * Google が数える文字数。**全角は 2 と数える。**
 *
 * 見出し 30 / 説明文 90 の上限は、日本語では実質半分（15 / 45）になる。
 * length で数えると上限の 2 倍まで通ってしまい、Google 側で mutate 全体が
 * 落ちる（しかも違反を 1 つずつしか返さない）ので、送る前にここで数える。
 */
export function textWidth(text) {
  let width = 0;
  for (const ch of String(text)) {
    const code = ch.codePointAt(0);
    width += WIDE.some(([lo, hi]) => code >= lo && code <= hi) ? 2 : 1;
  }
  return width;
}
