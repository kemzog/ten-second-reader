// Start a Claude conversation about an article. claude.ai/new?q= prefills the
// prompt (on iPhone the link may open the Claude app instead of Safari).
export function claudePrompt(item) {
  return [
    '次の記事について一緒に考えたいです。',
    'まず要点を3行でまとめ、マネージャー・経営を目指す立場から何を学び、どう行動に活かせるかを提案してください。',
    'その後の質問にも答えてください。',
    '',
    `タイトル: ${item.title}`,
    `出典: ${item.source}`,
    `URL: ${item.link}`,
    ...(item.summary ? [`概要: ${item.summary}`] : []),
  ].join('\n');
}

export const claudeUrl = (item) => `https://claude.ai/new?q=${encodeURIComponent(claudePrompt(item))}`;
