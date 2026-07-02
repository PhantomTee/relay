import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

function test(name, fn) {
  try {
    fn()
    console.log(`ok - ${name}`)
  } catch (error) {
    console.error(`not ok - ${name}`)
    throw error
  }
}

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/app.js', import.meta.url), 'utf8')
const mcp = readFileSync(new URL('../src/mcp/server.js', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8').replace(/^\\uFEFF/, ''))

test('schema includes durable lifecycle, privacy, OAuth, and scoring tables', () => {
  for (const table of ['questions', 'commitments', 'channel_settings', 'feedback', 'expert_scores', 'slack_installations']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`))
  }
  assert.match(schema, /answer_embedding JSONB/)
  assert.match(schema, /route_after TIMESTAMPTZ/)
})

test('Slack manifest exposes commands and Assistant events', () => {
  const commands = manifest.features.slash_commands.map(command => command.command)
  for (const command of ['/relay-status', '/relay-ask', '/relay-done', '/relay-enable', '/relay-disable', '/relay-delete-mine', '/relay-purge']) {
    assert.equal(commands.includes(command), true)
  }

  assert.equal(manifest.oauth_config.scopes.bot.includes('assistant:write'), true)
  assert.equal(manifest.settings.event_subscriptions.bot_events.includes('assistant_thread_started'), true)
  assert.equal(manifest.settings.event_subscriptions.bot_events.includes('assistant_thread_context_changed'), true)
})

test('app registers Slack-native controls and privacy commands', () => {
  for (const marker of ['new Assistant', "app.assistant", "app.command('/relay-delete-mine'", "app.command('/relay-purge'", "app.action('relay_route_now'", "app.action('relay_snooze'", "relay_feedback_good"]) {
    assert.equal(app.includes(marker), true)
  }
})

test('MCP exposes lifecycle and admin tools', () => {
  for (const tool of ['get_expert_scores', 'delete_user_data', 'purge_old_data', 'record_feedback', 'search_knowledge_base']) {
    assert.equal(mcp.includes(`'${tool}'`), true)
  }
})

