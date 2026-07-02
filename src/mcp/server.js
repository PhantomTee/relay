import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  logQuestion,
  getQuestionByMessageTs,
  markQuestionAnswered,
  markQuestionRouted,
  snoozeQuestion,
  getQuestionsReadyForRouting,
  getUserOpenQuestions,
  setChannelEnabled,
  getChannelSettings,
  recordFeedback,
  getExpertScoresForKeywords,
  logCommitment,
  markCommitmentDone,
  getPendingCommitments,
  getUserCommitments,
  searchKnowledgeBase,
  deleteUserData,
  purgeOldData
} from '../db.js'

const server = new McpServer({ name: 'relay-mcp', version: '1.0.0' })

function text(data) {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] }
}

server.tool('log_question', 'Log a detected unanswered question to the knowledge base', {
  messageTs: z.string(),
  channelId: z.string(),
  questionText: z.string(),
  askerId: z.string(),
  keywords: z.array(z.string()).optional(),
  routeAfterMs: z.number().optional()
}, async (args) => text(await logQuestion(args)))

server.tool('get_question', 'Get a tracked question by Slack message timestamp', {
  messageTs: z.string()
}, async ({ messageTs }) => text(await getQuestionByMessageTs(messageTs)))

server.tool('log_answer', 'Record that a question has been answered', {
  messageTs: z.string(),
  answerText: z.string(),
  expertId: z.string()
}, async ({ messageTs, answerText, expertId }) => {
  await markQuestionAnswered(messageTs, answerText, expertId)
  return text('ok')
})

server.tool('mark_question_routed', 'Record that a question was routed to an expert', {
  messageTs: z.string(),
  expertId: z.string().nullable()
}, async ({ messageTs, expertId }) => {
  await markQuestionRouted(messageTs, expertId)
  return text('ok')
})

server.tool('snooze_question', 'Delay routing for an unanswered question', {
  messageTs: z.string(),
  delayMs: z.number().optional()
}, async ({ messageTs, delayMs }) => {
  await snoozeQuestion(messageTs, delayMs)
  return text('ok')
})

server.tool('get_questions_ready_for_routing', 'Get unanswered questions whose route_after time has passed', {
  limit: z.number().optional()
}, async ({ limit }) => text(await getQuestionsReadyForRouting(limit ?? 25)))

server.tool('get_user_open_questions', 'Get open unanswered questions for a user', {
  userId: z.string()
}, async ({ userId }) => text(await getUserOpenQuestions(userId)))

server.tool('set_channel_enabled', 'Enable or disable RELAY in a Slack channel', {
  channelId: z.string(),
  enabled: z.boolean(),
  configuredBy: z.string()
}, async ({ channelId, enabled, configuredBy }) => text(await setChannelEnabled(channelId, enabled, configuredBy)))

server.tool('get_channel_settings', 'Get RELAY privacy/enablement settings for a channel', {
  channelId: z.string()
}, async ({ channelId }) => text(await getChannelSettings(channelId)))

server.tool('record_feedback', 'Record answer quality feedback from a Slack user', {
  messageTs: z.string(),
  channelId: z.string(),
  userId: z.string(),
  rating: z.enum(['good', 'bad']),
  reason: z.string().nullable().optional()
}, async (args) => text(await recordFeedback(args)))

server.tool('get_expert_scores', 'Get durable expert scores for routing keywords', {
  keywords: z.array(z.string())
}, async ({ keywords }) => text(await getExpertScoresForKeywords(keywords)))

server.tool('log_commitment', 'Log a commitment made in Slack', {
  messageTs: z.string(),
  channelId: z.string(),
  makerId: z.string(),
  description: z.string(),
  deadline: z.string().nullable(),
  promisedToId: z.string().nullable()
}, async (args) => text(await logCommitment(args)))

server.tool('mark_commitment_done', 'Mark a commitment as completed', {
  id: z.string()
}, async ({ id }) => {
  await markCommitmentDone(id)
  return text('ok')
})

server.tool('get_pending_commitments', 'Get all commitments with deadlines in the next 24 hours', {}, async () => text(await getPendingCommitments()))

server.tool('get_user_commitments', 'Get all open commitments for a specific user', {
  userId: z.string()
}, async ({ userId }) => text(await getUserCommitments(userId)))

server.tool('search_knowledge_base', 'Search past answered questions for relevant context', {
  query: z.string()
}, async ({ query }) => text(await searchKnowledgeBase(query)))

server.tool('delete_user_data', 'Delete a user from questions, commitments, and feedback', {
  userId: z.string()
}, async ({ userId }) => text(await deleteUserData(userId)))

server.tool('purge_old_data', 'Purge old completed or historical RELAY data by retention age', {
  days: z.number().optional()
}, async ({ days }) => text(await purgeOldData(days)))

const transport = new StdioServerTransport()
await server.connect(transport)
