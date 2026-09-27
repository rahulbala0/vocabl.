import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bluetoothSupported, connectSpeakEasy } from "./lib/ble";
import { fetchNewSuggestions, fetchSuggestions, fetchSummary } from "./lib/ai";
import { applyAskAgain, fallbackSummary, isLowConfidence, MAX_SUMMARIES, mergeFacts, SILENCE_MS } from "./lib/memory";
import { buildTiles, CATEGORIES } from "./lib/board";
import { quadrantToIndex } from "./lib/joystick";
import {
  browserSpeak,
  createListener,
  createVoiceCache,
  logTiming,
  previewSpeak,
  setSpeakVolume,
  speechRecognitionSupported,
  stopPreview,
  usesCloudVoice,
} from "./lib/speech";
import { loadSettings, saveSettings } from "./lib/storage";
import CalibrationWizard from "./CalibrationWizard.jsx";
import CustomPhrases from "./CustomPhrases.jsx";
import JoystickSettings from "./JoystickSettings.jsx";
import MemorySettings from "./MemorySettings.jsx";
import Wheel from "./Wheel.jsx";
import "./App.css";

const STARTER = ["I'm listening.", "Give me a second.", "Tell me more.", "Go ahead."];
const IDLE_HINT = "Click center or Enter to speak · hold for custom phrases";
// Keeps the mic off briefly after speech ends so it doesn't catch the tail of the audio.
const MIC_RESUME_DELAY_MS = 300;

export default function App() {
  const [settings, setSettings] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [calibrating, setCalibrating] = useState(false);
  const [view, setView] = useState("board");
  const [suggestions, setSuggestions] = useState(STARTER);
  const [aiSource, setAiSource] = useState("ready");
  const [selected, setSelected] = useState(-1);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState("");
  const [interim, setInterim] = useState("");
  const [lastSpoken, setLastSpoken] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [bleState, setBleState] = useState("off");
  const [status, setStatusText] = useState(IDLE_HINT);
  const [statusWarn, setStatusWarn] = useState(false);
  const setStatus = (message, warn = false) => {
    setStatusText(message);
    setStatusWarn(Boolean(warn));
  };
  const [busy, setBusy] = useState(false);
  const [category, setCategory] = useState("Chat");
  const [typedHeard, setTypedHeard] = useState("");
  const [repliesVersion, setRepliesVersion] = useState(0);
  const [showCustomEditor, setShowCustomEditor] = useState(false);
  const [heardConfidence, setHeardConfidence] = useState(1);
  const [turns, setTurns] = useState([]);

  const historyRef = useRef([]);
  const chatLogRef = useRef(null);
  const listenerRef = useRef(null);
  const bleRef = useRef(null);
  const settingsRef = useRef(settings);
  const selectedRef = useRef(-1);
  const tilesRef = useRef([]);
  const handlingRef = useRef(false);
  const commandRef = useRef(null);
  const pressTimeRef = useRef(null);
  const viewRef = useRef(view);
  const suggestionsRef = useRef(suggestions);
  const heardRef = useRef(heard);
  const busyRef = useRef(false);
  const requestIdRef = useRef(0);
  const rejectedRef = useRef([]);
  const speakingRef = useRef(false);
  const micHoldRef = useRef(0);
  const sampleListenersRef = useRef(new Set());
  const heardConfidenceRef = useRef(1);
  const lastActivityRef = useRef(Date.now());
  const endingRef = useRef(false);
  const voiceCacheRef = useRef(null);
  const recognizeMsRef = useRef(0);
  if (!voiceCacheRef.current) voiceCacheRef.current = createVoiceCache();

  useEffect(() => {
    setSpeakVolume(settings.speakVolume);
  }, [settings.speakVolume]);

  settingsRef.current = settings;
  selectedRef.current = selected;
  viewRef.current = view;
  suggestionsRef.current = suggestions;
  heardRef.current = heard;
  busyRef.current = busy;

  const tiles = useMemo(
    () => buildTiles({ suggestions, view, custom: settings.custom }),
    [suggestions, view, settings.custom]
  );
  tilesRef.current = tiles;

  const persist = (next) => { setSettings(next); saveSettings(next); };
  const gridRef = useRef(null);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const log = chatLogRef.current;
    if (!log) return;
    log.scrollTop = log.scrollHeight;
  }, [turns]);

  const replyPanePx = Math.max(220, Number(settings.replyPanePx) || 320);

  const onSplitterPointerDown = useCallback((event) => {
    if (event.button != null && event.button !== 0) return;
    event.preventDefault();
    const grid = gridRef.current;
    if (!grid) return;
    const startX = event.clientX;
    const startWidth = grid.querySelector(".reply-pane")?.getBoundingClientRect().width || replyPanePx;
    const gridWidth = grid.getBoundingClientRect().width;
    const clamp = (px) => {
      const max = Math.max(220, Math.round((gridWidth - 12) * 0.55));
      return Math.min(max, Math.max(220, Math.round(px)));
    };

    setResizing(true);
    const onMove = (ev) => {
      persist({ ...settingsRef.current, replyPanePx: clamp(startWidth + (startX - ev.clientX)) });
    };
    const onUp = () => {
      setResizing(false);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [persist, replyPanePx]);

  function suggestContext() {
    const s = settingsRef.current;
    return {
      facts: (s.facts || []).map((line) => String(line).trim()).filter(Boolean),
      summaries: (s.summaries || []).map((row) => row.text).filter(Boolean).slice(-3),
      lowConfidence: isLowConfidence(heardConfidenceRef.current),
    };
  }

  function askAgainBackground() {
    const s = settingsRef.current;
    return [
      s.profile,
      ...(s.facts || []),
      ...(s.summaries || []).map((row) => row.text),
    ].filter(Boolean).join(" ");
  }

  function appendTurn(role, text) {
    const line = `${role === "other" ? "Other" : "Me"}: ${text}`;
    historyRef.current = [...historyRef.current, line].slice(-8);
    setTurns((prev) => [...prev, { id: `${Date.now()}-${prev.length}`, role, text }].slice(-8));
  }

  function rememberFacts(incoming) {
    if (!incoming?.length) return;
    const next = mergeFacts(settingsRef.current.facts, incoming);
    persist({ ...settingsRef.current, facts: next });
  }

  const endConversation = useCallback(async () => {
    const history = historyRef.current;
    if (endingRef.current || history.length < 2) return;
    endingRef.current = true;
    historyRef.current = [];
    setTurns([]);
    lastActivityRef.current = Date.now();
    try {
      const s = settingsRef.current;
      const result = await fetchSummary({ profile: s.profile, history, facts: s.facts || [] });
      const text = result.summary || fallbackSummary(history);
      if (!text) return;
      persist({
        ...settingsRef.current,
        facts: mergeFacts(settingsRef.current.facts, result.facts),
        summaries: [
          ...(settingsRef.current.summaries || []),
          { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, at: new Date().toISOString(), text },
        ].slice(-MAX_SUMMARIES),
      });
    } finally {
      endingRef.current = false;
    }
  }, []);

  // Previews and replies can overlap, so the mic resumes only when nothing is holding it.
  const holdMic = useCallback(() => {
    micHoldRef.current += 1;
    if (micHoldRef.current === 1) listenerRef.current?.pause();
  }, []);

  const releaseMic = useCallback(() => {
    setTimeout(() => {
      micHoldRef.current = Math.max(0, micHoldRef.current - 1);
      if (micHoldRef.current === 0) listenerRef.current?.resume();
    }, MIC_RESUME_DELAY_MS);
  }, []);

  const announce = useCallback((text) => {
    holdMic();
    previewSpeak(text, releaseMic);
  }, [holdMic, releaseMic]);

  const subscribeSamples = useCallback((listener) => {
    sampleListenersRef.current.add(listener);
    return () => sampleListenersRef.current.delete(listener);
  }, []);

  useEffect(() => {
    bleRef.current?.setCalibration(settings.joystickCalibration);
  }, [settings.joystickCalibration]);

  const speakText = useCallback(async (text) => {
    if (!text) return;
    speakingRef.current = true;
    setSpeaking(true);
    holdMic();
    stopPreview();
    setLastSpoken(text);
    setStatus(`Speaking: ${text}`);
    try {
      if (usesCloudVoice(settingsRef.current.voice)) {
        try { await voiceCacheRef.current.play(text); } catch { await browserSpeak(text); }
      } else {
        await browserSpeak(text);
      }
    } finally {
      speakingRef.current = false;
      setSpeaking(false);
      releaseMic();
      bleRef.current?.pingLed();
    }
  }, [holdMic, releaseMic]);

  useEffect(() => {
    const cache = voiceCacheRef.current;
    cache.setProvider(settings.voice);
    cache.clearReplies();
    if (!usesCloudVoice(settings.voice)) {
      cache.clearCustom();
      return undefined;
    }
    cache.prefetch(suggestions);
    return undefined;
  }, [suggestions, settings.voice]);

  const voicePrefetchRef = useRef(settings.voice);
  useEffect(() => {
    const cache = voiceCacheRef.current;
    cache.setProvider(settings.voice);
    if (voicePrefetchRef.current !== settings.voice) {
      cache.clearCustom();
      voicePrefetchRef.current = settings.voice;
    }
    if (!usesCloudVoice(settings.voice)) return undefined;
    cache.prefetchCustom(settings.custom || []);
    return undefined;
  }, [settings.custom, settings.voice]);

  useEffect(() => {
    if (!settings.readOptions || showSettings || showCustomEditor || selected < 0) {
      stopPreview();
      return;
    }
    if (speakingRef.current) return;
    const tile = tiles[selected];
    if (!tile) return;
    holdMic();
    previewSpeak(tile.label, releaseMic);
  }, [selected, tiles, settings.readOptions, showSettings, showCustomEditor, holdMic, releaseMic]);

  const requestReplies = useCallback(async (text) => {
    if (!text) return;
    const requestId = ++requestIdRef.current;
    rejectedRef.current = [];
    setBusy(true);
    setStatus("Thinking of replies…");
    const ctx = suggestContext();
    const result = await fetchSuggestions({
      profile: settingsRef.current.profile,
      heard: text,
      history: historyRef.current,
      provider: settingsRef.current.provider,
      customPrompt: settingsRef.current.customPrompt,
      recognizeMs: recognizeMsRef.current,
      ...ctx,
    });
    if (requestId !== requestIdRef.current) return;
    logTiming("suggest", result.ms || 0, `via ${result.source}`);
    rememberFacts(result.facts);
    setSuggestions(applyAskAgain(result.replies, ctx.lowConfidence, text, askAgainBackground()));
    setCategory(result.category || "Chat");
    setAiSource(result.source);
    setSelected(-1);
    setView("board");
    setRepliesVersion((v) => v + 1);
    setBusy(false);
    if (result.source === "offline") {
      setStatus(result.error ? `AI failed, using offline · ${result.error}` : "Offline replies");
    } else {
      setStatus(IDLE_HINT);
    }
  }, []);

  const refreshReplies = useCallback(async () => {
    if (busyRef.current) return;
    if (viewRef.current !== "board") {
      setStatus("New replies only work on the reply wheel.");
      return;
    }
    const shown = suggestionsRef.current;
    const avoid = [...rejectedRef.current, ...shown].slice(-16);
    const requestId = ++requestIdRef.current;
    busyRef.current = true;
    setBusy(true);
    setStatus("Getting different replies…");
    const ctx = suggestContext();
    const result = await fetchNewSuggestions({
      profile: settingsRef.current.profile,
      heard: heardRef.current,
      history: historyRef.current,
      provider: settingsRef.current.provider,
      customPrompt: settingsRef.current.customPrompt,
      avoid,
      recognizeMs: recognizeMsRef.current,
      ...ctx,
    });
    if (requestId !== requestIdRef.current) return;
    setBusy(false);
    if (!result.replies) {
      logTiming("suggest", result.ms || 0, result.error || "kept old replies");
      setStatus(`Couldn't get new replies, kept these · ${result.error}`);
      return;
    }
    logTiming("suggest", result.ms || 0, `via ${result.source}`);
    rememberFacts(result.facts);
    rejectedRef.current = avoid;
    setSuggestions(applyAskAgain(
      result.replies,
      ctx.lowConfidence,
      heardRef.current,
      askAgainBackground()
    ));
    setCategory(result.category || "Chat");
    setAiSource(result.source);
    setSelected(-1);
    setRepliesVersion((v) => v + 1);
    setStatus(IDLE_HINT);
  }, []);

  const onHeard = useCallback((payload) => {
    const text = typeof payload === "string" ? payload : payload?.text;
    if (!text) return;
    const confidence = typeof payload === "string" ? 1 : Number(payload.confidence);
    recognizeMsRef.current = typeof payload === "string" ? 0 : Number(payload.recognizeMs) || 0;
    lastActivityRef.current = Date.now();
    heardConfidenceRef.current = Number.isFinite(confidence) ? confidence : 0;
    setHeardConfidence(heardConfidenceRef.current);
    const conf = heardConfidenceRef.current;
    const confLabel = !Number.isFinite(conf) || conf === 0
      ? "confidence unknown"
      : `confidence ${Math.round(conf * 100)}%`;
    logTiming("speech recognition", recognizeMsRef.current, confLabel);
    setHeard(text);
    setInterim("");
    appendTurn("other", text);
    requestReplies(text);
  }, [requestReplies]);
  const onHeardRef = useRef(onHeard);
  onHeardRef.current = onHeard;

  useEffect(() => {
    const listener = createListener({
      onFinal: (payload) => onHeardRef.current(payload),
      onInterim: (text) => {
        lastActivityRef.current = Date.now();
        setInterim(text);
      },
      onError: (err) => setStatus(`Mic: ${err}`),
    });
    listenerRef.current = listener;
    if (listening) listener.start();
    return () => listener.stop();
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (Date.now() - lastActivityRef.current >= SILENCE_MS) {
        endConversation();
      }
    }, 15000);
    return () => clearInterval(id);
  }, [endConversation]);

  useEffect(() => {
    const onHide = () => { endConversation(); };
    window.addEventListener("pagehide", onHide);
    const onVis = () => {
      if (document.visibilityState === "hidden") onHide();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [endConversation]);

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
        setSelected(-1);
        setAiSource("category");
        setRepliesVersion((v) => v + 1);
        setStatus(`${tile.label} phrases`);
        return;
      }
      if (tile.kind === "speak") {
        lastActivityRef.current = Date.now();
        appendTurn("me", tile.label);
        await speakText(tile.label);
        setSelected((current) => (current === index ? -1 : current));
      }
    } finally {
      handlingRef.current = false;
    }
  }, [speakText]);

  const toggleCustomWheel = useCallback(() => {
    if (viewRef.current === "custom") {
      setView("board");
      setSelected(-1);
      setStatus("Replies · hold click for custom phrases");
    } else {
      setView("custom");
      setSelected(-1);
      setStatus("Custom phrases · hold click to go back");
    }
  }, []);

  const onCommand = useCallback(
    (cmd) => {
      if (cmd === "DISCONNECTED") {
        setBleState("off");
        setStatus("Joystick disconnected", true);
        bleRef.current = null;
        return;
      }
      if (cmd === "MIC") {
        toggleListen();
        return;
      }
      if (showSettings || showCustomEditor) return;
      if (cmd === "HOLD") {
        toggleCustomWheel();
        return;
      }
      if (cmd === "SELECT") {
        activate(selectedRef.current);
        return;
      }
      if (cmd === "DOUBLE") {
        refreshReplies();
        return;
      }
      if (settingsRef.current.scanning) return;
      const index = quadrantToIndex(cmd, tilesRef.current.length);
      if (index == null) return;
      setSelected(index);
    },
    [activate, refreshReplies, showSettings, showCustomEditor, toggleCustomWheel, toggleListen]
  );
  commandRef.current = onCommand;

  // Keyboard: arrows + long-press back + Y/N/L shortcuts
  useEffect(() => {
    const dirMap = { ArrowUp: "UP", ArrowDown: "DOWN", ArrowLeft: "LEFT", ArrowRight: "RIGHT" };

    const onKeyDown = (e) => {
      if (showCustomEditor) return;
      if (showSettings && e.key === "Escape") { setShowSettings(false); setCalibrating(false); return; }
      if (showSettings) return;
      if (e.target.closest?.("input, textarea, select")) return;

      if (e.key === "l" || e.key === "L") { e.preventDefault(); toggleListen(); return; }
      if ((e.key === "r" || e.key === "R") && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        if (!e.repeat) refreshReplies();
        return;
      }

      const dir = dirMap[e.key];
      if (dir) { e.preventDefault(); onCommand(dir); return; }

      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        pressTimeRef.current = Date.now();
      }
    };

    const onKeyUp = (e) => {
      if (showCustomEditor || showSettings) return;
      if (e.target.closest?.("input, textarea, select")) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      if (pressTimeRef.current === null) return;

      const elapsed = Date.now() - pressTimeRef.current;
      pressTimeRef.current = null;

      if (elapsed > 700) {
        toggleCustomWheel();
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
  }, [onCommand, showSettings, showCustomEditor, toggleListen, toggleCustomWheel, refreshReplies]);

  async function connectBle() {
    try {
      setBleState("connecting");
      bleRef.current = await connectSpeakEasy((cmd) => commandRef.current?.(cmd), {
        calibration: settingsRef.current.joystickCalibration,
        onSample: (sample) => sampleListenersRef.current.forEach((listener) => listener(sample)),
      });
      setBleState("on");
      setStatus("Joystick connected");
    } catch (err) {
      setBleState("off");
      const raw = String(err?.message || err || "");
      const cancelled = err?.name === "NotFoundError" || /cancell?ed/i.test(raw);
      setStatus(
        cancelled
          ? "Joystick not connected. Click Controller to try again."
          : raw || "Joystick not connected. Click Controller to try again.",
        true
      );
    }
  }

  if (showCustomEditor) {
    return (
      <CustomPhrases
        phrases={settings.custom || []}
        onChange={(phrases) => persist({ ...settings, custom: phrases })}
        onClose={() => setShowCustomEditor(false)}
        onSpeak={speakText}
      />
    );
  }

  return (
    <div className="app">
      {/* Slim caregiver header */}
      <header className="top">
        <div className="top-left">
          <h1>vocabl.</h1>
        </div>
        <div className="caregiver-btns">
          <button type="button" onClick={() => setShowSettings(true)} title="Settings">⚙</button>
        </div>
      </header>

      <div
        className={`main-grid${resizing ? " is-resizing" : ""}`}
        ref={gridRef}
        style={{ "--reply-w": `${replyPanePx}px` }}
      >
        {/* Left pane: wheel */}
        <div className="wheel-pane">
          <div className="wheel-stage">
            <div className="side-controls">
              <button
                type="button"
                className={`side-btn mic-toggle${listening ? " is-on" : ""}`}
                onClick={toggleListen}
                title="Toggle mic (L)"
                aria-pressed={listening}
              >
                <span className="mic-icon" aria-hidden="true">🎙</span>
                <span className="mic-label">{listening ? "Mic On" : "Mic Off"}</span>
                <span className="mic-hint">{listening ? "Listening" : "Click to listen"}</span>
              </button>
              <button
                type="button"
                className={`side-btn side-btn-sm${bleState === "on" ? " is-on" : ""}`}
                onClick={connectBle}
                disabled={!bluetoothSupported() || bleState === "connecting"}
                title="Connect joystick"
                aria-pressed={bleState === "on"}
              >
                <span className="side-icon" aria-hidden="true">🎮</span>
                <span className="side-label">{bleState === "on" ? "Controller on" : "Controller"}</span>
              </button>
              <button
                type="button"
                className="side-btn side-btn-sm"
                onClick={() => setShowCustomEditor(true)}
                title="Edit custom phrases"
              >
                <span className="side-icon" aria-hidden="true">✏</span>
                <span className="side-label">Custom</span>
              </button>
              <label className="vol-control">
                <span className="vol-label">Volume</span>
                <span className="vol-row">
                  <span className="vol-mark" aria-hidden="true">−</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    step="1"
                    value={Math.round((Number(settings.speakVolume) || 0) * 100)}
                    onChange={(e) => {
                      const next = Number(e.target.value) / 100;
                      setSpeakVolume(next);
                      persist({ ...settings, speakVolume: next });
                    }}
                    aria-label="Speaking volume"
                    title={`Speaking volume ${Math.round((Number(settings.speakVolume) || 0) * 100)}%`}
                  />
                  <span className="vol-mark" aria-hidden="true">+</span>
                </span>
              </label>
            </div>
            <div className="wheel-wrap">
              <Wheel
                key={repliesVersion}
                items={tiles}
                selected={selected}
                onChoose={(index) => { setSelected(index); activate(index); }}
                onHover={settings.readOptions && !settings.scanning ? setSelected : undefined}
                onHubSelect={() => activate(selectedRef.current)}
                onHubHold={toggleCustomWheel}
                busy={busy}
                speaking={speaking}
                listening={listening}
                connected={bleState === "on"}
                subscribeSamples={subscribeSamples}
              />
              <div className="meta">
                {speaking && <span className="pill live">Speaking</span>}
                {busy && <span className="pill">Thinking</span>}
                {settings.scanning && <span className="pill live">Scan</span>}
                <span className="pill hint-pill">Hold click = custom</span>
                <span className="pill hint-pill">Double-click = new replies</span>
              </div>
            </div>
          </div>
        </div>

        <button
          type="button"
          className="pane-splitter"
          aria-label="Resize transcript"
          aria-orientation="vertical"
          title="Drag to resize the transcript"
          onPointerDown={onSplitterPointerDown}
        />

        {/* Right pane: heard + replies */}
        <div className="reply-pane">
          <div className="heard-block">
            <p className="heard-label">They said</p>
            <p className="heard-text">
              {interim || heard || <span className="muted">waiting…</span>}
            </p>
            {!interim && isLowConfidence(heardConfidence) && (
              <p className="heard-warn">Low confidence — the mic may have misheard this.</p>
            )}
          </div>

          <section className="chat-log" aria-label="Conversation">
            <p className="heard-label">Conversation</p>
            <ol className="chat-turns" ref={chatLogRef}>
              {turns.length === 0 && (
                <li className="chat-empty">What they say and what you reply will show up here.</li>
              )}
              {turns.map((turn) => (
                <li key={turn.id} className={`chat-turn is-${turn.role}`}>
                  <span className="chat-who">{turn.role === "other" ? "They" : "You"}</span>
                  <p className="chat-text">{turn.text}</p>
                </li>
              ))}
            </ol>
          </section>

          <div className="reply-footer">
            <div className="footer-actions">
              <button
                type="button"
                onClick={refreshReplies}
                disabled={busy || view !== "board"}
                title="New replies (R, or double-click the joystick)"
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
            <p className={`status${statusWarn ? " is-warn" : ""}`}>{status}</p>
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
              <button type="submit" className="primary" disabled={busy || !typedHeard.trim()}>Send</button>
            </form>
          </div>
        </div>
      </div>

      {showSettings && calibrating && (
        <div className="overlay" role="dialog" aria-label="Joystick calibration">
          <CalibrationWizard
            subscribeSamples={subscribeSamples}
            announce={announce}
            onSave={(calibration) => {
              stopPreview();
              persist({ ...settings, joystickCalibration: calibration });
              setCalibrating(false);
              setStatus("Joystick calibration saved");
            }}
            onCancel={() => { stopPreview(); setCalibrating(false); }}
          />
        </div>
      )}

      {showSettings && !calibrating && (
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
                <option value="race">Both at once (faster, costs more)</option>
                <option value="grok">One at a time: Grok, then ChatGPT</option>
                <option value="openai">One at a time: ChatGPT, then Grok</option>
              </select>
            </label>
            <label>
              Voice
              <select value={settings.voice}
                onChange={(e) => persist({ ...settings, voice: e.target.value })}>
                <option value="race">Both at once (faster, costs more)</option>
                <option value="openai">One at a time: ChatGPT, then Grok</option>
                <option value="grok">One at a time: Grok, then ChatGPT</option>
                <option value="browser">Browser speechSynthesis</option>
              </select>
            </label>
            <label className="check">
              <input type="checkbox" checked={settings.readOptions}
                onChange={(e) => persist({ ...settings, readOptions: e.target.checked })} />
              Read options aloud when highlighted
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
            <MemorySettings
              facts={settings.facts || []}
              summaries={settings.summaries || []}
              onChange={({ facts, summaries }) => persist({ ...settings, facts, summaries })}
            />
            <JoystickSettings
              connected={bleState === "on"}
              connecting={bleState === "connecting"}
              canConnect={bluetoothSupported()}
              onConnect={connectBle}
              calibration={settings.joystickCalibration}
              subscribeSamples={subscribeSamples}
              onCalibrate={() => setCalibrating(true)}
              onReset={() => persist({ ...settings, joystickCalibration: null })}
            />
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