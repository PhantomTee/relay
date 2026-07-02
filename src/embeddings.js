const DEFAULT_EMBEDDING_MODEL = process.env.EMBEDDING_MODEL ?? 'text-embedding-3-small'

function normalizeVector(vector) {
  if (!Array.isArray(vector)) return null
  const numeric = vector.map(Number).filter(Number.isFinite)
  return numeric.length > 0 ? numeric : null
}

export function cosineSimilarity(a, b) {
  const left = normalizeVector(a)
  const right = normalizeVector(b)
  if (!left || !right || left.length !== right.length) return 0

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let i = 0; i < left.length; i += 1) {
    dot += left[i] * right[i]
    leftNorm += left[i] * left[i]
    rightNorm += right[i] * right[i]
  }

  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

export async function createEmbedding(text) {
  if (!process.env.EMBEDDING_API_URL || !process.env.EMBEDDING_API_KEY) return null

  const response = await fetch(process.env.EMBEDDING_API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.EMBEDDING_API_KEY}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: DEFAULT_EMBEDDING_MODEL,
      input: String(text ?? '').slice(0, 8000)
    })
  })

  if (!response.ok) throw new Error(`Embedding request failed: ${response.status}`)
  const json = await response.json()
  return normalizeVector(json?.data?.[0]?.embedding ?? json?.embedding)
}
