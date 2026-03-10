/**
 * ContextPanel.jsx
 *
 * Left sidebar containing:
 *  1. Director Task textarea
 *  2. File picker / reader
 *  3. Agent-Specific Instructions textarea
 *  4. Engine selector
 *  5. Launch Agent button
 */

import { useRef, useState } from 'react';

const ENGINE_OPTIONS = [
  { value: 'claude', label: 'Claude Code', hint: 'claude --dangerously-skip-permissions' },
  { value: 'codex',  label: 'OpenAI Codex', hint: 'codex -yolo' },
];

export default function ContextPanel({ wsStatus, onSpawn }) {
  const [directorTask, setDirectorTask] = useState('');
  const [agentInstructions, setAgentInstructions] = useState('');
  const [engine, setEngine] = useState('claude');
  const [files, setFiles] = useState([]); // [{ name, content }]
  const [launching, setLaunching] = useState(false);
  const fileInputRef = useRef(null);

  // -------------------------------------------------------------------------
  // File loading
  // -------------------------------------------------------------------------

  async function handleFileChange(e) {
    const picked = Array.from(e.target.files ?? []);
    const loaded = await Promise.all(
      picked.map(
        (f) =>
          new Promise((resolve) => {
            const reader = new FileReader();
            reader.onload = (evt) => resolve({ name: f.name, content: evt.target.result });
            reader.onerror = () => resolve({ name: f.name, content: '(read error)' });
            reader.readAsText(f);
          })
      )
    );
    setFiles((prev) => {
      // Deduplicate by name – later selection wins
      const map = Object.fromEntries(prev.map((f) => [f.name, f]));
      for (const f of loaded) map[f.name] = f;
      return Object.values(map);
    });
    // Reset the file input so the same files can be re-picked if needed
    e.target.value = '';
  }

  function removeFile(name) {
    setFiles((prev) => prev.filter((f) => f.name !== name));
  }

  // -------------------------------------------------------------------------
  // Launch
  // -------------------------------------------------------------------------

  function handleLaunch() {
    if (wsStatus !== 'connected') return;
    if (!directorTask.trim() && files.length === 0 && !agentInstructions.trim()) {
      // Allow launching with empty context (user may want a bare shell)
    }
    setLaunching(true);
    onSpawn({ engine, directorTask, files, agentInstructions });
    // Brief visual feedback
    setTimeout(() => setLaunching(false), 800);
  }

  const canLaunch = wsStatus === 'connected' && !launching;
  const selectedEngine = ENGINE_OPTIONS.find((o) => o.value === engine);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <aside className="context-panel">
      <h2 className="panel-title">Context Compiler</h2>

      {/* ── Director Task ── */}
      <label className="field-label" htmlFor="director-task">
        Director Task
        <span className="field-hint">The main instruction sent to the agent</span>
      </label>
      <textarea
        id="director-task"
        className="field-textarea"
        rows={6}
        placeholder="Describe what you want the agent to do…"
        value={directorTask}
        onChange={(e) => setDirectorTask(e.target.value)}
      />

      {/* ── File Picker ── */}
      <label className="field-label">
        Project Files
        <span className="field-hint">Files whose contents will be injected into context</span>
      </label>
      <button
        type="button"
        className="btn btn--secondary btn--sm"
        onClick={() => fileInputRef.current?.click()}
      >
        + Add Files
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {files.length > 0 && (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.name} className="file-list__item">
              <span className="file-list__name" title={f.name}>{f.name}</span>
              <span className="file-list__size">
                {f.content.length > 1024
                  ? `${(f.content.length / 1024).toFixed(1)} KB`
                  : `${f.content.length} B`}
              </span>
              <button
                type="button"
                className="file-list__remove"
                title="Remove file"
                onClick={() => removeFile(f.name)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {/* ── Agent-Specific Instructions ── */}
      <label className="field-label" htmlFor="agent-instructions">
        Agent Instructions
        <span className="field-hint">Additional constraints for this agent (optional)</span>
      </label>
      <textarea
        id="agent-instructions"
        className="field-textarea"
        rows={4}
        placeholder="e.g. Focus only on the database schema. Do not modify the frontend."
        value={agentInstructions}
        onChange={(e) => setAgentInstructions(e.target.value)}
      />

      {/* ── Engine Selector ── */}
      <label className="field-label" htmlFor="engine-select">
        Engine
      </label>
      <select
        id="engine-select"
        className="field-select"
        value={engine}
        onChange={(e) => setEngine(e.target.value)}
      >
        {ENGINE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <p className="engine-hint">
        <code>{selectedEngine.hint}</code>
      </p>

      {/* ── Launch Button ── */}
      <button
        type="button"
        className={`btn btn--primary btn--launch${launching ? ' btn--busy' : ''}`}
        disabled={!canLaunch}
        onClick={handleLaunch}
        title={wsStatus !== 'connected' ? 'Waiting for backend connection…' : ''}
      >
        {launching ? '⏳ Launching…' : '🚀 Launch Agent'}
      </button>

      {wsStatus !== 'connected' && (
        <p className="ws-warning">
          Backend {wsStatus}. Waiting for connection…
        </p>
      )}

      {/* ── Context summary ── */}
      {(directorTask || files.length > 0 || agentInstructions) && (
        <div className="context-summary">
          <p className="context-summary__title">Context preview</p>
          <ul className="context-summary__list">
            {directorTask && <li>{directorTask.length} chars — Director Task</li>}
            {files.length > 0 && <li>{files.length} file{files.length > 1 ? 's' : ''} loaded</li>}
            {agentInstructions && <li>{agentInstructions.length} chars — Instructions</li>}
          </ul>
        </div>
      )}
    </aside>
  );
}
