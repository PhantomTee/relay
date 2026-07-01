import Groq from 'groq-sdk'
import 'dotenv/config'

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY })

const SYSTEM_PROMPT = `You are a message analyzer for RELAY, a Slack accountability agent.
Classify Slack messages and return ONLY valid JSON — no markdown, no explanation.

Classifications:
- "question": someone needs information, help, or a decision from the team. Must be a real work question, not casual chat.
- "commitment": someone explicitly promises to do something ("I'll", "I will", "will send", "sending you", "I'll get", "going to", "planning to").
- "noise": greetings, reactions, FYI updates, casual conversation, or anything else.

For questions, extract the core question text and 2-4 keywords useful for finding experts.
For commitments, extract what they committed to, the deadline as an ISO date (or null), and who they promised it to (first name or @handle, or null).`

export async function classify(text, senderName) {
  const today = new Date().toISOString().split('T')[0]

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Today: ${today}\nSender: ${senderName}\nMessage: "${text}"\n\nReturn JSON:\n{"type":"question"|"commitment"|"noise","confidence":0.0-1.0,"data":{"text":"...","keywords":["..."],"description":"...","deadline":"ISO or null","promisedTo":"name or null"}}`
      }
    ],
    temperature: 0.1,
    max_tokens: 256
  })

  try {
    const raw = response.choices[0].message.content.trim()
    const json = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'))
    return JSON.parse(json)
  } catch {
    return { type: 'noise', confidence: 0, data: {} }
  }
}
