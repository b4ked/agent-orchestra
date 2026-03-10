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
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

  // --- Determine command & args -----------------------------------------
  let command, args;
  if (engine === 'claude') {
    command = 'claude';
    args = ['--dangerously-skip-permissions'];
  } else {
    command = 'codex';
    args = ['-yolo'];
  }

  // --- Spawn pty ----------------------------------------------------------
  let ptyProc;
  try {
    ptyProc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 220,
      rows: 50,
      // Launch from CWD of the server process so relative paths work
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color' },
    });
  } catch (err) {
    sendToClient(ws, {
      type: 'error',
      payload: { agentId, message: `Failed to spawn ${command}: ${err.message}` },
    });
    await safeUnlink(contextPath);
    return;
  }

  agents.set(agentId, { ptyProc, engine, ws, contextPath, killTimer: null });

  // Notify client the agent is alive
  sendToClient(ws, { type: 'agent_created', payload: { agentId, engine } });
  console.log(`[agent] spawned  id=${agentId}  engine=${engine}  pid=${ptyProc.pid}`);

  // --- Pipe pty output → client -----------------------------------------
  ptyProc.onData((data) => {
    sendToClient(ws, { type: 'output', payload: { agentId, data } });
  });

  ptyProc.onExit(({ exitCode, signal }) => {
    console.log(`[agent] exited  id=${agentId}  code=${exitCode}  signal=${signal}`);
    sendToClient(ws, { type: 'agent_exited', payload: { agentId, code: exitCode, signal } });
    cleanupAgent(agentId);
  });

  // --- Feed initial context after CLI boot delay -------------------------
  // 1 500 ms gives the CLI tool time to reach its interactive prompt.
  setTimeout(() => {
    const agent = agents.get(agentId);
    if (!agent) return; // already killed
    try {
      agent.ptyProc.write(contextContent + '\r');
    } catch (err) {
      console.error(`[agent] failed to write initial context  id=${agentId}:`, err.message);
    }
  }, 1500);
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
