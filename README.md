# RELAY

Real-time Expert Linking and AccountabilitY for Slack teams.

RELAY is an AI accountability layer for Slack. It watches team conversations, detects unanswered work questions, routes them to the right teammate, remembers useful answers, and tracks commitments before they disappear in chat.

## Why it matters

Teams already ask for help and make promises in Slack, but the important bits are easy to lose:

- questions go unanswered
- the same question gets asked again next week
- commitments are buried in threads
- experts get found by luck, not by evidence

RELAY turns those moments into a lightweight team memory and accountability graph.

## What it does today

- Detects real work questions with a structured LLM classifier.
- Redacts common secrets, tokens, passwords, and emails before classifier calls and logs.
- Searches answered questions before interrupting a teammate, with optional embedding search and lexical fallback.
- Tracks unanswered questions durably in Supabase.
- Routes stale unanswered questions to likely experts using Slack history plus durable expert scores.
- Updates expert scores when answers are captured and when teammates give helpful/not-helpful feedback.
- Records useful thread replies as answers for future reuse.
- Detects commitments and reminds makers before deadlines.
- Provides a Slack Assistant thread surface and App Home dashboard for open commitments and questions.
- Adds Block Kit controls for route now, snooze, mark resolved, and answer feedback.
- Supports channel opt-in/privacy controls with `/relay-enable` and `/relay-disable`.
- Supports user data deletion with `/relay-delete-mine` and retention cleanup with `/relay-purge`.
- Can run as a single-workspace bot token app or a Slack OAuth multi-workspace app with installations stored in Supabase.
- Exposes internal tools through MCP so the data layer can be reused by agents.

## Demo script

1. Run `/relay-enable` in a demo channel if `RELAY_REQUIRE_CHANNEL_OPT_IN=true`.
2. Ask a real work question, e.g. `Does anyone know how the deploy worker handles retries?`
3. RELAY reacts, tracks the question, and posts route/snooze/resolve buttons.
4. Click `Route now`, or wait for `QUESTION_TIMEOUT_MS`; RELAY searches Slack history and DMs the best expert.
5. The expert replies in the thread.
6. RELAY marks the question answered, stores the answer, updates that expert's score, and asks for helpful/not-helpful feedback.
7. Ask a similar question later; RELAY surfaces the previous answer instead of bothering someone.
8. Say `I'll send the migration notes tomorrow`; RELAY logs the commitment and reminds you.
9. Open RELAY's App Home or run `/relay-status` to see your open commitments and questions.
10. Run `/relay-delete-mine` to prove user-level data deletion, or `/relay-purge 90` to enforce retention cleanup.

## Architecture

```text
Slack Events + Slash Commands + Assistant Threads + App Home + Block Kit Actions + OAuth Install
        |
        v
Bolt app (src/app.js)
        |
        +--> Groq classifier (src/classifier.js)
        +--> Optional embedding endpoint (src/embeddings.js)
        +--> Expert finder over Slack history + expert_scores (src/expertFinder.js)
        +--> Durable question/commitment workers (src/reminders.js)
        |
        v
MCP adapter (src/mcp/*)
        |
        v
Supabase tables: questions, commitments, channel_settings, feedback, expert_scores, slack_installations
```

## Setup

### 1. Install dependencies

```bash
npm ci
```

### 2. Create Supabase tables

Run `schema.sql` in the Supabase SQL editor.

The included `migrate.js` attempts to run the schema, but Supabase projects often do not expose a generic `exec_sql` RPC. Manual SQL execution is the most reliable path for the hackathon demo.

### 3. Configure environment

```bash
cp .env.example .env
```

Fill in:

- `SLACK_BOT_TOKEN` for a single-workspace demo, or OAuth values for multi-workspace install mode.
- `SLACK_SIGNING_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GROQ_API_KEY`

Set `RELAY_REQUIRE_CHANNEL_OPT_IN=true` for privacy-first demos where every channel must explicitly run `/relay-enable`.

For semantic search, set `EMBEDDING_API_URL`, `EMBEDDING_API_KEY`, and `EMBEDDING_MODEL`. If those are missing, RELAY uses lexical search and still works.

### 4. Create the Slack app

Use `manifest.json` as the Slack app manifest. Configure request URLs for events, interactivity, slash commands, and OAuth redirects to point at your deployed Bolt endpoint.

Required bot scopes are listed in the manifest. For a minimal demo workspace, make sure the bot is invited into the channels you want RELAY to observe.

### 5. Run locally

```bash
npm run dev
```

For Slack to reach a local server, expose port `3001` with a tunnel such as ngrok and set the Slack request URLs to the HTTPS tunnel URL.

## Slash commands

| Command | Purpose |
|---|---|
| `/relay-status` | Show your open commitments and unanswered questions, and refresh App Home. |
| `/relay-ask <question>` | Ask and route a question immediately. |
| `/relay-done <id>` | Mark a commitment complete by ID prefix. |
| `/relay-enable` | Enable RELAY in the current channel. |
| `/relay-disable` | Disable RELAY in the current channel. |
| `/relay-delete-mine` | Delete your RELAY questions, answers, commitments, and feedback. |
| `/relay-purge <days>` | Purge old historical data beyond a retention window; requires Slack admin/owner. |

## Environment variables

| Name | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | Bot token for single-workspace mode. |
| `SLACK_SIGNING_SECRET` | Verifies Slack requests. |
| `SLACK_CLIENT_ID` | Enables Slack OAuth mode when set with client secret/state secret. |
| `SLACK_CLIENT_SECRET` | Slack OAuth client secret. |
| `SLACK_STATE_SECRET` | Long random secret for OAuth state. |
| `SLACK_SCOPES` | Comma-separated OAuth scopes; defaults match `manifest.json`. |
| `PORT` | HTTP port, default `3001`. |
| `SUPABASE_URL` | Supabase project URL. |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-side key for RELAY tables. |
| `GROQ_API_KEY` | LLM classifier key. |
| `GROQ_MODEL` | Optional classifier model override. |
| `EMBEDDING_API_URL` | Optional OpenAI-compatible embedding endpoint. |
| `EMBEDDING_API_KEY` | Optional embedding API key. |
| `EMBEDDING_MODEL` | Optional embedding model. |
| `QUESTION_TIMEOUT_MS` | Delay before routing unanswered questions. |
| `CONFIDENCE_THRESHOLD` | Minimum classifier confidence to act. |
| `DATA_RETENTION_DAYS` | Default retention age for `/relay-purge`. |
| `RELAY_REQUIRE_CHANNEL_OPT_IN` | If true, channels must opt in with `/relay-enable`. |

## Devpost judging highlights

- Native Slack workflow: RELAY works where questions and commitments already happen.
- Slack AI fit: it uses messages, App Home, Assistant events, interactivity, slash commands, OAuth install mode, and agent-like routing behavior.
- AI with bounded autonomy: it tracks, routes, reminds, and stores answers, but keeps humans in the loop.
- Durable state: unanswered questions survive process restarts.
- Team memory: answered questions become reusable knowledge through lexical or embedding search.
- Accountability: casual promises become visible commitments.
- Privacy posture: channel-level enable/disable, redaction, user deletion, and retention purge are built in.
- MCP-ready internals: RELAY's tools can be reused by other agents.

## Current limitations

RELAY is still a hackathon build. The highest-impact next upgrades are:

- Production-grade audit logs and workspace admin UI for deletion/export.
- More sophisticated expert ranking that uses team graph structure and per-channel permissions.
- True database-native vector indexing if the project grows beyond demo scale.

## Privacy note

RELAY sends redacted message text to the configured LLM provider for classification. For production, keep channel opt-in enabled, review the redaction patterns for your workspace, document data retention, and expose workspace admin controls for deletion/export.



