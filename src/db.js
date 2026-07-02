import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'
import { createEmbedding, cosineSimilarity } from './embeddings.js'

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
)

function isoFromDelay(delayMs) {
  return new Date(Date.now() + delayMs).toISOString()
}

function normalizeTerms(query) {
  return [...new Set(String(query ?? '').toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? [])].slice(0, 8)
}

function normalizeKeywords(keywords = []) {
  return [...new Set((Array.isArray(keywords) ? keywords : []).map(k => String(k).toLowerCase()).filter(Boolean))].slice(0, 8)
}

function escapeIlike(value) {
  return String(value).replace(/[%_]/g, match => `\\${match}`).replace(/[,()]/g, ' ')
}

function cutoffIso(days) {
  return new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000).toISOString()
}

async function maybeEmbedding(text) {
  try {
    return await createEmbedding(text)
  } catch (error) {
    console.warn('[embedding] skipped', error?.message ?? error)
    return null
  }
}

export async function storeInstallation(installation) {
  const teamId = installation?.team?.id ?? installation?.enterprise?.id
  if (!teamId) throw new Error('Slack installation missing team/enterprise id')

  const { data, error } = await supabase
    .from('slack_installations')
    .upsert({
      team_id: teamId,
      enterprise_id: installation?.enterprise?.id ?? null,
      bot_user_id: installation?.bot?.userId ?? null,
      installed_by: installation?.user?.id ?? null,
      installation,
      updated_at: new Date().toISOString()
    }, { onConflict: 'team_id' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function fetchInstallation(query) {
  const teamId = query?.teamId ?? query?.enterpriseId
  if (!teamId) throw new Error('Slack installation lookup missing team id')

  const { data, error } = await supabase
    .from('slack_installations')
    .select('installation')
    .eq('team_id', teamId)
    .maybeSingle()
  if (error) throw error
  if (!data?.installation) throw new Error(`No Slack installation for ${teamId}`)
  return data.installation
}

export async function deleteInstallation(query) {
  const teamId = query?.teamId ?? query?.enterpriseId
  if (!teamId) return

  const { error } = await supabase
    .from('slack_installations')
    .delete()
    .eq('team_id', teamId)
  if (error) throw error
}

export async function logQuestion({ messageTs, channelId, questionText, askerId, keywords = [], routeAfterMs = 300000 }) {
  const embedding = await maybeEmbedding(`${questionText}\n${normalizeKeywords(keywords).join(' ')}`)
  const { data, error } = await supabase
    .from('questions')
    .upsert({
      message_ts: messageTs,
      channel_id: channelId,
      question_text: questionText,
      asker_id: askerId,
      keywords,
      embedding,
      status: 'waiting',
      answered: false,
      route_after: isoFromDelay(routeAfterMs),
      last_checked_at: new Date().toISOString()
    }, { onConflict: 'message_ts' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getQuestionByMessageTs(messageTs) {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('message_ts', messageTs)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function markQuestionAnswered(messageTs, answerText, expertId) {
  const question = await getQuestionByMessageTs(messageTs)
  const embedding = await maybeEmbedding(`${question?.question_text ?? ''}\n${answerText}`)

  const { error } = await supabase
    .from('questions')
    .update({
      answered: true,
      status: 'answered',
      answer_text: answerText,
      answer_embedding: embedding,
      expert_id: expertId,
      resolved_at: new Date().toISOString()
    })
    .eq('message_ts', messageTs)
  if (error) throw error

  if (question?.keywords && expertId) {
    await recordExpertAnswer(expertId, question.keywords)
  }
}

export async function getQuestionsReadyForRouting(limit = 25) {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .in('status', ['waiting'])
    .eq('answered', false)
    .lte('route_after', new Date().toISOString())
    .order('route_after', { ascending: true })
    .limit(limit)
  if (error) throw error
  return data ?? []
}

export async function markQuestionRouted(messageTs, expertId) {
  const { error } = await supabase
    .from('questions')
    .update({
      status: expertId ? 'routed' : 'waiting',
      expert_id: expertId ?? null,
      routed_at: expertId ? new Date().toISOString() : null,
      last_checked_at: new Date().toISOString(),
      route_after: expertId ? null : new Date(Date.now() + 30 * 60 * 1000).toISOString()
    })
    .eq('message_ts', messageTs)
    .eq('answered', false)
  if (error) throw error
}

export async function snoozeQuestion(messageTs, delayMs = 30 * 60 * 1000) {
  const { error } = await supabase
    .from('questions')
    .update({
      status: 'waiting',
      route_after: isoFromDelay(delayMs),
      last_checked_at: new Date().toISOString()
    })
    .eq('message_ts', messageTs)
    .eq('answered', false)
  if (error) throw error
}

export async function expireQuestion(messageTs) {
  const { error } = await supabase
    .from('questions')
    .update({ status: 'expired', last_checked_at: new Date().toISOString() })
    .eq('message_ts', messageTs)
    .eq('answered', false)
  if (error) throw error
}

export async function getUserOpenQuestions(userId) {
  const { data, error } = await supabase
    .from('questions')
    .select('*')
    .eq('asker_id', userId)
    .in('status', ['waiting', 'routed'])
    .eq('answered', false)
    .order('created_at', { ascending: false })
  if (error) return []
  return data ?? []
}

export async function setChannelEnabled(channelId, enabled, configuredBy) {
  const { data, error } = await supabase
    .from('channel_settings')
    .upsert({
      channel_id: channelId,
      enabled,
      configured_by: configuredBy,
      updated_at: new Date().toISOString()
    }, { onConflict: 'channel_id' })
    .select()
    .single()
  if (error) throw error
  return data
}

export async function getChannelSettings(channelId) {
  const { data, error } = await supabase
    .from('channel_settings')
    .select('*')
    .eq('channel_id', channelId)
    .maybeSingle()
  if (error) throw error
  return data
}

export async function isChannelEnabled(channelId, defaultEnabled = true) {
  const settings = await getChannelSettings(channelId)
  return settings ? settings.enabled : defaultEnabled
}

export async function recordFeedback({ messageTs, channelId, userId, rating, reason = null }) {
  const { data, error } = await supabase
    .from('feedback')
    .upsert({
      message_ts: messageTs,
      channel_id: channelId,
      user_id: userId,
      rating,
      reason
    }, { onConflict: 'message_ts,user_id,rating' })
    .select()
    .single()
  if (error) throw error

  const question = await getQuestionByMessageTs(messageTs)
  if (question?.expert_id && question?.keywords) {
    await recordExpertFeedback(question.expert_id, question.keywords, rating)
  }
  return data
}

export async function recordExpertAnswer(userId, keywords = []) {
  const normalized = normalizeKeywords(keywords)
  for (const keyword of normalized) {
    const { data: existing } = await supabase
      .from('expert_scores')
      .select('*')
      .eq('user_id', userId)
      .eq('keyword', keyword)
      .maybeSingle()

    const next = {
      user_id: userId,
      keyword,
      score: Number(existing?.score ?? 0) + 1,
      answers_count: Number(existing?.answers_count ?? 0) + 1,
      positive_feedback_count: Number(existing?.positive_feedback_count ?? 0),
      negative_feedback_count: Number(existing?.negative_feedback_count ?? 0),
      updated_at: new Date().toISOString()
    }

    await supabase.from('expert_scores').upsert(next, { onConflict: 'user_id,keyword' })
  }
}

export async function recordExpertFeedback(userId, keywords = [], rating) {
  const normalized = normalizeKeywords(keywords)
  const delta = rating === 'good' ? 2 : -2
  for (const keyword of normalized) {
    const { data: existing } = await supabase
      .from('expert_scores')
      .select('*')
      .eq('user_id', userId)
      .eq('keyword', keyword)
      .maybeSingle()

    const next = {
      user_id: userId,
      keyword,
      score: Number(existing?.score ?? 0) + delta,
      answers_count: Number(existing?.answers_count ?? 0),
      positive_feedback_count: Number(existing?.positive_feedback_count ?? 0) + (rating === 'good' ? 1 : 0),
      negative_feedback_count: Number(existing?.negative_feedback_count ?? 0) + (rating === 'bad' ? 1 : 0),
      updated_at: new Date().toISOString()
    }

    await supabase.from('expert_scores').upsert(next, { onConflict: 'user_id,keyword' })
  }
}

export async function getExpertScoresForKeywords(keywords = []) {
  const normalized = normalizeKeywords(keywords)
  if (normalized.length === 0) return []

  const { data, error } = await supabase
    .from('expert_scores')
    .select('*')
    .in('keyword', normalized)
    .order('score', { ascending: false })
    .limit(50)
  if (error) return []
  return data ?? []
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
    }, { onConflict: 'message_ts' })
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
    .eq('reminder_sent', false)
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
  const terms = normalizeTerms(query)
  if (terms.length === 0) return []

  const queryEmbedding = await maybeEmbedding(query)
  if (queryEmbedding) {
    const { data } = await supabase
      .from('questions')
      .select('question_text, answer_text, expert_id, created_at, channel_id, message_ts, answer_embedding, embedding')
      .eq('answered', true)
      .limit(75)

    const semantic = (data ?? [])
      .map(row => ({ ...row, relevance: Math.max(cosineSimilarity(queryEmbedding, row.answer_embedding), cosineSimilarity(queryEmbedding, row.embedding)) }))
      .filter(row => row.relevance > 0.68)
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, 5)

    if (semantic.length > 0) return semantic
  }

  const ilikeClauses = terms.flatMap(term => {
    const safe = escapeIlike(term)
    return [`question_text.ilike.%${safe}%`, `answer_text.ilike.%${safe}%`]
  })

  const { data, error } = await supabase
    .from('questions')
    .select('question_text, answer_text, expert_id, created_at, channel_id, message_ts')
    .eq('answered', true)
    .or(ilikeClauses.join(','))
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
    .order('deadline', { ascending: true, nullsFirst: false })
  if (error) return []
  return data ?? []
}

export async function deleteUserData(userId) {
  const [questions, commitments, feedback] = await Promise.all([
    supabase.from('questions').delete().or(`asker_id.eq.${userId},expert_id.eq.${userId}`),
    supabase.from('commitments').delete().or(`maker_id.eq.${userId},promised_to_id.eq.${userId}`),
    supabase.from('feedback').delete().eq('user_id', userId)
  ])

  for (const result of [questions, commitments, feedback]) {
    if (result.error) throw result.error
  }
  return { deleted: true, userId }
}

export async function purgeOldData(days = Number(process.env.DATA_RETENTION_DAYS ?? 90)) {
  const cutoff = cutoffIso(days)
  const targets = [
    supabase.from('questions').delete().lt('created_at', cutoff),
    supabase.from('commitments').delete().lt('created_at', cutoff).eq('completed', true),
    supabase.from('feedback').delete().lt('created_at', cutoff)
  ]

  const results = await Promise.all(targets)
  for (const result of results) {
    if (result.error) throw result.error
  }
  return { purgedBefore: cutoff, days }
}
