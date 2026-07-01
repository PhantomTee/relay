const SEARCH_LOOKBACK_DAYS = 90

export async function findExpert(client, keywords, channelId, askerId) {
  const query = keywords.join(' ')
  const scores = {}

  try {
    // Use Slack's search.messages (Real-Time Search API) to find who has discussed this topic
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

      // Weight recent messages higher
      const ageDays = (Date.now() / 1000 - parseFloat(msg.ts)) / 86400
      if (ageDays > SEARCH_LOOKBACK_DAYS) continue

      const weight = 1 + Math.max(0, 1 - ageDays / SEARCH_LOOKBACK_DAYS)
      scores[userId] = (scores[userId] ?? 0) + weight
    }
  } catch {
    // Fallback: scan channel history if search.messages needs a user token
    await scanChannelHistory(client, channelId, keywords, askerId, scores)
  }

  if (Object.keys(scores).length === 0) return null

  return Object.entries(scores).sort((a, b) => b[1] - a[1])[0][0]
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
