# pi-agenticoding

[![pi.dev package](https://img.shields.io/badge/pi.dev-package-purple)](https://pi.dev/packages/pi-agenticoding)
[![npm version](https://img.shields.io/badge/npm-0.4.0-blue)](https://www.npmjs.com/package/pi-agenticoding)
[![MIT License](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
![Status](https://img.shields.io/badge/status-active-brightgreen)

> Context tools for [Pi](https://pi.dev): `spawn`, `notebook`, and `handoff` — so the agent manages its own context instead of rotting in a long transcript.

## Why

Long coding sessions [degrade well before the token ceiling](https://agenticoding.ai/context-engineering). Auto-compact and manual `/compact` are lossy summarizer passes — you must fire them early, steer them well, and hope the compression step kept the right facts. The agent does not author that cut. 

**pi-agenticoding flips that.** It gives the LLM tools to isolate noisy work, keep task-scoped notes across deliberate cuts, and restart clean on purpose — with optional readonly when you want research without mutating the tree.

Keeping that context small is also cheaper: most coding spend is **input** tokens, and provider prefix caches only stay warm for a few minutes of idle time.

Deeper rationale: [docs/why.md](docs/why.md) · companion book: [agenticoding.ai](https://agenticoding.ai)

## Features

- **Spawn** — run research or implementation in a clean child context so the parent stays focused
- **Notebook** — task-scoped named pages for facts and decisions; survives handoff, dies with the conversation (`/new`) — no forever-memory rot
- **Handoff** — deliberate clean restart with a task brief when the job changes or context turns to noise
- **Topic** — same problem → prefer spawn; new problem → prefer handoff (human-set topics win)
- **Readonly** — explore and plan without writing the tree (`/readonly`, Ctrl+Shift+R, or `--readonly`); macOS/Linux can OS-sandbox bash, Windows is classifier-only
- **Visibility** — status bar shows context pressure, notebook count, topic, and readonly; warning at high usage

## Install

Requires the [Pi](https://pi.dev) coding agent.

```bash
pi install npm:pi-agenticoding
```

Disable pi's built-in compaction so **handoff** owns deliberate restarts:

```json
// ~/.pi/agent/settings.json
{
  "compaction": { "enabled": false }
}
```

**You should get:** tools `spawn`, `notebook_write`, `notebook_read`, `notebook_index`, `notebook_topic_set`, and `handoff`. The status bar can show context usage, notebook count, active topic, and readonly when enabled.

## How it works

```
You: "Add OAuth to the backend"

  notebook_topic_set("oauth")
  spawn("research OAuth best practices")
  spawn("audit current auth code")
         │
         ▼
  notebook_write("oauth-decisions", "Flow: PKCE. Scope: read+write.")
         │
         ├── spawn("implement token endpoint")
         └── spawn("write tests")
         │
         ▼
  handoff("Wire OAuth routes into the middleware stack.
           Notebook page 'oauth-decisions' holds the constraints.")
```

The agent set a topic, spawned research, saved decisions, delegated implementation, and handed off when context got noisy. **You said one sentence.**

## Primitives

| | |
|---|---|
| **Spawn** | Subtask in a clean child context. Parent orchestrates; siblings run in parallel. Children inherit active registered parent tools executable in the child session — MCP/extension tools such as ChunkHound — plus child-local notebook tools. Children cannot spawn grandchildren or handoff. |
| **Notebook** | Named pages coupled to this conversation/task. Carries grounding across handoff; cleared on `/new`. Not a long-lived memory store — lifetime matches the work, so it cannot go stale across unrelated sessions. |
| **Handoff** | Write a brief, compact, resume clean. Notebook holds reusable grounding for this task; the brief holds only remaining situational context. |
| **Readonly** | Blocks write/edit and guards bash while researching. Spawn inherits the posture. **macOS/Linux:** bash can run under OS sandbox (`sandbox-exec` / `bwrap`) — syscall-level write denial outside temp. **Windows:** no OS sandbox — **best-effort command classifier only** (interpreters and clever pipes can bypass). A coding guardrail on every OS — not a hardened security boundary. |

**Commands:** `/handoff` · `/notebook` · `/notebook <topic>` · `/readonly` · `Ctrl+Shift+R` · `--readonly`

## Comparison

| Approach | Who decides | Across cuts |
|---|---|---|
| Platform auto-compaction | Runtime (late threshold) | Blunt lossy summary |
| `/compact` or `/clear` | User (timing + steer) | Lossy summarizer pass / paste |
| Forever “memory” stores | Background / RAG | Accumulates, goes stale, needs invalidation |
| **pi-agenticoding** | **Agent** | **Task-scoped notebook + handoff brief** |

## Learn more

- [Why agent-managed context](docs/why.md)
- [Architecture](docs/architecture.md)
- [Agentic Coding](https://agenticoding.ai) — companion methodology
- [Pi package page](https://pi.dev/packages/pi-agenticoding)

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the project workflow and quality expectations.

## License

MIT — see [LICENSE](LICENSE).
