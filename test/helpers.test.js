import assert from 'node:assert/strict'
import { redactSensitiveText } from '../src/privacy.js'
import { extractKeywords } from '../src/text.js'
import { cosineSimilarity } from '../src/embeddings.js'

function test(name, fn) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

test('redactSensitiveText removes common secrets and emails', () => {
  const input = 'token=xoxb-123-abc password=hunter2 email dev@example.com groq gsk_abcdefghijklmnopqrstuvwxyz'
  const output = redactSensitiveText(input)

  assert.equal(output.includes('xoxb-123-abc'), false)
  assert.equal(output.includes('hunter2'), false)
  assert.equal(output.includes('dev@example.com'), false)
  assert.equal(output.includes('gsk_abcdefghijklmnopqrstuvwxyz'), false)
  assert.match(output, /\[redacted\]/)
})

test('extractKeywords normalizes and de-duplicates work terms', () => {
  assert.deepEqual(
    extractKeywords('Deploy deploy worker retries? DB migration + rollback.', 4),
    ['deploy', 'worker', 'retries', 'migration']
  )
})

test('cosineSimilarity ranks identical vectors above unrelated vectors', () => {
  assert.equal(cosineSimilarity([1, 0, 0], [1, 0, 0]), 1)
  assert.equal(cosineSimilarity([1, 0, 0], [0, 1, 0]), 0)
})
