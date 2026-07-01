import 'dotenv/config'
import { App } from '@slack/bolt'
import { classify } from './classifier.js'
import { findExpert } from './expertFinder.js'
import { startReminderCron } from './reminders.js'
import { connectMCP, callTool } from './mcp/client.js'

const QUESTION_TIMEOUT_MS = parseInt(process.env.QUESTION_TIMEOUT_MS ?? '300000') // 5 min default
const CONFIDENCE_THRESHOLD = 0.70

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  port: 3001
})

// Debug: log every incoming event
app.use(async ({ payload, next }) => {
  console.log(`[RAW] type=${payload?.type} subtype=${payload?.subtype ?? 'none'}`)
  await next()
})

app.error(async (error) => {
  console.error('[ERROR]', error)
})

// ts -> { timer, channelId, askerId, questionText, keywords }
const pendingQuestions = new Map()

app.message(async ({ message, client }) => {
  console.log(`[EVENT] message received:`, JSON.stringify({ text: message.text, user: message.user, subtype: message.subtype }).slice(0, 120))
  // Ignore bots, edits, deletions
  if (message.subtype || message.bot_id || !message.text || !message.user) return

  // If it's a thread reply, check if it resolves a tracked question
  if (message.thread_ts && pendingQuestions.has(message.thread_ts)) {
    const pending = pendingQuestions.get(message.thread_ts)
    clearTimeout(pending.timer)
    pendingQuestions.delete(message.thread_ts)

    await callTool('log_answer', {
      messageTs: message.thread_ts,
      answerText: message.text,
      expertId: message.user
    })

    // Mark as resolved — swap any reaction to ✅
    try {
      await client.reactions.remove({ channel: message.channel, timestamp: message.thread_ts, name: 'hourglass_flowing_sand' })
    } catch {}
    try {
      await client.reactions.remove({ channel: message.channel, timestamp: message.thread_ts, name: 'bell' })
    } catch {}
    try {
      await client.reactions.add({ channel: message.channel, timestamp: message.thread_ts, name: 'white_check_mark' })
    } catch {}

    console.log(`[RELAY] Question ${message.thread_ts} resolved by ${message.user}`)
    return
  }

  // Don't process thread replies that aren't for tracked questions
  if (message.thread_ts) return

  let senderName = message.user
  try {
    const info = await client.users.info({ user: message.user })
    senderName = info.user?.real_name ?? info.user?.name ?? message.user
  } catch {}

  const result = await classify(message.text, senderName)
  console.log(`[RELAY] "${message.text.slice(0, 60)}" → ${result.type} (${Math.round(result.confidence * 100)}%)`)
  if (result.confidence < CONFIDENCE_THRESHOLD) return

  if (result.type === 'question') {
    const questionText = result.data.text ?? message.text
    const keywords = result.data.keywords ?? []

    // Check KB for a past answer before doing anything else
    const pastAnswers = await callTool('search_knowledge_base', { query: keywords.join(' ') })
    if (Array.isArray(pastAnswers) && pastAnswers.length > 0) {
      const best = pastAnswers[0]
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text: `:brain: *RELAY found a past answer to this:*\n\n> ${best.answer_text}\n\n_If this doesn't fully answer your question, someone will follow up._`
      })
      try { await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'bulb' }) } catch {}
      console.log(`[RELAY] Duplicate question answered from KB`)
      return
    }

    await callTool('log_question', {
      messageTs: message.ts,
      channelId: message.channel,
      questionText,
      askerId: message.user
    })

    // React with ⏳ so the channel knows RELAY is tracking this
    try {
      await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'hourglass_flowing_sand' })
    } catch {}

    const timer = setTimeout(async () => {
      pendingQuestions.delete(message.ts)

      const expertId = await findExpert(client, keywords, message.channel, message.user)

      if (!expertId) {
        // No expert found — still let the asker know we tried
        await client.chat.postMessage({
          channel: message.channel,
          thread_ts: message.ts,
          text: `:eyes: This question hasn't been answered yet. If you know the answer, please reply in this thread!`
        })
        return
      }

      // Search KB for past answers to give expert context
      const pastAnswers = await callTool('search_knowledge_base', { query: keywords.join(' ') })
      const kbContext = Array.isArray(pastAnswers) && pastAnswers.length > 0
        ? `\n\n*Related past answers:*\n${pastAnswers.slice(0, 2).map(a => `> ${a.answer_text}`).join('\n')}`
        : ''

      // DM the expert privately
      await client.chat.postMessage({
        channel: expertId,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:wave: *RELAY* spotted an unanswered question in <#${message.channel}>:\n\n*"${result.data.text ?? message.text}"*\n\nAsked by <@${message.user}> — you've discussed this topic before.${kbContext}`
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Jump to thread' },
                url: `https://slack.com/app_redirect?channel=${message.channel}&message_ts=${message.ts}`,
                action_id: 'jump_to_thread'
              }
            ]
          }
        ],
        text: `Unanswered question from <@${message.user}> in <#${message.channel}>`
      })

      // Let the asker know in the thread that help is on the way
      await client.chat.postMessage({
        channel: message.channel,
        thread_ts: message.ts,
        text: `:relay: This question has been routed to someone who can help — hang tight.`
      })

      // Swap ⏳ for 🔔 to show it's been escalated
      try {
        await client.reactions.remove({ channel: message.channel, timestamp: message.ts, name: 'hourglass_flowing_sand' })
        await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'bell' })
      } catch {}
    }, QUESTION_TIMEOUT_MS)

    pendingQuestions.set(message.ts, {
      timer,
      channelId: message.channel,
      askerId: message.user,
      questionText,
      keywords
    })
  }

  if (result.type === 'commitment') {
    const commitment = await callTool('log_commitment', {
      messageTs: message.ts,
      channelId: message.channel,
      makerId: message.user,
      description: result.data.description ?? message.text,
      deadline: result.data.deadline ?? null,
      promisedToId: null
    })

    // React with a checkmark so the user knows RELAY logged it
    try {
      await client.reactions.add({
        channel: message.channel,
        timestamp: message.ts,
        name: 'white_check_mark'
      })
    } catch {}

    // Confirm via ephemeral message
    const deadlineText = result.data.deadline
      ? ` by <!date^${Math.floor(new Date(result.data.deadline).getTime() / 1000)}^{date_short_pretty}|${result.data.deadline}>`
      : ''

    await client.chat.postEphemeral({
      channel: message.channel,
      user: message.user,
      text: `:white_check_mark: *RELAY logged your commitment:* _"${result.data.description}"_${deadlineText}\nI'll remind you before the deadline.`
    })
  }
})

// /relay-status — show your open commitments and pending questions
app.command('/relay-status', async ({ command, ack, client }) => {
  await ack()

  const [commitments, questions] = await Promise.all([
    callTool('get_user_commitments', { userId: command.user_id }),
    Promise.resolve([...pendingQuestions.values()].filter(q => q.askerId === command.user_id))
  ])

  const commitmentLines = Array.isArray(commitments) && commitments.length > 0
    ? commitments.map(c => {
        const dl = c.deadline ? ` _(due <!date^${Math.floor(new Date(c.deadline).getTime() / 1000)}^{date_short_pretty}|${c.deadline}>)_` : ''
        return `• ${c.description}${dl}`
      }).join('\n')
    : '_No open commitments_'

  const questionLines = questions.length > 0
    ? questions.map(q => `• "${q.questionText}" in <#${q.channelId}>`).join('\n')
    : '_No unanswered questions being tracked_'

  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'RELAY — Your Accountability Status' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Open Commitments*\n${commitmentLines}` } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Your Unanswered Questions*\n${questionLines}` } }
    ],
    text: 'Your RELAY status'
  })
})

// /relay-ask <question> — immediately route a question to the best expert
app.command('/relay-ask', async ({ command, ack, client }) => {
  await ack()

  const question = command.text.trim()
  if (!question) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: 'Usage: `/relay-ask <your question>`' })
    return
  }

  // Post the question publicly in the channel
  const posted = await client.chat.postMessage({
    channel: command.channel_id,
    text: `*<@${command.user_id}> asked:* ${question}`
  })

  const keywords = question.toLowerCase().split(/\s+/).filter(w => w.length > 4)

  // Check KB first
  const pastAnswers = await callTool('search_knowledge_base', { query: keywords.join(' ') })
  if (Array.isArray(pastAnswers) && pastAnswers.length > 0) {
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: posted.ts,
      text: `:brain: *RELAY found a past answer:*\n\n> ${pastAnswers[0].answer_text}`
    })
    return
  }

  // No KB hit — find and notify expert immediately
  const expertId = await findExpert(client, keywords, command.channel_id, command.user_id)
  if (expertId) {
    await client.chat.postMessage({
      channel: expertId,
      text: `:wave: <@${command.user_id}> needs help in <#${command.channel_id}>:\n\n*"${question}"*\n\nCan you help? <slack://channel?team=T&id=${command.channel_id}|Jump to channel>`
    })
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: posted.ts,
      text: `:bell: RELAY has notified someone who can help.`
    })
    try { await client.reactions.add({ channel: command.channel_id, timestamp: posted.ts, name: 'bell' }) } catch {}
  } else {
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: posted.ts,
      text: `:eyes: No expert found yet — if you know the answer, please reply here!`
    })
  }
})

// /relay-done <commitment-id-prefix> — mark a commitment complete
app.command('/relay-done', async ({ command, ack, client }) => {
  await ack()

  const prefix = command.text.trim()
  if (!prefix) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: 'Usage: `/relay-done <commitment-id>`' })
    return
  }

  const commitments = await callTool('get_user_commitments', { userId: command.user_id })
  const match = Array.isArray(commitments) && commitments.find(c => c.id.startsWith(prefix))

  if (!match) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: `No commitment found matching \`${prefix}\`. Run \`/relay-status\` to see your list.` })
    return
  }

  await callTool('mark_commitment_done', { id: match.id })
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text: `:tada: Marked as done: _"${match.description}"_`
  })
})

;(async () => {
  await connectMCP()
  startReminderCron(app.client)
  await app.start()
  console.log('RELAY is running')
})()
