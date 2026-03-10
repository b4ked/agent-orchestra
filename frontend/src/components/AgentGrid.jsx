/**
 * AgentGrid.jsx
 *
 * Renders all active agent terminals in a responsive grid.
 * Each AgentTerminal is mounted once and kept alive; it is only unmounted
 * when the user explicitly dismisses a stopped agent.
 */

import AgentTerminal from './AgentTerminal.jsx';

export default function AgentGrid({
  agents,
  onKill,
  onDismiss,
  onInput,
  onResize,
  onRegisterHandler,
  onUnregisterHandler,
}) {
  const agentList = Object.values(agents);

  if (agentList.length === 0) {
    return (
      <main className="agent-grid agent-grid--empty">
        <div className="empty-state">
          <span className="empty-state__icon">🖥️</span>
          <p className="empty-state__title">No agents running</p>
          <p className="empty-state__sub">
            Fill in the context on the left and click <strong>Launch Agent</strong>.
          </p>
        </div>
      </main>
    );
  }

  // Layout: single column for 1 agent, 2-col grid for 2+
  const gridClass = agentList.length === 1
    ? 'agent-grid agent-grid--single'
    : 'agent-grid agent-grid--multi';

  return (
    <main className={gridClass}>
      {agentList.map((agent) => (
        <AgentTerminal
          key={agent.agentId}
          agent={agent}
          onKill={onKill}
          onDismiss={onDismiss}
          onInput={onInput}
          onResize={onResize}
          onRegisterHandler={onRegisterHandler}
          onUnregisterHandler={onUnregisterHandler}
        />
      ))}
    </main>
  );
}
