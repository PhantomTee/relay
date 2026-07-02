export function extractKeywords(text, limit = 6) {
  return [...new Set(String(text).toLowerCase().match(/[a-z0-9][a-z0-9-]{3,}/g) ?? [])].slice(0, limit)
}
