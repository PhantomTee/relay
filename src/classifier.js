import Groq from 'groq-sdk'
import { z } from 'zod'
import 'dotenv/config'
import { redactSensitiveText } from './privacy.js'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const ClassificationSchema = z.object({
  type: z.enum(['question', 'commitment', 'noise']),
  confidence: z.number().min(0).max(1),
  data: z.object({
    text: z.string().optional().nullable(),
    keywords: z.array(z.string()).optional().default([]),
    description: z.string().optional().nullable(),
    deadline: z.string().optional().nullable(),
    promisedTo: z.string().optional().nullable()
  }).passthrough().default({})
})

const SYSTEM_PROMPT = `You are a message analyzer for RELAY, a Slack accountability agent.
Classify Slack messages and return ONLY valid JSON. No markdown. No explanation.

Classifications:
- "question": someone needs information, help, or a decision from the team. Must be a real work question, not casual chat.
- "commitment": someone explicitly promises to do something, e.g. "I'll send", "I will fix", "will get", "going to deploy".
- "noise": greetings, reactions, FYI updates, casual conversation, or anything else.

For questions, extract the core question text and 2-4 keywords useful for finding experts.
For commitments, extract the promise description, deadline as an ISO date if clear, and who it was promised to if clear.`

function extractJson(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return null
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  return text.slice(start, end + 1)
}

function fallback() {
  return { type: 'noise', confidence: 0, data: {} }
}

export async function classify(text, senderName) {
  const today = new Date().toISOString().split('T')[0]
  const safeText = redactSensitiveText(text)

  try {
    const response = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL ?? 'llama-3.3-70b-versatile',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Today: ${today}\nSender: ${senderName}\nMessage: "${safeText}"\n\nReturn JSON exactly shaped as:\n{"type":"question|commitment|noise","confidence":0.0,"data":{"text":"...","keywords":["..."],"description":"...","deadline":null,"promisedTo":null}}`
        }
      ],
      temperature: 0.1,
      max_tokens: 256
    })

    const jsonText = extractJson(response.choices[0]?.message?.content)
    if (!jsonText) return fallback()

    const parsed = ClassificationSchema.safeParse(JSON.parse(jsonText))
    if (!parsed.success) return fallback()

    return parsed.data
  } catch (error) {
    console.error('[classifier] failed', error?.message ?? error)
    return fallback()
  }
}

