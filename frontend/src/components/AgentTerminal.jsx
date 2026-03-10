/**
 * AgentTerminal.jsx
 *
 * A single pane combining:
 *  - Header bar with engine badge, status, and Stop/Dismiss buttons
 *  - An xterm.js Terminal attached to a div
 *
 * Lifecycle:
 *  - On mount: initialise xterm, register write handler with App
 *  - On unmount: dispose xterm, unregister handler
 *  - Resize: ResizeObserver drives pty resize via FitAddon + onResize callback
 */

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';

const ENGINE_LABELS = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
};

const ENGINE_COLORS = {
  claude: '#d97706', // amber
  codex: '#10b981',  // emerald
};

export default function AgentTerminal({
  agent,
  onKill,
  onDismiss,
  onInput,
  onResize,
  onRegisterHandler,
  onUnregisterHandler,
}) {
  const { agentId, engine, status, exitCode, errorMsg } = agent;
  const termDivRef = useRef(null);
  const termRef = useRef(null);
  const fitAddonRef = useRef(null);
  const resizeObserverRef = useRef(null);

  // -------------------------------------------------------------------------
  // Mount / unmount
  // -------------------------------------------------------------------------

  useEffect(() => {
    // Initialise xterm.js
    const term = new Terminal({
      theme: {
        background: '#0d1117',
        foreground: '#c9d1d9',
        cursor: '#58a6ff',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39c5cf',
        white: '#b1bac4',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d4dd',
        brightWhite: '#f0f6fc',
      },
      fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", "Menlo", "Monaco", monospace',
      fontSize: 13,
      lineHeight: 1.3,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      convertEol: false,
    });

    const fitAddon = new FitAddon();
    const linksAddon = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(linksAddon);

    term.open(termDivRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    // Forward user keystrokes → backend
    term.onData((data) => {
      onInput(agentId, data);
    });

    // Register handler so App can pipe server output → this terminal
    onRegisterHandler(agentId, (data) => term.write(data));

    // ── ResizeObserver: refit + notify backend on container size changes ──
    const ro = new ResizeObserver(() => {
      try {
        fitAddon.fit();
        const { cols, rows } = term;
        onResize(agentId, cols, rows);
      } catch {
        // may fire during unmount
      }
    });
    ro.observe(termDivRef.current);
    resizeObserverRef.current = ro;

    return () => {
      ro.disconnect();
      onUnregisterHandler(agentId);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  // -------------------------------------------------------------------------
  // Derived state
  // -------------------------------------------------------------------------

  const isRunning = status === 'running';
  const statusLabel =
    status === 'running' ? 'running' :
    status === 'exited'  ? `exited (${exitCode ?? '?'})` :
    status === 'error'   ? 'error' :
    status;

  const statusClass =
    status === 'running' ? 'badge badge--green' :
    status === 'exited'  ? 'badge badge--gray' :
    'badge badge--red';

  const engineColor = ENGINE_COLORS[engine] ?? '#8b949e';
  const engineLabel = ENGINE_LABELS[engine] ?? engine;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <section className="terminal-pane">
      {/* Header */}
      <div className="terminal-pane__header">
        <span
          className="terminal-pane__engine"
          style={{ color: engineColor }}
        >
          {engineLabel}
        </span>
        <span className="terminal-pane__id" title={agentId}>
          {agentId.slice(0, 8)}
        </span>
        <span className={statusClass}>{statusLabel}</span>

        {errorMsg && (
          <span className="terminal-pane__error" title={errorMsg}>
            ⚠ {errorMsg.slice(0, 60)}{errorMsg.length > 60 ? '…' : ''}
          </span>
        )}

        <div className="terminal-pane__actions">
          {isRunning && (
            <button
              type="button"
              className="btn btn--danger btn--sm"
              onClick={() => onKill(agentId)}
              title="Send SIGINT then SIGKILL"
            >
              ■ Stop
            </button>
          )}
          {!isRunning && (
            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => onDismiss(agentId)}
              title="Remove this panel"
            >
              ✕ Dismiss
            </button>
          )}
        </div>
      </div>

      {/* Terminal */}
      <div className="terminal-pane__body" ref={termDivRef} />
    </section>
  );
}
