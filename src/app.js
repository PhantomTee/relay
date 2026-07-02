import 'dotenv/config'
import { App, Assistant } from '@slack/bolt'
import { classify } from './classifier.js'
import { findExpert } from './expertFinder.js'
import { startReminderCron, startQuestionRoutingCron } from './reminders.js'
import { connectMCP, callTool } from './mcp/client.js'
import { extractKeywords } from './text.js'
import { redactSensitiveText } from './privacy.js'
import { storeInstallation, fetchInstallation, deleteInstallation } from './db.js'

const QUESTION_TIMEOUT_MS = parseInt(process.env.QUESTION_TIMEOUT_MS ?? '300000', 10)
const CONFIDENCE_THRESHOLD = Number(process.env.CONFIDENCE_THRESHOLD ?? '0.70')
const PORT = Number(process.env.PORT ?? '3001')
const REQUIRE_CHANNEL_OPT_IN = process.env.RELAY_REQUIRE_CHANNEL_OPT_IN === 'true'
const SLACK_SCOPES = (process.env.SLACK_SCOPES ?? 'app_mentions:read,assistant:write,channels:history,channels:read,chat:write,chat:write.public,commands,groups:history,im:history,im:write,mpim:history,reactions:read,reactions:write,search:read,users:read').split(',').map(s => s.trim()).filter(Boolean)

function slackAppConfig() {
  const base = {
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    port: PORT
  }

  if (process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.SLACK_STATE_SECRET) {
    return {
      ...base,
      clientId: process.env.SLACK_CLIENT_ID,
      clientSecret: process.env.SLACK_CLIENT_SECRET,
      stateSecret: process.env.SLACK_STATE_SECRET,
      scopes: SLACK_SCOPES,
      installationStore: {
        storeInstallation,
        fetchInstallation,
        deleteInstallation
      },
      installerOptions: {
        directInstall: true
      }
    }
  }

  return {
    ...base,
    token: process.env.SLACK_BOT_TOKEN
  }
}

const app = new App(slackAppConfig())

app.error(async (error) => {
  console.error('[ERROR]', error)
})
const relayAssistant = new Assistant({
  threadStarted: async ({ say, setSuggestedPrompts, setTitle }) => {
    await setTitle('RELAY team memory')
    await setSuggestedPrompts({
      title: 'Ask RELAY',
      prompts: [
        { title: 'Find a past answer', message: 'What does the team know about deploy retries?' },
        { title: 'Check my commitments', message: 'Show my open commitments' },
        { title: 'Explain RELAY', message: 'What can RELAY do in this workspace?' }
      ]
    })
    await say('Ask me about past answers, open commitments, or where to route a team question.')
  },
  userMessage: async ({ message, context, say, setStatus }) => {
    const text = redactSensitiveText(message.text ?? '')
    await setStatus({ status: 'Searching RELAY memory' })

    const lower = text.toLowerCase()
    if (lower.includes('commitment')) {
      const commitments = await callTool('get_user_commitments', { userId: context.userId ?? message.user })
      const reply = Array.isArray(commitments) && commitments.length > 0
        ? commitments.map(c => `- \`${c.id.slice(0, 8)}\` ${c.description}`).join('\n')
        : 'You have no open commitments in RELAY.'
      await say(reply)
      return
    }

    if (lower.includes('what can relay') || lower.includes('help')) {
      await say('RELAY tracks unanswered questions, routes them to likely experts, remembers useful answers, logs commitments, and supports channel opt-in plus data deletion controls.')
      return
    }

    const keywords = extractKeywords(text)
    const answers = await callTool('search_knowledge_base', { query: keywords.length > 0 ? keywords.join(' ') : text })
    if (Array.isArray(answers) && answers.length > 0) {
      await say(`Here is the best answer I found:\n\n> ${answers[0].answer_text}\n\nSource question: "${answers[0].question_text}"`)
      return
    }

    await say('I could not find a stored answer yet. Try `/relay-ask <question>` in the relevant channel and I can route it to an expert.')
  }
})

app.assistant(relayAssistant)

function threadLink(channelId, messageTs) {
  return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${messageTs}`
}

function isDm(channelId) {
  return String(channelId).startsWith('D')
}

function parseActionValue(value) {
  try {
    return JSON.parse(value)
  } catch {
    return {}
  }
}

function questionActionBlocks(messageTs, channelId) {
  const value = JSON.stringify({ messageTs, channelId })
  return [
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Route now' },
          action_id: 'relay_route_now',
          value
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Snooze 30 min' },
          action_id: 'relay_snooze',
          value
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Mark resolved' },
          style: 'primary',
          action_id: 'relay_mark_resolved',
          value
        }
      ]
    }
  ]
}

function feedbackBlocks(messageTs, channelId) {
  const value = JSON.stringify({ messageTs, channelId })
  return [
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Helpful' },
          style: 'primary',
          action_id: 'relay_feedback_good',
          value
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Needs work' },
          action_id: 'relay_feedback_bad',
          value
        }
      ]
    }
  ]
}

async function isWorkspaceAdmin(client, userId) {
  try {
    const info = await client.users.info({ user: userId })
    return Boolean(info.user?.is_admin || info.user?.is_owner || info.user?.is_primary_owner)
  } catch {
    return false
  }
}

async function getSenderName(client, userId) {
  try {
    const info = await client.users.info({ user: userId })
    return info.user?.real_name ?? info.user?.name ?? userId
  } catch {
    return userId
  }
}

async function channelAllowsRelay(channelId) {
  if (isDm(channelId)) return true
  const settings = await callTool('get_channel_settings', { channelId })
  if (settings && typeof settings.enabled === 'boolean') return settings.enabled
  return !REQUIRE_CHANNEL_OPT_IN
}

async function postQuestionControlMessage({ client, channelId, messageTs, text }) {
  await client.chat.postMessage({
    channel: channelId,
    thread_ts: messageTs,
    text,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text } },
      ...questionActionBlocks(messageTs, channelId)
    ]
  })
}

async function routeQuestionNow({ client, question, actorId }) {
  const keywords = Array.isArray(question.keywords) ? question.keywords : extractKeywords(question.question_text)
  const expertId = await findExpert(client, keywords, question.channel_id, question.asker_id)

  if (!expertId) {
    await callTool('snooze_question', { messageTs: question.message_ts, delayMs: 30 * 60 * 1000 })
    await client.chat.postMessage({
      channel: question.channel_id,
      thread_ts: question.message_ts,
      text: `:eyes: <@${actorId}> asked RELAY to route now, but no confident expert was found. I will retry in 30 minutes.`
    })
    return null
  }

  await callTool('mark_question_routed', { messageTs: question.message_ts, expertId })
  await client.chat.postMessage({
    channel: expertId,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `:wave: *RELAY* needs your help in <#${question.channel_id}>:\n\n*"${question.question_text}"*\n\nAsked by <@${question.asker_id}>.`
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: 'Jump to thread' },
            url: threadLink(question.channel_id, question.message_ts),
            action_id: 'relay_jump_to_thread'
          }
        ]
      }
    ],
    text: `Unanswered question from <@${question.asker_id}> in <#${question.channel_id}>`
  })

  await client.chat.postMessage({
    channel: question.channel_id,
    thread_ts: question.message_ts,
    text: `:bell: RELAY routed this to <@${expertId}>.`
  })

  try { await client.reactions.remove({ channel: question.channel_id, timestamp: question.message_ts, name: 'hourglass_flowing_sand' }) } catch {}
  try { await client.reactions.add({ channel: question.channel_id, timestamp: question.message_ts, name: 'bell' }) } catch {}
  return expertId
}

async function handleAnswerReply({ message, client }) {
  if (!message.thread_ts) return false

  const tracked = await callTool('get_question', { messageTs: message.thread_ts })
  if (!tracked || tracked.answered || !['waiting', 'routed'].includes(tracked.status)) return false

  await callTool('log_answer', {
    messageTs: message.thread_ts,
    answerText: message.text,
    expertId: message.user
  })

  for (const name of ['hourglass_flowing_sand', 'bell']) {
    try { await client.reactions.remove({ channel: message.channel, timestamp: message.thread_ts, name }) } catch {}
  }
  try { await client.reactions.add({ channel: message.channel, timestamp: message.thread_ts, name: 'white_check_mark' }) } catch {}

  await client.chat.postMessage({
    channel: message.channel,
    thread_ts: message.thread_ts,
    text: `:white_check_mark: RELAY captured this answer from <@${message.user}> and added it to the team memory.`,
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `:white_check_mark: RELAY captured this answer from <@${message.user}> and added it to the team memory.` } },
      ...feedbackBlocks(message.thread_ts, message.channel)
    ]
  })

  console.log(`[RELAY] Question ${message.thread_ts} resolved by ${message.user}`)
  return true
}

async function logDetectedQuestion({ client, message, questionText, keywords }) {
  const pastAnswers = await callTool('search_knowledge_base', { query: keywords.join(' ') })
  if (Array.isArray(pastAnswers) && pastAnswers.length > 0) {
    const best = pastAnswers[0]
    await client.chat.postMessage({
      channel: message.channel,
      thread_ts: message.ts,
      text: `:brain: *RELAY found a past answer to this:*\n\n> ${best.answer_text}\n\n_If this does not fully answer the question, reply in this thread and RELAY will remember the better answer._`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:brain: *RELAY found a past answer to this:*\n\n> ${best.answer_text}\n\n_If this does not fully answer the question, reply in this thread and RELAY will remember the better answer._` } },
        ...feedbackBlocks(best.message_ts ?? message.ts, message.channel)
      ]
    })
    try { await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'bulb' }) } catch {}
    return
  }

  await callTool('log_question', {
    messageTs: message.ts,
    channelId: message.channel,
    questionText,
    askerId: message.user,
    keywords,
    routeAfterMs: QUESTION_TIMEOUT_MS
  })

  try { await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'hourglass_flowing_sand' }) } catch {}

  await postQuestionControlMessage({
    client,
    channelId: message.channel,
    messageTs: message.ts,
    text: ':hourglass_flowing_sand: RELAY is tracking this. If nobody answers soon, I will route it to a likely expert.'
  })
}

async function logDetectedCommitment({ client, message, result }) {
  const commitment = await callTool('log_commitment', {
    messageTs: message.ts,
    channelId: message.channel,
    makerId: message.user,
    description: result.data.description ?? message.text,
    deadline: result.data.deadline ?? null,
    promisedToId: null
  })

  try { await client.reactions.add({ channel: message.channel, timestamp: message.ts, name: 'white_check_mark' }) } catch {}

  const deadlineText = result.data.deadline
    ? ` by <!date^${Math.floor(new Date(result.data.deadline).getTime() / 1000)}^{date_short_pretty}|${result.data.deadline}>`
    : ''

  await client.chat.postEphemeral({
    channel: message.channel,
    user: message.user,
    text: `:white_check_mark: *RELAY logged your commitment:* _"${commitment.description}"_${deadlineText}\nUse \`/relay-done ${commitment.id.slice(0, 8)}\` when it is complete.`
  })
}

async function publishHome(client, userId) {
  const [commitments, questions] = await Promise.all([
    callTool('get_user_commitments', { userId }),
    callTool('get_user_open_questions', { userId })
  ])

  const commitmentText = Array.isArray(commitments) && commitments.length > 0
    ? commitments.slice(0, 8).map(c => {
        const dl = c.deadline ? ` _(due <!date^${Math.floor(new Date(c.deadline).getTime() / 1000)}^{date_short_pretty}|${c.deadline}>)_` : ''
        return `- \`${c.id.slice(0, 8)}\` ${c.description}${dl}`
      }).join('\n')
    : '_No open commitments._'

  const questionText = Array.isArray(questions) && questions.length > 0
    ? questions.slice(0, 8).map(q => `- ${q.status === 'routed' ? ':bell:' : ':hourglass_flowing_sand:'} <${threadLink(q.channel_id, q.message_ts)}|${q.question_text}>`).join('\n')
    : '_No unanswered questions._'

  await client.views.publish({
    user_id: userId,
    view: {
      type: 'home',
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'RELAY' } },
        { type: 'section', text: { type: 'mrkdwn', text: '*Open commitments*\n' + commitmentText } },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '*Unanswered questions*\n' + questionText } },
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Use `/relay-ask`, `/relay-status`, `/relay-enable`, and `/relay-disable` from Slack.' }] }
      ]
    }
  })
}

app.message(async ({ message, client }) => {
  if (message.subtype || message.bot_id || !message.text || !message.user) return
  if (!(await channelAllowsRelay(message.channel))) return

  if (await handleAnswerReply({ message, client })) return
  if (message.thread_ts) return

  const senderName = await getSenderName(client, message.user)
  const result = await classify(message.text, senderName)
  console.log(`[RELAY] "${redactSensitiveText(message.text).slice(0, 60)}" -> ${result.type} (${Math.round(result.confidence * 100)}%)`)
  if (result.confidence < CONFIDENCE_THRESHOLD) return

  if (result.type === 'question') {
    const questionText = result.data.text ?? message.text
    const keywords = Array.isArray(result.data.keywords) && result.data.keywords.length > 0
      ? result.data.keywords
      : extractKeywords(questionText)
    await logDetectedQuestion({ client, message, questionText, keywords })
  }

  if (result.type === 'commitment') {
    await logDetectedCommitment({ client, message, result })
  }
})

app.event('app_home_opened', async ({ event, client }) => {
  await publishHome(client, event.user)
})

app.command('/relay-enable', async ({ command, ack, client }) => {
  await ack()
  if (isDm(command.channel_id)) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: 'RELAY is already active in direct messages.' })
    return
  }
  await callTool('set_channel_enabled', { channelId: command.channel_id, enabled: true, configuredBy: command.user_id })
  await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: `RELAY is enabled in <#${command.channel_id}>.` })
})

app.command('/relay-disable', async ({ command, ack, client }) => {
  await ack()
  if (isDm(command.channel_id)) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: 'RELAY cannot be disabled for direct messages.' })
    return
  }
  await callTool('set_channel_enabled', { channelId: command.channel_id, enabled: false, configuredBy: command.user_id })
  await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: `RELAY is disabled in <#${command.channel_id}>. Existing tracked items remain in the database.` })
})

app.command('/relay-delete-mine', async ({ command, ack, client }) => {
  await ack()
  await callTool('delete_user_data', { userId: command.user_id })
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text: 'RELAY deleted your tracked questions, answers, commitments, and feedback from its database.'
  })
})

app.command('/relay-purge', async ({ command, ack, client }) => {
  await ack()
    if (!(await isWorkspaceAdmin(client, command.user_id))) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: 'Only Slack workspace admins or owners can run `/relay-purge`.' })
    return
  }

  const days = Number(command.text.trim() || process.env.DATA_RETENTION_DAYS || 90)
  if (!Number.isFinite(days) || days < 1) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: 'Usage: `/relay-purge <days>` where days is greater than 0.' })
    return
  }

  const result = await callTool('purge_old_data', { days })
  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    text: `RELAY purged completed/historical data older than ${days} days. Cutoff: ${result.purgedBefore}.`
  })
})
app.command('/relay-status', async ({ command, ack, client }) => {
  await ack()
  await publishHome(client, command.user_id)

  const [commitments, questions] = await Promise.all([
    callTool('get_user_commitments', { userId: command.user_id }),
    callTool('get_user_open_questions', { userId: command.user_id })
  ])

  const commitmentLines = Array.isArray(commitments) && commitments.length > 0
    ? commitments.map(c => {
        const dl = c.deadline ? ` _(due <!date^${Math.floor(new Date(c.deadline).getTime() / 1000)}^{date_short_pretty}|${c.deadline}>)_` : ''
        return `- \`${c.id.slice(0, 8)}\` ${c.description}${dl}`
      }).join('\n')
    : '_No open commitments_'

  const questionLines = Array.isArray(questions) && questions.length > 0
    ? questions.map(q => `- ${q.status === 'routed' ? ':bell:' : ':hourglass_flowing_sand:'} "${q.question_text}" in <#${q.channel_id}>`).join('\n')
    : '_No unanswered questions being tracked_'

  await client.chat.postEphemeral({
    channel: command.channel_id,
    user: command.user_id,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'RELAY - Your Accountability Status' } },
      { type: 'section', text: { type: 'mrkdwn', text: `*Open Commitments*\n${commitmentLines}` } },
      { type: 'divider' },
      { type: 'section', text: { type: 'mrkdwn', text: `*Your Unanswered Questions*\n${questionLines}` } }
    ],
    text: 'Your RELAY status'
  })
})

app.command('/relay-ask', async ({ command, ack, client }) => {
  await ack()

  if (!(await channelAllowsRelay(command.channel_id))) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: 'RELAY is disabled in this channel. Run `/relay-enable` here to opt in.' })
    return
  }

  const question = command.text.trim()
  if (!question) {
    await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: 'Usage: `/relay-ask <your question>`' })
    return
  }

  const posted = await client.chat.postMessage({
    channel: command.channel_id,
    text: `*<@${command.user_id}> asked:* ${question}`
  })

  const keywords = extractKeywords(question)
  const pastAnswers = await callTool('search_knowledge_base', { query: keywords.join(' ') })
  if (Array.isArray(pastAnswers) && pastAnswers.length > 0) {
    await client.chat.postMessage({
      channel: command.channel_id,
      thread_ts: posted.ts,
      text: `:brain: *RELAY found a past answer:*\n\n> ${pastAnswers[0].answer_text}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: `:brain: *RELAY found a past answer:*\n\n> ${pastAnswers[0].answer_text}` } },
        ...feedbackBlocks(pastAnswers[0].message_ts ?? posted.ts, command.channel_id)
      ]
    })
    return
  }

  await callTool('log_question', {
    messageTs: posted.ts,
    channelId: command.channel_id,
    questionText: question,
    askerId: command.user_id,
    keywords,
    routeAfterMs: 0
  })

  const tracked = await callTool('get_question', { messageTs: posted.ts })
  const expertId = tracked ? await routeQuestionNow({ client, question: tracked, actorId: command.user_id }) : null
  if (!expertId) {
    await postQuestionControlMessage({
      client,
      channelId: command.channel_id,
      messageTs: posted.ts,
      text: ':eyes: No expert found yet. RELAY will keep this open for follow-up.'
    })
  }
})

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

app.action('relay_route_now', async ({ body, ack, client, action }) => {
  await ack()
  const { messageTs } = parseActionValue(action.value)
  const question = await callTool('get_question', { messageTs })
  if (!question || question.answered) return
  await routeQuestionNow({ client, question, actorId: body.user.id })
})

app.action('relay_snooze', async ({ body, ack, client, action }) => {
  await ack()
  const { messageTs, channelId } = parseActionValue(action.value)
  await callTool('snooze_question', { messageTs, delayMs: 30 * 60 * 1000 })
  await client.chat.postEphemeral({ channel: channelId ?? body.channel?.id, user: body.user.id, text: 'RELAY will wait 30 minutes before trying to route this again.' })
})

app.action('relay_mark_resolved', async ({ body, ack, client, action }) => {
  await ack()
  const { messageTs, channelId } = parseActionValue(action.value)
  const question = await callTool('get_question', { messageTs })
  if (!question || question.answered) return
  await callTool('log_answer', {
    messageTs,
    answerText: `Marked resolved by <@${body.user.id}> without a captured answer.`,
    expertId: body.user.id
  })
  await client.chat.postMessage({
    channel: channelId ?? question.channel_id,
    thread_ts: messageTs,
    text: `:white_check_mark: <@${body.user.id}> marked this as resolved.`
  })
})

for (const rating of ['good', 'bad']) {
  app.action(`relay_feedback_${rating}`, async ({ body, ack, client, action }) => {
    await ack()
    const { messageTs, channelId } = parseActionValue(action.value)
    await callTool('record_feedback', {
      messageTs,
      channelId: channelId ?? body.channel?.id,
      userId: body.user.id,
      rating,
      reason: null
    })
    await client.chat.postEphemeral({ channel: channelId ?? body.channel?.id, user: body.user.id, text: rating === 'good' ? 'Feedback saved: helpful.' : 'Feedback saved: needs work.' })
  })
}

;(async () => {
  await connectMCP()
  startReminderCron(app.client)
  startQuestionRoutingCron(app.client)
  await app.start(PORT)
  console.log(`RELAY is running on :${PORT}`)
})()





