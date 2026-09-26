import { useState } from "react";

const MAX = 4;
const MIN = 1;

export default function CustomPhrases({ phrases, onChange, onClose }) {
  const [draft, setDraft] = useState(() => {
    const next = (phrases || []).map((p) => String(p || ""));
    while (next.length < MAX) next.push("");
    return next.slice(0, MAX);
  });

  function setAt(index, value) {
    const next = draft.slice();
    next[index] = value;
    setDraft(next);
  }

  function addSlot() {
    if (draft.length >= MAX) return;
    setDraft([...draft, ""]);
  }

  function removeSlot(index) {
    if (draft.length <= MIN) return;
    setDraft(draft.filter((_, i) => i !== index));
  }

  function save() {
    const cleaned = draft.map((p) => p.trim()).filter(Boolean);
    onChange(cleaned.length ? cleaned : ["Please wait a moment."]);
    onClose();
  }

  return (
    <div className="app custom-page">
      <header className="top">
        <div className="top-left">
          <h1>Custom phrases</h1>
          <span className="tag">These fill the hold-to-open wheel</span>
        </div>
        <div className="caregiver-btns">
          <button type="button" onClick={onClose}>Back</button>
          <button type="button" className="primary" onClick={save}>Save</button>
        </div>
      </header>

      <div className="custom-body">
        <p className="hint">
          Add up to 4 replies the user can pick after holding the joystick click. Keep them short
          so they fit on the wheel.
        </p>
        <ol className="custom-list">
          {draft.map((phrase, i) => (
            <li key={i}>
              <label>
                Phrase {i + 1}
                <input
                  value={phrase}
                  maxLength={60}
                  placeholder="Type a reply…"
                  onChange={(e) => setAt(i, e.target.value)}
                />
              </label>
              <button type="button" onClick={() => removeSlot(i)} disabled={draft.length <= MIN}>
                Remove
              </button>
            </li>
          ))}
        </ol>
        <div className="actions">
          <button type="button" onClick={addSlot} disabled={draft.length >= MAX}>
            Add phrase
          </button>
        </div>
      </div>
    </div>
  );
}
