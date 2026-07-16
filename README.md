# ⚡ agentcore-pulse

> Real-time observability dashboard for Amazon Bedrock AgentCore

Watch your AgentCore runtimes execute in real time. Auto-discovers deployed agents, streams CloudWatch logs via LiveTail, polls DynamoDB for task state, and serves a live browser dashboard with execution timelines, task state, error tracking, and inter-agent communication visualization.

## Quick Start

```bash
# Install
npm install -g agentcore-pulse
# — or run locally —
git clone <repo> && cd agentcore-pulse && npm install

# Initialize config (optional — run inside an AgentCore project)
agentcore-pulse init

# Start the dashboard
agentcore-pulse
```

The dashboard opens at `http://localhost:3141` and auto-discovers runtimes from your `agentcore/agentcore.json`.

## How It Works

1. **Auto-Discovery** — Reads `agentcore/agentcore.json` and `agentcore/.cli/deployed-state.json` from the current working directory to find deployed runtimes and derive CloudWatch log group names.
2. **CloudWatch LiveTail** — Streams real-time logs from all discovered runtime log groups. Parses log events into structured categories (phases, invocations, errors, supervisor tool calls).
3. **DynamoDB Polling** — Queries your task ledger table every 3 seconds for active tasks and queue state.
4. **WebSocket Broadcasting** — Pushes all events to connected browser clients via WebSocket at `/ws`.
5. **History** — Queries completed/failed tasks from DynamoDB, or accumulates session events as fallback.

## CLI Reference

```
agentcore-pulse [options]
agentcore-pulse init
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--mode <mode>` | Streaming mode: `live` (all logs) or `phase` (structured events only) | `live` |
| `--port <number>` | Dashboard HTTP port | `3141` |
| `--profile <name>` | AWS CLI profile name for credentials | (default profile) |
| `--project <id>` | Filter to a specific project | (auto-detected) |
| `--runtime <name>` | Filter to a specific runtime (by name) | (all runtimes) |
| `--no-pipelines` | Disable the pipelines panel | enabled |
| `--no-kiro` | Disable the kiro/logs panel | enabled |
| `--no-timeline` | Disable the timeline panel | enabled |
| `--no-tasks` | Disable the tasks panel | enabled |
| `--no-supervisor` | Disable the supervisor panel | enabled |
| `--no-errors` | Disable the errors panel | enabled |
| `--no-history` | Disable the history panel | enabled |
| `--verbose` | Log broadcast events, AWS calls, and poll results to terminal | off |

### `agentcore-pulse init`

Creates a `dashboard/` folder in the current directory with:

- `.env` — Configure AWS profile, region, DynamoDB table name, and port
- `.patterns.json` — Customize log parsing patterns
- `.gitignore` — Excludes `.env` from version control

## Panels

| Panel | Data Source | Description |
|-------|-------------|-------------|
| **Pipelines** | CloudWatch + DynamoDB | Active pipeline executions with phase progress |
| **Kiro** | CloudWatch | Raw Kiro harness log stream |
| **Timeline** | CloudWatch | Visual timeline of execution phases |
| **Tasks** | DynamoDB | Active task states (PENDING → IN_PROGRESS → PR_CREATED → MERGED) |
| **Supervisor** | CloudWatch | Supervisor agent tool calls and orchestration events |
| **Errors** | CloudWatch | Errors and warnings across all runtimes |
| **History** | DynamoDB / Session | Completed and failed tasks from past executions |

## Auto-Discovery

agentcore-pulse reads two files from the current working directory:

1. **`agentcore/agentcore.json`** — Discovers runtime names and build types
2. **`agentcore/.cli/deployed-state.json`** — Maps runtime names to deployed IDs and derives CloudWatch log group paths

Log groups follow the AgentCore convention:
```
/aws/bedrock-agentcore/runtimes/{runtimeId}-DEFAULT
```

If no `agentcore/` directory exists, the dashboard starts in empty state with a warning.

## Custom Patterns

Edit `dashboard/.patterns.json` to customize how log messages are categorized:

```json
{
  "phases": ["Phase started: (.+)", "Phase completed: (.+)", "Pipeline completed"],
  "invocations": ["invokeViaGateway", "invoke_kiro", "invoke-agent-runtime"],
  "errors": ["ERROR", "\\bError\\b", "\\bfailed\\b", "Exception", "FATAL"],
  "supervisor": ["tool_call", "getProjectConfig", "invokeKiroHarness"]
}
```

Each category is an array of regex patterns (case-insensitive). Messages are tested against categories in order: errors → phases → invocations → supervisor. First match wins. Unmatched messages are categorized as `log`.

## Environment Variables

Set these in `dashboard/.env` or as environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `ACPULSE_AWS_PROFILE` | AWS CLI profile for credentials | (default) |
| `ACPULSE_AWS_REGION` | AWS region | `us-east-1` |
| `ACPULSE_TABLE_NAME` | DynamoDB table name (enables tasks/pipelines) | (none) |
| `ACPULSE_PORT` | Dashboard port | `3141` |

CLI flags take precedence over environment variables.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Dashboard HTML |
| `/api/config` | GET | Runtime discovery + panel configuration |
| `/api/history` | GET | Paginated history records (`?limit=20&offset=0`) |
| `/ws` | WebSocket | Real-time event stream |

### WebSocket Message Format

```json
{
  "type": "phase|error|invoke|supervisor|log|tasks|pipelines|history|cost|config",
  "data": { ... },
  "ts": 1720000000000
}
```

## Cost

agentcore-pulse uses **CloudWatch LiveTail** for real-time log streaming.

| Tier | Rate |
|------|------|
| First 1,800 minutes/month | **Free** |
| Additional minutes | **$0.01/minute** per log group |

The dashboard displays a cost indicator showing session minutes elapsed. DynamoDB reads use on-demand capacity (negligible cost for polling every 3s).

## Requirements

- **Node.js** ≥ 22
- **AWS credentials** with:
  - `logs:StartLiveTail` permission on runtime log groups
  - `dynamodb:Query`, `dynamodb:GetItem` on the task ledger table (if using tasks/history panels)
- **An AgentCore project** with deployed runtimes (for full functionality)

## Architecture

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Browser    │◄────│   Express + WS   │────►│  Orchestrator   │
│  Dashboard   │ ws  │   (server.js)    │     │                 │
└──────────────┘     └──────────────────┘     └────────┬────────┘
                                                       │
                        ┌──────────────────────────────┼──────────────────┐
                        │                              │                  │
                        ▼                              ▼                  ▼
              ┌──────────────────┐          ┌──────────────┐    ┌──────────────┐
              │ CloudWatch       │          │  DynamoDB    │    │   History    │
              │ LiveTail         │          │  Poller      │    │  Collector   │
              │ (log streaming)  │          │  (3s poll)   │    │  (60s poll)  │
              └──────────────────┘          └──────────────┘    └──────────────┘
```

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| "No runtimes discovered" | No `agentcore/` directory | Run from inside an AgentCore project |
| "AWS credentials expired" | Session token expired | Run `aws sso login --profile <profile>` |
| Dashboard shows empty panels | Runtimes not deployed | Run `agentcore deploy` first |
| "Log group not found" | Runtime exists in config but not deployed | Deploy the runtime or use `--runtime` to filter |
| No tasks showing | `ACPULSE_TABLE_NAME` not set | Run `agentcore-pulse init` and configure `.env` |

## License

MIT
