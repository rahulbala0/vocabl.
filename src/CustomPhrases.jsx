import { useMemo, useRef, useState } from "react";
import Wheel from "./Wheel.jsx";

const MAX = 4;
const MAX_LEN = 60;
const WARN_LEN = 40;
const DIRECTIONS = ["Up", "Right", "Down", "Left"];
const QUICK_PICKS = [
  "I love you.",
  "Thank you.",
  "Please wait a moment.",
  "I need a break.",
  "That made me laugh.",
  "Yes, please.",
  "No, thank you.",
  "I'm in pain.",
  "Can you repeat that?",
  "I'm tired.",
  "Turn on music, please.",
  "Good morning!",
];

function toDraft(phrases) {
  const next = (phrases || []).map((p) => String(p || "")).slice(0, MAX);
  while (next.length < MAX) next.push("");
  return next;
}

export default function CustomPhrases({ phrases, onChange, onClose, onSpeak }) {
  const [initial] = useState(() => toDraft(phrases));
  const [draft, setDraft] = useState(initial);
  const [active, setActive] = useState(0);
  const inputRefs = useRef([]);

  const dirty = draft.some((p, i) => p !== initial[i]);

  const previewItems = useMemo(
    () => draft.map((p, i) => ({ id: `preview-${i}`, label: p.trim() || "Empty", kind: p.trim() ? "speak" : "empty" })),
    [draft]
  );

  function setAt(index, value) {
    const next = draft.slice();
    next[index] = value.slice(0, MAX_LEN);
    setDraft(next);
  }

  function focusSlot(index) {
    setActive(index);
    inputRefs.current[index]?.focus();
  }

  const firstEmpty = draft.findIndex((p) => !p.trim());
  const pickTarget = !draft[active]?.trim() || firstEmpty === -1 ? active : firstEmpty;

  function applyQuickPick(text) {
    setAt(pickTarget, text);
    focusSlot(pickTarget);
  }

  function speak(index) {
    const text = draft[index]?.trim();
    if (text) onSpeak?.(text);
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
          <span className="tag">Hold click on the main wheel to open these</span>
        </div>
        <div className="caregiver-btns">
          {dirty && <span className="pill unsaved">Unsaved</span>}
          <button type="button" onClick={() => setDraft(initial)} disabled={!dirty}>Reset</button>
          <button type="button" onClick={onClose}>Back</button>
          <button type="button" className="primary" onClick={save}>Save</button>
        </div>
      </header>

      <div className="custom-grid">
        <section className="custom-preview">
          <Wheel
            items={previewItems}
            selected={active}
            onChoose={focusSlot}
            onHubSelect={() => speak(active)}
          />
          <p className="hint">Click a slice to edit it · click OK to hear it</p>
        </section>

        <section className="custom-editor">
          <div className="custom-cards">
            {draft.map((phrase, i) => {
              const len = phrase.length;
              return (
                <div
                  key={i}
                  className={`custom-card slot-${i} ${i === active ? "on" : ""}`}
                  onClick={() => focusSlot(i)}
                >
                  <div className="custom-card-head">
                    <span className="custom-dir">{DIRECTIONS[i]}</span>
                    <span className={`custom-count ${len >= WARN_LEN ? "warn" : ""}`}>
                      {len}/{MAX_LEN}
                    </span>
                  </div>
                  <textarea
                    ref={(el) => { inputRefs.current[i] = el; }}
                    value={phrase}
                    rows={2}
                    placeholder="Type a reply…"
                    aria-label={`${DIRECTIONS[i]} phrase`}
                    onFocus={() => setActive(i)}
                    onChange={(e) => setAt(i, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        focusSlot((i + 1) % MAX);
                      }
                    }}
                  />
                  <div className="custom-card-actions">
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); speak(i); }}
                      disabled={!phrase.trim()}
                    >
                      🔊 Hear
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setAt(i, ""); focusSlot(i); }}
                      disabled={!phrase}
                    >
                      Clear
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="quick-picks">
            <p className="heard-label">Quick picks → {DIRECTIONS[pickTarget]}</p>
            <div className="chips">
              {QUICK_PICKS.map((text) => (
                <button
                  key={text}
                  type="button"
                  className={`chip ${draft.includes(text) ? "used" : ""}`}
                  onClick={() => applyQuickPick(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
