import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import {
  logQuestion,
  markQuestionAnswered,
  logCommitment,
  markCommitmentDone,
  getPendingCommitments,
  getUserCommitments,
  searchKnowledgeBase
} from '../db.js'

const server = new McpServer({ name: 'relay-mcp', version: '1.0.0' })

server.tool(
  'log_question',
  'Log a detected unanswered question to the knowledge base',
  {
    messageTs: z.string(),
    channelId: z.string(),
    questionText: z.string(),
    askerId: z.string()
  },
  async (args) => {
    const data = await logQuestion(args)
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
)

server.tool(
  'log_answer',
  'Record that a question has been answered',
  {
    messageTs: z.string(),
    answerText: z.string(),
    expertId: z.string()
  },
  async ({ messageTs, answerText, expertId }) => {
    await markQuestionAnswered(messageTs, answerText, expertId)
    return { content: [{ type: 'text', text: 'ok' }] }
  }
)

server.tool(
  'log_commitment',
  'Log a commitment made in Slack',
  {
    messageTs: z.string(),
    channelId: z.string(),
    makerId: z.string(),
    description: z.string(),
    deadline: z.string().nullable(),
    promisedToId: z.string().nullable()
  },
  async (args) => {
    const data = await logCommitment(args)
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
)

server.tool(
  'mark_commitment_done',
  'Mark a commitment as completed',
  { id: z.string() },
  async ({ id }) => {
    await markCommitmentDone(id)
    return { content: [{ type: 'text', text: 'ok' }] }
  }
)

server.tool(
  'get_pending_commitments',
  'Get all commitments with deadlines in the next 24 hours',
  {},
  async () => {
    const data = await getPendingCommitments()
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
)

server.tool(
  'get_user_commitments',
  'Get all open commitments for a specific user',
  { userId: z.string() },
  async ({ userId }) => {
    const data = await getUserCommitments(userId)
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
)

server.tool(
  'search_knowledge_base',
  'Search past answered questions for relevant context',
  { query: z.string() },
  async ({ query }) => {
    const data = await searchKnowledgeBase(query)
    return { content: [{ type: 'text', text: JSON.stringify(data) }] }
  }
)

const transport = new StdioServerTransport()
await server.connect(transport)
