import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bluetoothSupported, connectSpeakEasy } from "./lib/ble";
import { fetchSuggestions } from "./lib/ai";
import { buildTiles, CATEGORIES, moveIndex } from "./lib/board";
import { browserSpeak, createListener, grokSpeak, speechRecognitionSupported } from "./lib/speech";
import { loadSettings, saveSettings } from "./lib/storage";
import Wheel from "./Wheel.jsx";
import "./App.css";

const STARTER = ["I'm listening.", "Give me a second.", "Tell me more."];

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [view, setView] = useState("board");
  const [suggestions, setSuggestions] = useState(STARTER);
  const [aiSource, setAiSource] = useState("ready");
  const [selected, setSelected] = useState(0);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [interim, setInterim] = useState("");
  const [lastSpoken, setLastSpoken] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [bleState, setBleState] = useState("off");
  const [status, setStatus] = useState("Turn the wheel with arrows. Enter speaks.");
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("Chat");
  const [typedHeard, setTypedHeard] = useState("");

  const historyRef = useRef([]);
  const listenerRef = useRef(null);
  const bleRef = useRef(null);
  const settingsRef = useRef(settings);
  const selectedRef = useRef(0);
  const tilesRef = useRef([]);
  const handlingRef = useRef(false);
  const commandRef = useRef(null);

  settingsRef.current = settings;
  selectedRef.current = selected;

  const tiles = useMemo(
    () =>
      buildTiles({
        suggestions,
        view,
      }),
    [suggestions, view]
  );
  tilesRef.current = tiles;

  const persist = (next) => {
    setSettings(next);
    saveSettings(next);
  };

  const speakText = useCallback(async (text) => {
    if (!text) return;
    setSpeaking(true);
    listenerRef.current?.pause();
    setLastSpoken(text);
    setStatus(`Speaking: ${text}`);
    try {
      if (settingsRef.current.voice === "grok") {
        try {
          await grokSpeak(text);
        } catch {
          await browserSpeak(text);
        }
      } else {
        await browserSpeak(text);
      }
    } finally {
      setSpeaking(false);
      listenerRef.current?.resume();
      bleRef.current?.pingLed();
    }
  }, []);

  const requestReplies = useCallback(async (text) => {
    if (!text) return;
    setBusy(true);
    setStatus("Thinking of replies…");
    const result = await fetchSuggestions({
      profile: settingsRef.current.profile,
      heard: text,
      history: historyRef.current,
      provider: settingsRef.current.provider,
      customPrompt: settingsRef.current.customPrompt,
    });
    setSuggestions(result.replies);
    setCategory(result.category || "Chat");
    setAiSource(result.source);
    setSelected(0);
    setView("board");
    setBusy(false);
    const where = result.source === "offline" ? "Offline replies" : `Replies from ${result.source}`;
    setStatus(`${where} · ${result.category || "Chat"}`);
  }, []);

  const onHeard = useCallback(
    (text) => {
      setHeard(text);
      setInterim("");
      historyRef.current = [...historyRef.current, `Other: ${text}`].slice(-8);
      requestReplies(text);
    },
    [requestReplies]
  );

  useEffect(() => {
    listenerRef.current = createListener({
      onFinal: onHeard,
      onInterim: setInterim,
      onError: (err) => setStatus(`Mic: ${err}`),
    });
    fetch("/api/health")
      .then((r) => r.json())
      .then((h) => {
        if (!h.grok && !h.openai) setStatus("No API keys in .env — offline replies only.");
      })
      .catch(() => setStatus("Proxy not running. Start with npm run dev."));
  }, [onHeard]);

  useEffect(() => {
    if (!settings.scanning || showSettings) return undefined;
    const id = setInterval(() => {
      setSelected((i) => (i + 1) % tilesRef.current.length);
    }, Math.max(500, Number(settings.scanMs) || 1100));
    return () => clearInterval(id);
  }, [settings.scanning, settings.scanMs, showSettings, tiles.length]);

  const toggleListen = useCallback(() => {
    if (!speechRecognitionSupported()) {
      setStatus("Speech recognition needs Chrome + internet.");
      return;
    }
    if (listening) {
      listenerRef.current?.stop();
      setListening(false);
      setStatus("Mic off");
    } else {
      listenerRef.current?.start();
      setListening(true);
      setStatus("Listening…");
    }
  }, [listening]);

  const activate = useCallback(
    async (index) => {
      const tile = tilesRef.current[index];
      if (!tile || handlingRef.current) return;
      handlingRef.current = true;
      try {
        if (tile.kind === "category") {
          setSuggestions(CATEGORIES[tile.label]);
          setCategory(tile.label);
          setView("board");
          setSelected(0);
          setAiSource("category");
          setStatus(`${tile.label} phrases`);
          return;
        }
        if (tile.kind === "speak") {
          historyRef.current = [...historyRef.current, `Me: ${tile.label}`].slice(-8);
          await speakText(tile.label);
        }
      } finally {
        handlingRef.current = false;
      }
    },
    [speakText]
  );

  const onCommand = useCallback(
    (cmd) => {
      if (cmd === "DISCONNECTED") {
        setBleState("off");
        setStatus("Joystick disconnected");
        bleRef.current = null;
        return;
      }
      if (showSettings) return;
      if (cmd === "SELECT") {
        activate(selectedRef.current);
        return;
      }
      if (settingsRef.current.scanning) return;
      setSelected((i) => moveIndex(i, cmd, tilesRef.current.length));
    },
    [activate, showSettings]
  );
  commandRef.current = onCommand;

  useEffect(() => {
    const onKey = (event) => {
      if (showSettings && event.key === "Escape") {
        setShowSettings(false);
        return;
      }
      if (showSettings) return;
      if (event.target.closest?.("input, textarea, select")) return;
      const map = {
        ArrowUp: "UP",
        ArrowDown: "DOWN",
        ArrowLeft: "LEFT",
        ArrowRight: "RIGHT",
        Enter: "SELECT",
        " ": "SELECT",
      };
      const cmd = map[event.key];
      if (!cmd) return;
      event.preventDefault();
      onCommand(cmd);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCommand, showSettings]);

  async function connectBle() {
    try {
      setBleState("connecting");
      bleRef.current = await connectSpeakEasy((cmd) => commandRef.current?.(cmd));
      setBleState("on");
      setStatus("Joystick connected");
    } catch (err) {
      setBleState("off");
      setStatus(String(err.message || err));
    }
  }

  const hubLabel = view === "categories" ? "Open" : speaking ? "…" : "Speak";

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>SpeakEasy</h1>
          <p className="tag">{view === "categories" ? "Pick a topic" : `${category} · ${aiSource}`}</p>
        </div>
        <div className="actions">
          <button type="button" className={listening ? "live" : ""} onClick={toggleListen}>
            {listening ? "Listening" : "Listen"}
          </button>
          <button type="button" onClick={() => setView(view === "categories" ? "board" : "categories")}>
            {view === "categories" ? "Replies" : "Topics"}
          </button>
          <button
            type="button"
            onClick={() => (heard ? requestReplies(heard) : setStatus("Nothing heard yet."))}
            disabled={busy}
          >
            New
          </button>
          <button type="button" onClick={connectBle} disabled={!bluetoothSupported() || bleState === "connecting"}>
            {bleState === "on" ? "Joystick on" : "Joystick"}
          </button>
          <button type="button" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </header>

      <div className="meta">
        <span className={`pill ${listening ? "live" : ""}`}>{listening ? "Mic on" : "Mic off"}</span>
        {speaking ? <span className="pill live">Speaking</span> : null}
        {busy ? <span className="pill">Thinking</span> : null}
        {settings.scanning ? <span className="pill live">Scanning</span> : null}
      </div>

      <p className="heard">
        <strong>Heard:</strong> {interim || heard || "—"}
      </p>

      <div className="stage">
        <Wheel
          items={tiles}
          selected={selected}
          onChoose={(index) => {
            setSelected(index);
            activate(index);
          }}
          hubLabel={hubLabel}
          onHub={() => activate(selected)}
        />
      </div>

      <p className="status">{status}</p>

      <form
        className="heard-form"
        onSubmit={(e) => {
          e.preventDefault();
          const text = typedHeard.trim();
          if (!text) return;
          setTypedHeard("");
          onHeard(text);
        }}
      >
        <input
          value={typedHeard}
          onChange={(e) => setTypedHeard(e.target.value)}
          placeholder="Type what they said"
          aria-label="Type what they said"
        />
        <button type="submit" className="primary" disabled={busy || !typedHeard.trim()}>
          Reply
        </button>
      </form>

      {showSettings ? (
        <div className="overlay" role="dialog" aria-label="Settings">
          <div className="panel">
            <h2>Settings</h2>
            <p className="hint">
              API keys live in the project <code>.env</code> file on the laptop, not in the browser.
            </p>
            <label>
              User profile
              <textarea
                rows={5}
                value={settings.profile}
                onChange={(e) => persist({ ...settings, profile: e.target.value })}
              />
            </label>
            <label>
              Custom prompt
              <textarea
                rows={4}
                value={settings.customPrompt}
                onChange={(e) => persist({ ...settings, customPrompt: e.target.value })}
                placeholder="How the AI should write replies for this person"
              />
            </label>
            <label>
              AI provider
              <select
                value={settings.provider}
                onChange={(e) => persist({ ...settings, provider: e.target.value })}
              >
                <option value="grok">Grok first, then ChatGPT</option>
                <option value="openai">ChatGPT first, then Grok</option>
              </select>
            </label>
            <label>
              Voice
              <select value={settings.voice} onChange={(e) => persist({ ...settings, voice: e.target.value })}>
                <option value="grok">Grok Voice (fallback: browser)</option>
                <option value="browser">Browser speechSynthesis</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={settings.scanning}
                onChange={(e) => persist({ ...settings, scanning: e.target.checked })}
              />
              Scanning mode (highlight walks around the wheel)
            </label>
            <label>
              Scan speed (ms)
              <input
                type="number"
                min="500"
                step="100"
                value={settings.scanMs}
                onChange={(e) => persist({ ...settings, scanMs: Number(e.target.value) })}
              />
            </label>
            <div className="actions">
              <button type="button" className="primary" onClick={() => setShowSettings(false)}>
                Close
              </button>
              {lastSpoken ? (
                <button type="button" onClick={() => speakText(lastSpoken)}>
                  Repeat last
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
