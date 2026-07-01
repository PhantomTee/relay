import cron from 'node-cron'
import { getPendingCommitments, markReminderSent } from './db.js'

export function startReminderCron(client) {
  // Run every hour
  cron.schedule('0 * * * *', async () => {
    const commitments = await getPendingCommitments()

    for (const commitment of commitments) {
      if (commitment.reminder_sent) continue

      const deadlineStr = commitment.deadline
        ? `<!date^${Math.floor(new Date(commitment.deadline).getTime() / 1000)}^{date_short_pretty} at {time}|${commitment.deadline}>`
        : 'soon'

      // Remind the person who made the commitment
      await client.chat.postMessage({
        channel: commitment.maker_id,
        text: `*RELAY Reminder* :alarm_clock:\nYou committed to: _"${commitment.description}"_\nDeadline: ${deadlineStr}\n\nType \`/relay done ${commitment.id.slice(0, 8)}\` once complete.`
      })

      // Notify the person it was promised to, if known
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
