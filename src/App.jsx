import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bluetoothSupported, connectSpeakEasy } from "./lib/ble";
import { fetchSuggestions } from "./lib/ai";
import { buildTiles, CATEGORIES } from "./lib/board";
import { quadrantToIndex } from "./lib/joystick";
import { browserSpeak, createListener, grokSpeak, speechRecognitionSupported } from "./lib/speech";
import { loadSettings, saveSettings } from "./lib/storage";
import Wheel from "./Wheel.jsx";
import "./App.css";

const STARTER = ["I'm listening.", "Give me a second.", "Tell me more.", "Go ahead."];

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
  const [status, setStatus] = useState("Arrows navigate · Enter speaks · Y=Yes · N=No");
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("Chat");
  const [typedHeard, setTypedHeard] = useState("");
  const [repliesVersion, setRepliesVersion] = useState(0);

  const historyRef = useRef([]);
  const listenerRef = useRef(null);
  const bleRef = useRef(null);
  const settingsRef = useRef(settings);
  const selectedRef = useRef(0);
  const tilesRef = useRef([]);
  const handlingRef = useRef(false);
  const commandRef = useRef(null);
  const pressTimeRef = useRef(null);
  const viewRef = useRef(view);

  settingsRef.current = settings;
  selectedRef.current = selected;
  viewRef.current = view;

  const tiles = useMemo(() => buildTiles({ suggestions, view }), [suggestions, view]);
  tilesRef.current = tiles;

  const persist = (next) => { setSettings(next); saveSettings(next); };

  const speakText = useCallback(async (text) => {
    if (!text) return;
    setSpeaking(true);
    listenerRef.current?.pause();
    setLastSpoken(text);
    setStatus(`Speaking: ${text}`);
    try {
      if (settingsRef.current.voice === "grok") {
        try { await grokSpeak(text); } catch { await browserSpeak(text); }
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
    setRepliesVersion((v) => v + 1);
    setBusy(false);
    if (result.source === "offline") {
      setStatus(result.error ? `AI failed, using offline · ${result.error}` : "Offline replies");
    } else {
      setStatus(`From ${result.source} · ${result.category || "Chat"}`);
    }
  }, []);

  const onHeard = useCallback((text) => {
    setHeard(text);
    setInterim("");
    historyRef.current = [...historyRef.current, `Other: ${text}`].slice(-8);
    requestReplies(text);
  }, [requestReplies]);

  // Create listener and auto-start mic
  useEffect(() => {
    const listener = createListener({
      onFinal: onHeard,
      onInterim: setInterim,
      onError: (err) => setStatus(`Mic: ${err}`),
    });
    listenerRef.current = listener;

    if (speechRecognitionSupported()) {
      listener.start();
      setListening(true);
      setStatus("Listening…");
    }

    return () => listener.stop();
  }, [onHeard]);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch("/api/health")
        .then((r) => r.json())
        .then((h) => {
          if (cancelled) return;
          if (!h.grok && !h.openai) setStatus("No API keys — offline replies only.");
        })
        .catch(() => {
          if (!cancelled) setStatus("Proxy not running. Start with npm run dev.");
        });
    };
    check();
    const id = setInterval(check, 8000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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

  const activate = useCallback(async (index) => {
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
        setRepliesVersion((v) => v + 1);
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
  }, [speakText]);

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
      const index = quadrantToIndex(cmd, tilesRef.current.length);
      if (index == null) return;
      setSelected(index);
    },
    [activate, showSettings]
  );
  commandRef.current = onCommand;

  // Keyboard: arrows + long-press back + Y/N/L shortcuts
  useEffect(() => {
    const dirMap = { ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT" };

    const onKeyDown = (e) => {
      if (showSettings && e.key === "Escape") { setShowSettings(false); return; }
      if (showSettings) return;
      if (e.target.closest?.("input, textarea, select")) return;

      if (e.key === "y" || e.key === "Y") { e.preventDefault(); speakText("Yes"); return; }
      if (e.key === "n" || e.key === "N") { e.preventDefault(); speakText("No"); return; }
      if (e.key === "l" || e.key === "L") { e.preventDefault(); toggleListen(); return; }

      const dir = dirMap[e.key];
      if (dir) { e.preventDefault(); onCommand(dir); return; }

      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pressTimeRef.current = Date.now();
      }
    };

    const onKeyUp = (e) => {
      if (showSettings) return;
      if (e.target.closest?.("input, textarea, select")) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      if (pressTimeRef.current === null) return;

      const elapsed = Date.now() - pressTimeRef.current;
      pressTimeRef.current = null;

      if (elapsed > 700) {
        // Long press → toggle between board and categories (Back)
        if (viewRef.current === "categories") {
          setView("board");
          setSelected(0);
          setStatus("Back to replies · hold Enter = topic menu");
        } else {
          setView("categories");
          setSelected(0);
          setStatus("Topic menu · hold Enter to go back");
        }
      } else {
        onCommand("SELECT");
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [onCommand, showSettings, speakText, toggleListen]);

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

  return (
    <div className="app">
      {/* Slim caregiver header */}
      <header className="top">
        <div className="top-left">
          <h1>SpeakEasy</h1>
          <span className="tag">{view === "categories" ? "Topics" : `${category} · ${aiSource}`}</span>
        </div>
        <div className="caregiver-btns">
          <button
            type="button"
            className={listening ? "live" : ""}
            onClick={toggleListen}
            title="Toggle mic (L)"
          >
            {listening ? "🎙 On" : "🎙 Off"}
          </button>
          <button
            type="button"
            onClick={connectBle}
            disabled={!bluetoothSupported() || bleState === "connecting"}
            title="Connect joystick"
          >
            {bleState === "on" ? "🎮 On" : "🎮"}
          </button>
          <button type="button" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
        </div>
      </header>

      <div className="main-grid">
        {/* Left pane: wheel */}
        <div className="wheel-pane">
          <Wheel
            key={repliesVersion}
            items={tiles}
            selected={selected}
            onChoose={(index) => { setSelected(index); activate(index); }}
            onYes={() => speakText("Yes")}
            onNo={() => speakText("No")}
            busy={busy}
            speaking={speaking}
            listening={listening}
          />
          <div className="meta">
            {speaking && <span className="pill live">Speaking</span>}
            {busy && <span className="pill">Thinking</span>}
            {settings.scanning && <span className="pill live">Scan</span>}
            <span className="pill hint-pill">Hold Enter = back</span>
          </div>
        </div>

        {/* Right pane: heard + replies */}
        <div className="reply-pane">
          <div className="heard-block">
            <p className="heard-label">They said</p>
            <p className="heard-text">
              {interim || heard || <span className="muted">waiting…</span>}
            </p>
          </div>

          <div className="reply-footer">
            <div className="footer-actions">
              <button
                type="button"
                onClick={() => heard ? requestReplies(heard) : setStatus("Nothing heard yet.")}
                disabled={busy || !heard}
              >
                New replies
              </button>
              <button
                type="button"
                onClick={() => setView(view === "categories" ? "board" : "categories")}
              >
                {view === "categories" ? "Replies" : "Topics"}
              </button>
            </div>
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
                placeholder="Type what they said…"
                aria-label="Type what they said"
              />
              <button type="submit" className="primary" disabled={busy || !typedHeard.trim()}>→</button>
            </form>
            <p className="status">{status}</p>
          </div>
        </div>
      </div>

      {showSettings && (
        <div className="overlay" role="dialog" aria-label="Settings">
          <div className="panel">
            <h2>Settings</h2>
            <p className="hint">API keys live in <code>.env</code> on the laptop.</p>
            <label>
              User profile
              <textarea rows={5} value={settings.profile}
                onChange={(e) => persist({ ...settings, profile: e.target.value })} />
            </label>
            <label>
              Custom prompt
              <textarea rows={4} value={settings.customPrompt}
                onChange={(e) => persist({ ...settings, customPrompt: e.target.value })}
                placeholder="How the AI should write replies for this person" />
            </label>
            <label>
              AI provider
              <select value={settings.provider}
                onChange={(e) => persist({ ...settings, provider: e.target.value })}>
                <option value="grok">Grok first, then ChatGPT</option>
                <option value="openai">ChatGPT first, then Grok</option>
              </select>
            </label>
            <label>
              Voice
              <select value={settings.voice}
                onChange={(e) => persist({ ...settings, voice: e.target.value })}>
                <option value="grok">Grok Voice (fallback: browser)</option>
                <option value="browser">Browser speechSynthesis</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.scanning}
                onChange={(e) => persist({ ...settings, scanning: e.target.checked })} />
              Scanning mode
            </label>
            <label>
              Scan speed (ms)
              <input type="number" min="500" step="100" value={settings.scanMs}
                onChange={(e) => persist({ ...settings, scanMs: Number(e.target.value) })} />
            </label>
            <div className="actions">
              <button type="button" className="primary" onClick={() => setShowSettings(false)}>Close</button>
              {lastSpoken && (
                <button type="button" onClick={() => speakText(lastSpoken)}>Repeat last</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
