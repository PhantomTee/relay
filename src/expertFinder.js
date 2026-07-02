import { getExpertScoresForKeywords } from './db.js'

const SEARCH_LOOKBACK_DAYS = 90

export async function findExpert(client, keywords, channelId, askerId) {
  const normalized = [...new Set((Array.isArray(keywords) ? keywords : []).map(k => String(k).toLowerCase()).filter(Boolean))].slice(0, 8)
  const query = normalized.join(' ')
  const scores = {}

  for (const row of await getExpertScoresForKeywords(normalized)) {
    if (!row.user_id || row.user_id === askerId) continue
    scores[row.user_id] = (scores[row.user_id] ?? 0) + Number(row.score ?? 0) * 2
  }

  try {
    const result = await client.search.messages({
      query,
      count: 50,
      sort: 'timestamp',
      sort_dir: 'desc'
    })

    const messages = result?.messages?.matches ?? []

    for (const msg of messages) {
      const userId = msg.user
      if (!userId || userId === askerId) continue

      const ageDays = (Date.now() / 1000 - parseFloat(msg.ts)) / 86400
      if (ageDays > SEARCH_LOOKBACK_DAYS) continue

      const weight = 1 + Math.max(0, 1 - ageDays / SEARCH_LOOKBACK_DAYS)
      scores[userId] = (scores[userId] ?? 0) + weight
    }
  } catch {
    await scanChannelHistory(client, channelId, normalized, askerId, scores)
  }

  const ranked = Object.entries(scores)
    .filter(([, score]) => score > 0)
    .sort((a, b) => b[1] - a[1])

  return ranked[0]?.[0] ?? null
}

async function scanChannelHistory(client, channelId, keywords, askerId, scores) {
  try {
    const oldest = String(Math.floor(Date.now() / 1000) - SEARCH_LOOKBACK_DAYS * 86400)
    const history = await client.conversations.history({ channel: channelId, oldest, limit: 200 })
    const lowerKeywords = keywords.map(k => k.toLowerCase())

    for (const msg of history.messages ?? []) {
      if (!msg.user || msg.user === askerId || !msg.text) continue
      const lower = msg.text.toLowerCase()
      const matches = lowerKeywords.filter(k => lower.includes(k)).length
      if (matches > 0) scores[msg.user] = (scores[msg.user] ?? 0) + matches
    }
  } catch {
    // silently skip if history is inaccessible
  }
}
