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
XAI_API_KEY=          # xAI / Grok (primary AI + TTS)
XAI_MODEL=grok-4.6
XAI_TTS_VOICE=eve
OPENAI_API_KEY=       # OpenAI fallback
OPENAI_MODEL=gpt-4o-mini
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
- `lib/speech.js` — wraps Web Speech API (`SpeechRecognition`) for mic input; `browserSpeak()`/`grokSpeak()` for TTS output; mic is paused while speaking to prevent self-transcription
- `lib/ble.js` — Web Bluetooth connection to the ESP32 (`SpeakEasy` device); receives `UP/DOWN/LEFT/RIGHT/SELECT` commands, sends `SELECT` to blink LED on activation
- `lib/storage.js` — persists settings to `localStorage` under `speakeasy-settings-v1`

### Server (`server/index.js`)
Three endpoints:
- `GET /api/health` — reports which keys are configured
- `POST /api/suggest` — calls Grok then OpenAI (or reverse), retries without `reasoning_effort` if Grok rejects it, falls back to 502 if both fail
- `POST /api/speak` — proxies to Grok TTS, returns audio bytes

The server expects the AI to return JSON `{"category":"...","replies":["...","...","..."]}`. `extractPayload()` handles both object and plain-array formats and strips malformed responses.

### Navigation model
Board tiles cycle with arrow keys or BLE joystick commands. `scanning` mode (for users with very limited movement) auto-advances the selection on an interval and requires only SELECT. Both keyboard and BLE map to the same `onCommand(cmd)` handler in `App.jsx`.

### Firmware
`firmware/speakeasy_esp32.ino` — Arduino sketch for the ESP32. BLE service UUID `6e400001-...` (Nordic UART profile). Notify characteristic sends direction strings; write characteristic receives `SELECT` to blink GPIO 2.

## Browser constraints
- Web Bluetooth and Web Speech API require **Chrome** (desktop, not iOS)
- Speech Recognition requires internet access
- Microphone and Bluetooth permissions must be granted manually on first use
