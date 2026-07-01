import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mcpClient = null

export async function connectMCP() {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(__dirname, 'server.js')]
  })

  mcpClient = new Client({ name: 'relay-client', version: '1.0.0' }, { capabilities: {} })
  await mcpClient.connect(transport)
  console.log('MCP server connected')
  return mcpClient
}

export async function callTool(name, args = {}) {
  if (!mcpClient) throw new Error('MCP client not connected')
  const result = await mcpClient.callTool({ name, arguments: args })
  const text = result.content[0].text
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}
