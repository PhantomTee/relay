import cron from 'node-cron'
import { findExpert } from './expertFinder.js'
import {
  getPendingCommitments,
  markReminderSent,
  getQuestionsReadyForRouting,
  markQuestionRouted,
  searchKnowledgeBase
} from './db.js'

function threadLink(channelId, messageTs) {
  return `https://slack.com/app_redirect?channel=${channelId}&message_ts=${messageTs}`
}

export function startReminderCron(client) {
  // Run every hour for commitments due in the next day.
  cron.schedule('0 * * * *', async () => {
    const commitments = await getPendingCommitments()

    for (const commitment of commitments) {
      const deadlineStr = commitment.deadline
        ? `<!date^${Math.floor(new Date(commitment.deadline).getTime() / 1000)}^{date_short_pretty} at {time}|${commitment.deadline}>`
        : 'soon'

      await client.chat.postMessage({
        channel: commitment.maker_id,
        text: `*RELAY Reminder* :alarm_clock:\nYou committed to: _"${commitment.description}"_\nDeadline: ${deadlineStr}\n\nType \`/relay-done ${commitment.id.slice(0, 8)}\` once complete.`
      })

      if (commitment.promised_to_id) {
        await client.chat.postMessage({
          channel: commitment.promised_to_id,
          text: `*RELAY Update* :eyes:\n<@${commitment.maker_id}> committed to: _"${commitment.description}"_\nDeadline: ${deadlineStr}`
        })
      }

      await markReminderSent(commitment.id)
    }
  })
}

export function startQuestionRoutingCron(client) {
  // Run every minute so unanswered questions survive process restarts.
  cron.schedule('* * * * *', async () => {
    const questions = await getQuestionsReadyForRouting(20)

    for (const question of questions) {
      const keywords = Array.isArray(question.keywords) ? question.keywords : []
      const expertId = await findExpert(client, keywords, question.channel_id, question.asker_id)

      if (!expertId) {
        await markQuestionRouted(question.message_ts, null)
        await client.chat.postMessage({
          channel: question.channel_id,
          thread_ts: question.message_ts,
          text: `:eyes: This question is still unanswered. RELAY could not find a confident expert yet, but anyone who knows the answer can reply here.`
        })
        continue
      }

      const pastAnswers = await searchKnowledgeBase(keywords.join(' '))
      const kbContext = Array.isArray(pastAnswers) && pastAnswers.length > 0
        ? `\n\n*Related past answers:*\n${pastAnswers.slice(0, 2).map(a => `> ${a.answer_text}`).join('\n')}`
        : ''

      await client.chat.postMessage({
        channel: expertId,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `:wave: *RELAY* found an unanswered question in <#${question.channel_id}>:\n\n*"${question.question_text}"*\n\nAsked by <@${question.asker_id}>. You were selected because you have discussed related topics before.${kbContext}`
            }
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Jump to thread' },
                url: threadLink(question.channel_id, question.message_ts),
                action_id: 'jump_to_thread'
              }
            ]
          }
        ],
        text: `Unanswered question from <@${question.asker_id}> in <#${question.channel_id}>`
      })

      await client.chat.postMessage({
        channel: question.channel_id,
        thread_ts: question.message_ts,
        text: `:bell: RELAY routed this to <@${expertId}> because they have relevant history. Hang tight.`
      })

      try {
        await client.reactions.remove({ channel: question.channel_id, timestamp: question.message_ts, name: 'hourglass_flowing_sand' })
      } catch {}
      try {
        await client.reactions.add({ channel: question.channel_id, timestamp: question.message_ts, name: 'bell' })
      } catch {}

      await markQuestionRouted(question.message_ts, expertId)
    }
  })
}
