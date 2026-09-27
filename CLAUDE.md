# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SpeakEasy Board — an AAC (Augmentative and Alternative Communication) web app for nonverbal people with motor disabilities. A caregiver talks; the app generates 3 short reply options; the user selects one via keyboard, ESP32 joystick over BLE, or touch. The selected phrase is spoken aloud.

## Commands

```bash
npm install          # first-time setup
npm run dev          # start both servers together (Vite + Express proxy)
npm run web          # Vite frontend only (http://localhost:5173)
npm run server       # Express proxy only (http://localhost:8787)
npm run build        # production build
npm run preview      # preview production build
```

There are no tests.

## Environment

Copy `.env.example` → `.env` and fill in keys:

```
XAI_API_KEY=          # xAI / Grok (AI + TTS)
XAI_MODEL=grok-4.6
XAI_TTS_VOICE=eve
OPENAI_API_KEY=       # OpenAI / ChatGPT (AI + TTS)
OPENAI_MODEL=gpt-4o-mini
OPENAI_TTS_VOICE=nova
OPENAI_TTS_MODEL=tts-1
PORT=8787
```

Without keys the app still works using offline reply heuristics (`src/lib/offline.js`).

## Architecture

### Two-process setup
- **Vite dev server** (`localhost:5173`) serves the React app and proxies `/api/*` to the Express server
- **Express proxy** (`localhost:8787`, `server/index.js`) holds the API keys and makes calls to xAI/OpenAI — keeps keys off the browser

### Frontend (`src/`)
- `App.jsx` — single top-level component; owns all state (tiles, listening, speaking, BLE, settings, history)
- `Wheel.jsx` — SVG pie wheel + spoke buttons; purely presentational, receives `items[]`, `selected`, callbacks
- `lib/board.js` — `buildTiles()` maps the current view (`board` vs `categories`) to the tile array; `moveIndex()` handles joystick/arrow navigation
- `lib/ai.js` — calls `/api/suggest`, falls back to `offlineSuggest()` on any error
- `lib/offline.js` — keyword heuristics for AI-free reply generation and category guessing
- `lib/speech.js` — wraps Web Speech API (`SpeechRecognition`) for mic input; `browserSpeak()`/`grokSpeak()` for TTS output; mic is paused while speaking to prevent self-transcription. `previewSpeak()`/`stopPreview()` read the highlighted option aloud when the "Read options aloud" setting (`readOptions`) is on; `App.jsx` uses a hold counter (`holdMic`/`releaseMic`) so the mic stays paused across overlapping previews and replies. `createVoiceCache()` prefetches cloud TTS for the current replies and keeps custom-phrase clips. Voice settings match AI provider: `race` / `openai` / `grok`, plus `browser`. `[timing]` logs cover recognition, `/api/suggest`, and `/api/speak` in the browser console and the Express terminal
- `lib/ble.js` — Web Bluetooth connection to the ESP32 (`SpeakEasy` device); receives `x,y,sw,btn,alt` (or older `x,y,btn[,alt]`) lines. Joystick SW and button A select the hovered reply; button B toggles the mic.
- `lib/calibration.js` — pure geometry: `correct()` turns a raw reading into a corrected position (center → per-direction axis scaling → 16-sector outline correction → mirror/rotation), plus builders used by the wizard
- `lib/joystick.js` — `createDirectionDetector()` picks a direction per movement (steady hold, or peak of a flick; ignores the opposite direction for 150 ms after the stick returns), the click combiner, and the BLE stream parser
- `CalibrationWizard.jsx` / `JoystickSettings.jsx` / `JoystickView.jsx` — guided calibration (center, range, orientation, test) saved to `settings.joystickCalibration`, and the live raw/corrected stick diagram. Without a saved calibration the resting position is measured on each connect
- `lib/storage.js` — persists settings to `localStorage` under `speakeasy-settings-v1`, including `facts` and `summaries`
- `lib/memory.js` — merges learned facts, builds a fallback conversation summary, and injects "Can you say that again?" when speech confidence is below 40% (0 is treated as unknown). The ask-again line replaces the least relevant reply, using the heard phrase plus memory as a background penalty.
- `MemorySettings.jsx` — caregiver editor for facts and past summaries, plus clear-all

### Server (`server/index.js`)
Four endpoints:
- `GET /api/health` — reports which keys are configured
- `POST /api/suggest` — by default races Grok and OpenAI and uses the first valid JSON (`provider: "race"`); sequential fallback is Grok-then-OpenAI or the reverse. Prompt requires all 4 replies to answer the latest utterance; memory is background only. Accepts `facts`, last 3 `summaries`, last 6 history turns, and `lowConfidence`; may return new `facts`
- `POST /api/summarize` — one-sentence conversation summary plus any new facts, used when a conversation ends
- `POST /api/speak` — TTS from ChatGPT (`tts-1` MP3) and/or Grok (MP3 24 kHz / 64 kbps). Body `provider` is `race` (first audio wins), `openai` (ChatGPT then Grok), or `grok` (Grok then ChatGPT). `?stream=1` uses the Grok WebSocket only when provider is `grok`; otherwise it returns the first finished MP3

The server expects the AI to return JSON `{"category":"...","replies":["...","...","...","..."],"facts":[]}`. `extractPayload()` accepts only a known category plus 4 replies. After a few minutes of silence, or when the page hides, the app saves a summary and learned facts.

### Navigation model
Board tiles cycle with arrow keys or BLE joystick commands. `scanning` mode (for users with very limited movement) auto-advances the selection on an interval and requires only SELECT. Both keyboard and BLE map to the same `onCommand(cmd)` handler in `App.jsx`.

Joystick click gestures: a single click is `SELECT` (sent ~400 ms after release, once the double-click window passes), two clicks within 400 ms is `DOUBLE` (fetch 4 new replies that differ from the ones shown; `R` does the same on the keyboard), and holding 700 ms is `HOLD` (custom-phrase wheel).

### Firmware
`firmware/src/main.cpp` — ESP32 BLE Nordic UART. Notify lines are `x,y,sw,btn,alt`. Joystick VRx GPIO14, VRy GPIO12, SW GPIO13 (select, pull-up). Extra buttons GPIO33 (select, pull-up) and GPIO25 (mic toggle, pull-up). Write `SELECT` blinks GPIO 2.

## Browser constraints
- Web Bluetooth and Web Speech API require **Chrome** (desktop, not iOS)
- Speech Recognition requires internet access
- Microphone and Bluetooth permissions must be granted manually on first use
