export default function MemorySettings({ facts = [], summaries = [], onChange }) {
  function setFacts(next) {
    onChange({ facts: next, summaries });
  }

  function setSummaries(next) {
    onChange({ facts, summaries: next });
  }

  return (
    <fieldset className="memory-settings">
      <legend>Memory</legend>
      <p className="hint">
        Facts and recent conversation summaries are sent with every reply request so answers can
        build on past talks.
      </p>

      <p className="heard-label">Facts</p>
      {!facts.length && <p className="hint">None yet. The AI adds these when it learns something lasting.</p>}
      <ul className="memory-list">
        {facts.map((fact, i) => (
          <li key={`fact-${i}`}>
            <input
              value={fact}
              aria-label={`Fact ${i + 1}`}
              onChange={(e) => {
                const next = facts.slice();
                next[i] = e.target.value;
                setFacts(next);
              }}
            />
            <button type="button" onClick={() => setFacts(facts.filter((_, j) => j !== i))}>
              Delete
            </button>
          </li>
        ))}
      </ul>
      <button type="button" onClick={() => setFacts([...facts, ""])}>
        Add fact
      </button>

      <p className="heard-label">Past conversations</p>
      {!summaries.length && <p className="hint">None yet. A summary is saved after a few minutes of silence, or when the page closes.</p>}
      <ul className="memory-list">
        {summaries.map((item) => (
          <li key={item.id}>
            <div className="memory-summary">
              {item.at && (
                <time dateTime={item.at}>
                  {new Date(item.at).toLocaleString()}
                </time>
              )}
              <textarea
                rows={2}
                value={item.text}
                aria-label="Conversation summary"
                onChange={(e) => {
                  setSummaries(summaries.map((row) => (row.id === item.id ? { ...row, text: e.target.value } : row)));
                }}
              />
            </div>
            <button type="button" onClick={() => setSummaries(summaries.filter((row) => row.id !== item.id))}>
              Delete
            </button>
          </li>
        ))}
      </ul>

      <div className="actions">
        <button
          type="button"
          disabled={!facts.length && !summaries.length}
          onClick={() => {
            if (window.confirm("Clear all saved facts and conversation summaries?")) {
              onChange({ facts: [], summaries: [] });
            }
          }}
        >
          Clear all memory
        </button>
      </div>
    </fieldset>
  );
}
