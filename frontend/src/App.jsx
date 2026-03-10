/**
 * App.jsx – Root component
 *
 * Owns the single WebSocket connection to the backend.
 * Maintains the agent registry (id → { engine, status, terminalRef }).
 * Passes down callbacks to child components.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import ContextPanel from './components/ContextPanel.jsx';
import AgentGrid from './components/AgentGrid.jsx';

// Resolve the WS URL relative to the current page so it works in both dev
// (Vite proxy) and production (backend serves frontend on same port).
function buildWsUrl() {
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const host = window.location.host;
  return `${proto}://${host}/ws`;
}

export default function App() {
  const [wsStatus, setWsStatus] = useState('disconnected'); // 'connecting' | 'connected' | 'disconnected'
  const [agents, setAgents] = useState({}); // { [agentId]: AgentRecord }
  const wsRef = useRef(null);
  // Ref map so terminal components can register their write callbacks
  // without causing re-renders on every keystroke.
  const termWriteHandlers = useRef({}); // { [agentId]: (data: string) => void }

  // -------------------------------------------------------------------------
  // WebSocket connection management
  // -------------------------------------------------------------------------

  const connect = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState < 2) return; // already open/connecting

    setWsStatus('connecting');
    const ws = new WebSocket(buildWsUrl());
    wsRef.current = ws;

    ws.onopen = () => setWsStatus('connected');

    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      handleServerMessage(msg);
    };

    ws.onerror = () => setWsStatus('disconnected');

    ws.onclose = () => {
      setWsStatus('disconnected');
      // Auto-reconnect after 2 s
      setTimeout(connect, 2000);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    connect();
    return () => {
      wsRef.current?.close();
    };
  }, [connect]);

  // -------------------------------------------------------------------------
  // Incoming server messages
  // -------------------------------------------------------------------------

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'agent_created': {
        const { agentId, engine } = msg.payload;
        setAgents((prev) => ({
          ...prev,
          [agentId]: { agentId, engine, status: 'running' },
        }));
        break;
      }

      case 'output': {
        const { agentId, data } = msg.payload;
        // Deliver raw terminal data to the registered xterm write handler
        const handler = termWriteHandlers.current[agentId];
        if (handler) handler(data);
        break;
      }

      case 'agent_exited': {
        const { agentId, code } = msg.payload;
        setAgents((prev) => {
          if (!prev[agentId]) return prev;
          return { ...prev, [agentId]: { ...prev[agentId], status: 'exited', exitCode: code } };
        });
        break;
      }

      case 'error': {
        const { agentId, message } = msg.payload;
        console.error(`[server error] agent=${agentId}  msg=${message}`);
        if (agentId) {
          setAgents((prev) => {
            if (!prev[agentId]) return prev;
            return { ...prev, [agentId]: { ...prev[agentId], status: 'error', errorMsg: message } };
          });
        }
        break;
      }

      default:
        break;
    }
  }

  // -------------------------------------------------------------------------
  // Outgoing WebSocket helpers
  // -------------------------------------------------------------------------

  function wsSend(msg) {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }

  // -------------------------------------------------------------------------
  // Public callbacks passed to children
  // -------------------------------------------------------------------------

  const spawnAgent = useCallback((spawnPayload) => {
    wsSend({ type: 'spawn', payload: spawnPayload });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const killAgent = useCallback((agentId) => {
    wsSend({ type: 'kill', payload: { agentId } });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const dismissAgent = useCallback((agentId) => {
    setAgents((prev) => {
      const next = { ...prev };
      delete next[agentId];
      delete termWriteHandlers.current[agentId];
      return next;
    });
  }, []);

  const sendInput = useCallback((agentId, data) => {
    wsSend({ type: 'input', payload: { agentId, data } });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const sendResize = useCallback((agentId, cols, rows) => {
    wsSend({ type: 'resize', payload: { agentId, cols, rows } });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const registerTermHandler = useCallback((agentId, handler) => {
    termWriteHandlers.current[agentId] = handler;
  }, []);

  const unregisterTermHandler = useCallback((agentId) => {
    delete termWriteHandlers.current[agentId];
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  const statusDot =
    wsStatus === 'connected' ? 'dot dot--green' :
    wsStatus === 'connecting' ? 'dot dot--yellow' :
    'dot dot--red';

  return (
    <div className="layout">
      {/* ── Top bar ── */}
      <header className="topbar">
        <span className="topbar__logo">🎼 Agent Orchestra</span>
        <span className={statusDot} title={wsStatus} />
        <span className="topbar__status">{wsStatus}</span>
        <span className="topbar__agent-count">
          {Object.keys(agents).length} agent{Object.keys(agents).length !== 1 ? 's' : ''}
        </span>
      </header>

      {/* ── Main body ── */}
      <div className="body">
        {/* Left panel: context compiler + spawner */}
        <ContextPanel
          wsStatus={wsStatus}
          onSpawn={spawnAgent}
        />

        {/* Right panel: live terminal grid */}
        <AgentGrid
          agents={agents}
          onKill={killAgent}
          onDismiss={dismissAgent}
          onInput={sendInput}
          onResize={sendResize}
          onRegisterHandler={registerTermHandler}
          onUnregisterHandler={unregisterTermHandler}
        />
      </div>
    </div>
  );
}
