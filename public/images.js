// Feed and og:image pictures that are not real pictures: title cards generated from the
// headline (Zenn, Qiita), favicons, one image reused for every post, broken URLs.
// Showing them would only repeat the headline, so the page goes without a photo instead.
const NOT_A_PICTURE = [
  /res\.cloudinary\.com\/zenn\//, // Zenn: the title rendered onto a card
  /qiita-user-contents\.imgix\.net\/.*cdn\.qiita\.com.*assets.*public/, // Qiita: title card
  /qiita-user-contents\.imgix\.net\/.*(txt|mark)=/,
  /favicon\./, // e.g. はてブ's 64px favicons
  /rss-thumbnail\./, // DHBR's placeholder
  /_ogimages?_/, // a site-wide share image (Seth Godin)
  /s0\.wp\.com\/_si\//, // WordPress site-icon card (Stratechery)
  /opengraph\.githubassets\.com/, // GitHub repository card
  /\/default[-_]?(og|ogp|share)/i,
];

export function usableImage(url) {
  if (!url || !/^https:\/\/[^/]+\.[^/]+\//.test(url)) return '';
  if (/https?\/\//.test(url.slice(8))) return ''; // "https://a.example/https//b..." — broken join
  return NOT_A_PICTURE.some((re) => re.test(url)) ? '' : url;
}

// Cut a summary at the end of a sentence rather than in the middle of a word.
export function tidySummary(text, max = 160) {
  if (!text) return '';
  let s = text.replace(/…$/, '').trim();
  const cut = s.length > max || /…$/.test(text);
  if (s.length > max) s = s.slice(0, max);
  if (!cut) return s;
  const ends = [...s.matchAll(/[。．！？!?]|\.(\s|$)/g)].map((m) => m.index + 1);
  const last = ends.at(-1);
  if (last && last >= s.length * 0.35) return s.slice(0, last).trim();
  const comma = Math.max(s.lastIndexOf('、'), s.lastIndexOf('，'), s.lastIndexOf(', '));
  return (comma >= s.length * 0.6 ? s.slice(0, comma) : s).trim() + '…';
}

// "Zenn トピック: AIエージェント" → { name: "Zenn", topic: "AIエージェント" }.
export function splitSource(source) {
  const m = /^(.+?)\s*(?:トピック|タグ|topic|tag)\s*[:：]\s*(.+)$/i.exec(source ?? '');
  return m ? { name: m[1].trim(), topic: m[2].trim() } : { name: source ?? '', topic: '' };
}

// Split a Japanese title into phrases (bunsetsu-like chunks) so a headline only wraps between
// them: never inside a word, never before a particle, closing bracket or punctuation, never
// after an opening bracket. Safari has no `word-break: auto-phrase`, so flip.js puts <wbr>
// between these chunks and sets `word-break: keep-all`.
const HIRA = /^[ぁ-ゟ]/;
const WORD_END = /[A-Za-z0-9゠-ヿ一-鿿々〆＋+#]$/;
const WORD_START = /^[A-Za-z0-9゠-ヿ一-鿿々〆＋+#]/;
const NO_BREAK_BEFORE = /^[、。，．・：；！？!?)）」』】〕〉》ー”’\s:;,.]/;
const NO_BREAK_AFTER = /[（(「『【〔〈《“‘]\s*$/;
export function phrases(text) {
  if (!text || typeof Intl === 'undefined' || !Intl.Segmenter) return text ? [text] : [];
  const out = [];
  for (const { segment } of new Intl.Segmenter('ja', { granularity: 'word' }).segment(text)) {
    const prev = out[out.length - 1];
    // a break is allowed only after kana/punctuation/space and before the start of a new word
    const join = prev != null && (HIRA.test(segment) || NO_BREAK_BEFORE.test(segment) ||
      NO_BREAK_AFTER.test(prev) || (WORD_END.test(prev) && WORD_START.test(segment)));
    if (join) out[out.length - 1] = prev + segment;
    else out.push(segment);
  }
  return out;
}
