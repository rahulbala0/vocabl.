import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bluetoothSupported, connectSpeakEasy } from "./lib/ble";
import { fetchSuggestions } from "./lib/ai";
import { buildTiles, CATEGORIES, moveIndex } from "./lib/board";
import { browserSpeak, createListener, grokSpeak, speechRecognitionSupported } from "./lib/speech";
import { loadSettings, saveSettings } from "./lib/storage";
import "./App.css";

const STARTER = ["I'm listening.", "Give me a second.", "Can you repeat that?", "Tell me more."];

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
  const [status, setStatus] = useState("Keyboard: arrows + Enter. Chrome required.");
  const [busy, setBusy] = useState(false);

  const historyRef = useRef([]);
  const listenerRef = useRef(null);
  const bleRef = useRef(null);
  const settingsRef = useRef(settings);
  const selectedRef = useRef(0);
  const viewRef = useRef(view);
  const tilesRef = useRef([]);
  const handlingRef = useRef(false);
  const commandRef = useRef(null);

  settingsRef.current = settings;
  selectedRef.current = selected;
  viewRef.current = view;

  const tiles = useMemo(
    () =>
      buildTiles({
        suggestions,
        custom: settings.custom,
        listening,
        view,
      }),
    [suggestions, settings.custom, listening, view]
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
    });
    setSuggestions(result.replies);
    setAiSource(result.source);
    setSelected(0);
    setView("board");
    setBusy(false);
    setStatus(result.source === "offline" ? "Offline replies (no key or API error)" : `Replies from ${result.source}`);
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

  const activate = useCallback(
    async (index) => {
      const tile = tilesRef.current[index];
      if (!tile || tile.kind === "empty" || handlingRef.current) return;
      handlingRef.current = true;
      try {
        if (tile.kind === "category") {
          setSuggestions(CATEGORIES[tile.label]);
          setView("board");
          setSelected(0);
          setAiSource("category");
          setStatus(`${tile.label} phrases`);
          return;
        }
        if (tile.kind === "speak") {
          historyRef.current = [...historyRef.current, `Me: ${tile.label}`].slice(-8);
          await speakText(tile.label);
          return;
        }
        if (tile.id === "listen") {
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
          return;
        }
        if (tile.id === "refresh") {
          if (heard) await requestReplies(heard);
          else setStatus("Nothing heard yet. Turn on Listen first.");
          return;
        }
        if (tile.id === "repeat") {
          if (lastSpoken) await speakText(lastSpoken);
          else setStatus("Nothing to repeat yet.");
          return;
        }
        if (tile.id === "thanks") {
          historyRef.current = [...historyRef.current, "Me: Thank you."].slice(-8);
          await speakText("Thank you.");
        }
      } finally {
        handlingRef.current = false;
      }
    },
    [heard, lastSpoken, listening, requestReplies, speakText]
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

  const rows = view === "categories" ? [tiles] : [0, 1, 2, 3].map((r) => tiles.filter((t) => t.row === r));
  const rowTitles =
    view === "categories"
      ? ["Start a conversation"]
      : ["AI replies", "Quick words", "Controls", "Custom phrases"];

  return (
    <div className="app">
      <header className="top">
        <div>
          <h1>SpeakEasy Board</h1>
          <p className="tag">Hear them. Pick a reply. Speak in seconds.</p>
        </div>
        <div className="actions">
          <button type="button" onClick={() => setView(view === "categories" ? "board" : "categories")}>
            {view === "categories" ? "Back to board" : "Categories"}
          </button>
          <button type="button" onClick={connectBle} disabled={!bluetoothSupported() || bleState === "connecting"}>
            {bleState === "on" ? "Joystick on" : "Connect joystick"}
          </button>
          <button type="button" onClick={() => setShowSettings(true)}>
            Settings
          </button>
        </div>
      </header>

      <div className="meta">
        <span className={`pill ${listening ? "live" : ""}`}>{listening ? "MIC ON" : "MIC OFF"}</span>
        <span className={`pill ${bleState === "on" ? "live" : ""}`}>BLE {bleState}</span>
        <span className="pill">{aiSource}</span>
        {settings.scanning ? <span className="pill live">SCANNING</span> : null}
        {speaking ? <span className="pill live">SPEAKING</span> : null}
        {busy ? <span className="pill">AI…</span> : null}
      </div>

      <p className="heard">
        <strong>Heard:</strong> {interim || heard || "—"}
      </p>
      <p className="status">{status}</p>

      {rows.map((row, r) => (
        <section key={rowTitles[r]} className="row">
          <h2>{rowTitles[r]}</h2>
          <div className="grid">
            {row.map((tile) => {
              const index = tiles.findIndex((t) => t.id === tile.id);
              const on = index === selected;
              return (
                <button
                  key={tile.id}
                  type="button"
                  className={`tile ${on ? "on" : ""} ${tile.kind}`}
                  onClick={() => {
                    setSelected(index);
                    activate(index);
                  }}
                >
                  {tile.label}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      {showSettings ? (
        <div className="overlay" role="dialog" aria-label="Settings">
          <div className="panel">
            <h2>Settings</h2>
            <p className="hint">
              API keys live in the project <code>.env</code> file on the laptop, not in the browser. That avoids CORS
              and keeps keys off the tablet screen.
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
              Scanning mode (auto-highlight; click or Enter selects)
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
            <fieldset>
              <legend>Custom phrases (row 4)</legend>
              {settings.custom.map((phrase, i) => (
                <input
                  key={i}
                  value={phrase}
                  onChange={(e) => {
                    const custom = settings.custom.slice();
                    custom[i] = e.target.value;
                    persist({ ...settings, custom });
                  }}
                />
              ))}
            </fieldset>
            <div className="actions">
              <button type="button" onClick={() => setShowSettings(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
