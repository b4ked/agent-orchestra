/**
 * Agent Orchestra – Backend Server
 *
 * Responsibilities:
 *  - Serve the compiled frontend (production) or proxy in dev mode
 *  - Manage a registry of node-pty processes (one per spawned agent)
 *  - Broker bidirectional data between each pty and its xterm.js client
 *    over a single WebSocket connection
 *
 * WebSocket message schema (all messages are JSON strings):
 *
 *  Client → Server
 *    { type: 'spawn',  payload: { engine, directorTask, files, agentInstructions } }
 *    { type: 'input',  payload: { agentId, data } }
 *    { type: 'kill',   payload: { agentId } }
 *    { type: 'resize', payload: { agentId, cols, rows } }
 *
 *  Server → Client
 *    { type: 'agent_created', payload: { agentId, engine } }
 *    { type: 'output',        payload: { agentId, data } }
 *    { type: 'agent_exited',  payload: { agentId, code, signal } }
 *    { type: 'error',         payload: { agentId, message } }
 */

import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import * as pty from 'node-pty';
import { randomUUID } from 'crypto';
import { writeFile, unlink } from 'fs/promises';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Resolve absolute path for a CLI command so node-pty can find it regardless
// of how its internal PATH resolution differs from the shell's.
// ---------------------------------------------------------------------------
function resolveCmd(name) {
  try {
    const resolved = execFileSync('which', [name], {
      encoding: 'utf-8',
      env: process.env,
    }).trim();
    console.log(`[cmd] resolved "${name}" → ${resolved}`);
    return resolved;
  } catch {
    console.warn(`[cmd] "which ${name}" failed – falling back to bare name`);
    return name;
  }
}

// ---------------------------------------------------------------------------
// HTTP + WebSocket servers
// ---------------------------------------------------------------------------

const app = express();
const httpServer = createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// Serve compiled frontend from ../frontend/dist when it exists
app.use(express.static(join(__dirname, '..', 'frontend', 'dist')));

// Health-check endpoint so the user can confirm the backend is alive
app.get('/health', (_req, res) => res.json({ status: 'ok', agents: agents.size }));

// ---------------------------------------------------------------------------
// Agent registry
//   key   : agentId (UUID string)
//   value : { ptyProc, engine, ws, contextPath, killTimer }
// ---------------------------------------------------------------------------

const agents = new Map();

// ---------------------------------------------------------------------------
// WebSocket connection handler
// ---------------------------------------------------------------------------

wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[ws] client connected  ip=${clientIp}`);

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      sendToClient(ws, { type: 'error', payload: { agentId: null, message: 'Invalid JSON' } });
      return;
    }

    switch (msg.type) {
      case 'spawn':
        await handleSpawn(ws, msg.payload);
        break;
      case 'input':
        handleInput(msg.payload);
        break;
      case 'kill':
        handleKill(ws, msg.payload);
        break;
      case 'resize':
        handleResize(msg.payload);
        break;
      default:
        console.warn(`[ws] unknown message type: ${msg.type}`);
    }
  });

  ws.on('close', () => {
    console.log(`[ws] client disconnected  ip=${clientIp}`);
    // Terminate every agent that belongs to this connection
    for (const [agentId, agent] of agents.entries()) {
      if (agent.ws === ws) {
        terminateAgent(agentId);
      }
    }
  });

  ws.on('error', (err) => {
    console.error('[ws] socket error:', err.message);
  });
});

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Compile context, write temp file, spawn pty, wire output pipeline.
 */
async function handleSpawn(ws, payload) {
  const { engine = 'claude', directorTask = '', files = [], agentInstructions = '' } = payload;
  const agentId = randomUUID();

  // --- Build context document -------------------------------------------
  const lines = ['# AGENT CONTEXT\n'];

  if (directorTask.trim()) {
    lines.push('## Director Task\n');
    lines.push(directorTask.trim());
    lines.push('\n');
  }

  if (files.length > 0) {
    lines.push('## Loaded Files\n');
    for (const file of files) {
      const ext = file.name.split('.').pop() ?? '';
      lines.push(`### \`${file.name}\`\n`);
      lines.push(`\`\`\`${ext}\n${file.content}\n\`\`\`\n`);
    }
  }

  if (agentInstructions.trim()) {
    lines.push('## Agent-Specific Instructions\n');
    lines.push(agentInstructions.trim());
    lines.push('\n');
  }

  const contextContent = lines.join('\n');

  // Write to temp file (useful for debugging and for passing via --file flag)
  const contextPath = join(tmpdir(), `agent-${agentId}-context.md`);
  try {
    await writeFile(contextPath, contextContent, 'utf-8');
  } catch (err) {
    sendToClient(ws, {
      type: 'error',
      payload: { agentId, message: `Failed to write context file: ${err.message}` },
    });
    return;
  }

  // --- Build agent command string ----------------------------------------
  // We spawn the user's login shell, then type the agent command into it.
  // This is how real terminal emulators work and avoids node-pty's
  // posix_spawnp quirks with Node.js CLI wrappers and symlinks on macOS.
  const baseName = engine === 'claude' ? 'claude' : 'codex';
  const resolvedCmd = resolveCmd(baseName);
  const agentFlags = engine === 'claude' ? '--dangerously-skip-permissions' : '-yolo';
  const agentInvocation = `${resolvedCmd} ${agentFlags}`;

  // Use the user's $SHELL (login shell) so PATH and env are fully initialised
  const shell = process.env.SHELL || '/bin/zsh';
  const shellArgs = ['-l']; // login shell → sources .zprofile / .bash_profile

  // --- Spawn pty (shell) --------------------------------------------------
  let ptyProc;
  try {
    ptyProc = pty.spawn(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
    console.error(`[agent] shell spawn failed  id=${agentId}  shell=${shell}:`, err.message);
    sendToClient(ws, {
      type: 'error',
      payload: { agentId, message: `Failed to spawn shell "${shell}": ${err.message}` },
    });
    await safeUnlink(contextPath);
    return;
  }

  agents.set(agentId, { ptyProc, engine, ws, contextPath, killTimer: null });

  // Notify client the agent is alive
  sendToClient(ws, { type: 'agent_created', payload: { agentId, engine } });
  console.log(`[agent] spawned  id=${agentId}  engine=${engine}  shell=${shell}  pid=${ptyProc.pid}`);

  // --- Pipe pty output → client ------------------------------------------
  ptyProc.onData((data) => {
    sendToClient(ws, { type: 'output', payload: { agentId, data } });
  });

  ptyProc.onExit(({ exitCode, signal }) => {
    console.log(`[agent] exited  id=${agentId}  code=${exitCode}  signal=${signal}`);
    sendToClient(ws, { type: 'agent_exited', payload: { agentId, code: exitCode, signal } });
    cleanupAgent(agentId);
  });

  // --- Staged startup sequence -------------------------------------------
  // 1. Wait for shell prompt (~600 ms), then run the agent CLI.
  // 2. Wait for agent CLI to reach its interactive prompt (~2 s), then
  //    send the compiled context as the first user message.
  setTimeout(() => {
    const agent = agents.get(agentId);
    if (!agent) return;
    console.log(`[agent] launching CLI  id=${agentId}  cmd=${agentInvocation}`);
    try {
      agent.ptyProc.write(agentInvocation + '\r');
    } catch (err) {
      console.error(`[agent] failed to send CLI command  id=${agentId}:`, err.message);
      return;
    }

    // Send context once the CLI is interactive
    setTimeout(() => {
      const a = agents.get(agentId);
      if (!a) return;
      try {
        a.ptyProc.write(contextContent + '\r');
      } catch (err) {
        console.error(`[agent] failed to write context  id=${agentId}:`, err.message);
      }
    }, 2000);
  }, 600);
}

function handleInput({ agentId, data }) {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    agent.ptyProc.write(data);
  } catch (err) {
    console.error(`[agent] input write error  id=${agentId}:`, err.message);
  }
}

function handleKill(ws, { agentId }) {
  if (!agents.has(agentId)) {
    sendToClient(ws, {
      type: 'error',
      payload: { agentId, message: 'Agent not found' },
    });
    return;
  }
  terminateAgent(agentId);
}

function handleResize({ agentId, cols, rows }) {
  const agent = agents.get(agentId);
  if (!agent) return;
  try {
    agent.ptyProc.resize(
      Math.max(1, Math.floor(cols)),
      Math.max(1, Math.floor(rows))
    );
  } catch {
    // resize can race with process exit – silently ignore
  }
}

// ---------------------------------------------------------------------------
// Process lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Gracefully stop an agent:
 *  1. Send Ctrl-C  (SIGINT – lets the CLI clean up)
 *  2. After 800 ms, force-kill with SIGKILL if still alive
 */
function terminateAgent(agentId) {
  const agent = agents.get(agentId);
  if (!agent) return;

  console.log(`[agent] terminating  id=${agentId}`);

  // Cancel any previously scheduled kill timer
  if (agent.killTimer) clearTimeout(agent.killTimer);

  try {
    // Ctrl-C – graceful shutdown signal
    agent.ptyProc.write('\x03');
  } catch {
    // process may already be gone
  }

  // Schedule a hard SIGKILL in case Ctrl-C is ignored
  agent.killTimer = setTimeout(() => {
    try {
      agent.ptyProc.kill('SIGKILL');
    } catch {
      // already dead, fine
    }
    cleanupAgent(agentId);
  }, 800);
}

async function cleanupAgent(agentId) {
  const agent = agents.get(agentId);
  if (!agent) return;

  if (agent.killTimer) clearTimeout(agent.killTimer);
  agents.delete(agentId);

  await safeUnlink(agent.contextPath);
  console.log(`[agent] cleaned up  id=${agentId}`);
}

async function safeUnlink(filePath) {
  try {
    await unlink(filePath);
  } catch {
    // file may not exist or already deleted – ignore
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function sendToClient(ws, msg) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(msg));
  }
}

// ---------------------------------------------------------------------------
// Graceful server shutdown – terminate all agents to avoid orphan processes
// ---------------------------------------------------------------------------

function gracefulShutdown(signal) {
  console.log(`\n[server] received ${signal}, shutting down…`);
  for (const agentId of [...agents.keys()]) {
    terminateAgent(agentId);
  }
  // Give kill timers a chance to fire before exit
  setTimeout(() => process.exit(0), 1200);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const PORT = process.env.PORT ?? 3001;
httpServer.listen(PORT, '127.0.0.1', () => {
  console.log(`Agent Orchestra backend  →  http://127.0.0.1:${PORT}`);
  console.log(`Working directory        →  ${process.cwd()}`);
  console.log(`WebSocket endpoint       →  ws://127.0.0.1:${PORT}`);
});
