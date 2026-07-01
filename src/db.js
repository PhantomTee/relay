import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

export async function logQuestion({ messageTs, channelId, questionText, askerId }) {
  const { data, error } = await supabase
    .from('questions')
    .upsert({ message_ts: messageTs, channel_id: channelId, question_text: questionText, asker_id: askerId })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function markQuestionAnswered(messageTs, answerText, expertId) {
  const { error } = await supabase
    .from('questions')
    .update({ answered: true, answer_text: answerText, expert_id: expertId })
    .eq('message_ts', messageTs)
  if (error) throw error
}

export async function logCommitment({ messageTs, channelId, makerId, promisedToId, description, deadline }) {
  const { data, error } = await supabase
    .from('commitments')
    .upsert({
      message_ts: messageTs,
      channel_id: channelId,
      maker_id: makerId,
      promised_to_id: promisedToId ?? null,
      description,
      deadline: deadline ?? null
    })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function markCommitmentDone(id) {
  const { error } = await supabase
    .from('commitments')
    .update({ completed: true })
    .eq('id', id)
  if (error) throw error
}

export async function getPendingCommitments() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await supabase
    .from('commitments')
    .select('*')
    .eq('completed', false)
    .not('deadline', 'is', null)
    .lte('deadline', tomorrow)
  if (error) throw error
  return data ?? []
}

export async function markReminderSent(id) {
  const { error } = await supabase
    .from('commitments')
    .update({ reminder_sent: true })
    .eq('id', id)
  if (error) throw error
}

export async function searchKnowledgeBase(query) {
  const { data, error } = await supabase
    .from('questions')
    .select('question_text, answer_text, expert_id, created_at')
    .eq('answered', true)
    .ilike('question_text', `%${query}%`)
    .order('created_at', { ascending: false })
    .limit(5)
  if (error) return []
  return data ?? []
}

export async function getUserCommitments(userId) {
  const { data, error } = await supabase
    .from('commitments')
    .select('*')
    .eq('maker_id', userId)
    .eq('completed', false)
    .order('deadline', { ascending: true })
  if (error) return []
  return data ?? []
}
