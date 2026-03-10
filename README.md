# Agent Orchestra

A local web-based terminal multiplexer for AI coding agents.
Spawn, monitor, and terminate **Claude Code** and **OpenAI Codex** instances from a single browser tab.

```
┌──────────────────────────────────────────────────────────────┐
│  🎼 Agent Orchestra                              2 agents    │
├─────────────────────┬────────────────────────────────────────┤
│  Context Compiler   │  Claude Code (abc12345)  ● running     │
│  ─────────────────  │  ┌──────────────────────────────────┐  │
│  Director Task      │  │ $ claude --dangerously-skip-...  │  │
│  [textarea]         │  │ > Analysing schema…              │  │
│                     │  └──────────────────────────────────┘  │
│  Project Files      ├────────────────────────────────────────┤
│  + Add Files        │  OpenAI Codex (ff889012)  ● running    │
│  > schema.sql 4 KB  │  ┌──────────────────────────────────┐  │
│                     │  │ $ codex -yolo                    │  │
│  Agent Instructions │  │ > Writing tests…                 │  │
│  [textarea]         │  └──────────────────────────────────┘  │
│                     │                                        │
│  Engine: [Claude ▼] │                                        │
│  🚀 Launch Agent    │                                        │
└─────────────────────┴────────────────────────────────────────┘
```

## Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 18 |
| `claude` CLI | installed & on PATH |
| `codex` CLI  | installed & on PATH *(optional)* |

`node-pty` requires native compilation. Ensure your system has standard build tools:

- **macOS** – Xcode Command Line Tools: `xcode-select --install`
- **Linux** – `build-essential` (Debian/Ubuntu) or equivalent
- **Windows** – run from a PowerShell/cmd with Visual Studio Build Tools

---

## Quick Start

### 1 – Install dependencies

```bash
# From the repo root
cd backend  && npm install
cd ../frontend && npm install
```

### 2 – Start the backend

The backend must be launched from **the directory you want agents to operate in**
(their `cwd` will be `process.cwd()` of the backend process).

```bash
# Example: work on a project at ~/my-project
cd ~/my-project
node /path/to/agent-orchestra/backend/server.js
```

Or use the npm script:

```bash
cd /path/to/agent-orchestra/backend
npm start
# Backend runs on http://127.0.0.1:3001
```

### 3 – Start the frontend (development)

```bash
cd /path/to/agent-orchestra/frontend
npm run dev
# Open http://localhost:5173
```

### 4 – Or build and serve from the backend

```bash
cd /path/to/agent-orchestra/frontend
npm run build
# The backend will serve ./frontend/dist automatically
# Open http://127.0.0.1:3001
```

---

## One-liner startup script

Save as `start.sh` next to this README and `chmod +x start.sh`:

```bash
#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TARGET_DIR="${1:-$(pwd)}"

echo "Agent Orchestra"
echo "Backend CWD → $TARGET_DIR"
echo "Frontend    → http://localhost:5173"
echo ""

# Build frontend once if dist is missing
if [ ! -d "$SCRIPT_DIR/frontend/dist" ]; then
  echo "Building frontend…"
  (cd "$SCRIPT_DIR/frontend" && npm run build)
fi

# Start backend from target directory
cd "$TARGET_DIR"
node "$SCRIPT_DIR/backend/server.js"
```

Usage: `./start.sh ~/my-project`

---

## How context is passed to agents

When you click **Launch Agent**, the backend:

1. Concatenates your Director Task, file contents, and Agent Instructions into a
   Markdown document.
2. Writes it to a temp file at `/tmp/agent-<uuid>-context.md`.
3. Spawns the CLI tool via `node-pty` in a true pseudo-terminal.
4. After **1.5 s** (giving the CLI time to reach its interactive prompt), sends
   the compiled context as the first user message.

You can then type freely in the terminal pane as if it were your local shell.

---

## WebSocket event reference

| Direction | Type | Payload |
|-----------|------|---------|
| C → S | `spawn`       | `{ engine, directorTask, files, agentInstructions }` |
| C → S | `input`       | `{ agentId, data }` |
| C → S | `kill`        | `{ agentId }` |
| C → S | `resize`      | `{ agentId, cols, rows }` |
| S → C | `agent_created` | `{ agentId, engine }` |
| S → C | `output`      | `{ agentId, data }` |
| S → C | `agent_exited` | `{ agentId, code, signal }` |
| S → C | `error`       | `{ agentId, message }` |

---

## Project structure

```
agent-orchestra/
├── backend/
│   ├── package.json
│   └── server.js        ← Express + ws + node-pty broker
└── frontend/
    ├── package.json
    ├── vite.config.js   ← proxies /ws to backend in dev
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx              ← WS connection, agent registry
        ├── app.css
        └── components/
            ├── ContextPanel.jsx ← Director Task, file picker, instructions
            ├── AgentGrid.jsx    ← Responsive terminal grid
            └── AgentTerminal.jsx ← xterm.js pane with stop/dismiss
```

---

## Flags used

| Engine | Flag | Effect |
|--------|------|--------|
| Claude Code | `--dangerously-skip-permissions` | Bypasses all permission prompts |
| OpenAI Codex | `-yolo` | Auto-approves all code execution |

These flags are intentional for this local, sandboxed workflow.
Do **not** run this server exposed to a network you do not trust.
