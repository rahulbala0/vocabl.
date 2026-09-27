import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import WebSocket from "ws";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(rootDir, ".env");

function loadEnv() {
  dotenv.config({ path: envPath, override: true });
}

function envKey(name) {
  return String(process.env[name] || "")
    .trim()
    .replace(/^["']|["']$/g, "");
}

loadEnv();

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 8787);
const XAI_URL = "https://api.x.ai/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const XAI_TTS_URL = "https://api.x.ai/v1/tts";
const XAI_TTS_WS = "wss://api.x.ai/v1/tts";
const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";
const TTS_FORMAT = { codec: "mp3", sample_rate: 24000, bit_rate: 64000 };

const CATEGORIES = ["Food", "Feelings", "People", "Help", "Chat"];

const SYSTEM_PROMPT = `Write 4 short first-person AAC replies for a nonverbal person.
JSON only: {"category":"Food"|"Feelings"|"People"|"Help"|"Chat","replies":["...","...","...","..."],"facts":[]}
category: Food meals/drink, Feelings mood/pain, People family/staff, Help bathroom/emergency/stop, else Chat.
Every reply must directly answer the latest "They said" line. Under 10 words. Most relevant first.
Question: 2-3 plausible answers plus one uncertainty line ("I don't know", "I'm not sure", or "I think …?").
Profile, facts, and earlier talks are background only. Use them only when they directly answer this question. Never raise an unrelated memory topic.
Only include exactly "Can you say that again?" when told confidence is low, as the least relevant of the four. Otherwise never use that phrase.
facts: only new lasting "label: value" details, else [].
Examples:
They said "What's the most populated city?" → ["Tokyo","New York","I think Tokyo?","I don't know"]
They said "Are you hungry?" → ["Yes","No","A little","Maybe later"]
They said "How was your day?" → ["Good","Not great","Tiring","I'll tell you later"]`;

function cleanReplies(parsed) {
  if (!Array.isArray(parsed)) return null;
  const cleaned = parsed
    .map((item) => String(item).trim())
    .filter(Boolean)
    .slice(0, 4);
  if (cleaned.length < 4) return null;
  return cleaned.map((line) =>
    line.split(/\s+/).length > 14 ? line.split(/\s+/).slice(0, 12).join(" ") : line
  );
}

function normalizeCategory(value) {
  const raw = String(value || "").trim().toLowerCase();
  return CATEGORIES.find((name) => name.toLowerCase() === raw) || "";
}

function extractPayload(text) {
  if (!text) return null;

  const objStart = text.indexOf("{");
  const objEnd = text.lastIndexOf("}");
  if (objStart !== -1 && objEnd > objStart) {
    try {
      const parsed = JSON.parse(text.slice(objStart, objEnd + 1));
      const replies = cleanReplies(parsed?.replies);
      if (replies) {
        const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
          .map((line) => String(line).trim().slice(0, 160))
          .filter(Boolean)
          .slice(0, 8);
        return { replies, category: normalizeCategory(parsed.category), facts };
      }
    } catch {
      /* try array form below */
    }
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end <= start) return null;
  try {
    const replies = cleanReplies(JSON.parse(text.slice(start, end + 1)));
    if (!replies) return null;
    return { replies, category: "", facts: [] };
  } catch {
    return null;
  }
}

function providerName(url) {
  return String(url || "").includes("x.ai") ? "grok" : "openai";
}

function logTiming(stage, ms, extra = "") {
  console.log(`[timing] ${stage}: ${Math.round(ms)}ms${extra ? ` · ${extra}` : ""}`);
}

async function chatComplete({ url, apiKey, model, messages, extra = {}, signal, json = true }) {
  const body = {
    model,
    messages,
    temperature: 0.8,
    max_tokens: 400,
    ...extra,
  };
  if (json) body.response_format = { type: "json_object" };
  const res = await fetch(url, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || data?.error || res.statusText;
    throw new Error(`${res.status} ${msg}`);
  }
  return data?.choices?.[0]?.message?.content || "";
}

async function suggestFromProvider(provider, messages, signal, retry = true) {
  try {
    return await chatComplete({ ...provider, messages, signal });
  } catch (firstErr) {
    if (signal?.aborted || !retry) throw firstErr;
    return chatComplete({
      ...provider,
      messages,
      extra: { max_tokens: 400 },
      json: false,
      signal,
    });
  }
}

function raceValid(jobs) {
  return new Promise((resolve, reject) => {
    const errors = [];
    let pending = jobs.length;
    let settled = false;
    if (!pending) {
      reject(new Error("No API keys configured in .env"));
      return;
    }
    for (const job of jobs) {
      job
        .then((value) => {
          if (settled) return;
          if (value) {
            settled = true;
            resolve(value);
            return;
          }
          errors.push("invalid JSON");
          pending -= 1;
          if (!pending) reject(new Error(errors.join(" | ")));
        })
        .catch((err) => {
          if (settled) return;
          if (err?.name === "AbortError") {
            pending -= 1;
            if (!pending) reject(new Error(errors.join(" | ") || "aborted"));
            return;
          }
          errors.push(String(err.message || err));
          pending -= 1;
          if (!pending) reject(new Error(errors.join(" | ")));
        });
    }
  });
}

app.get("/api/health", (_req, res) => {
  loadEnv();
  res.json({
    ok: true,
    grok: Boolean(envKey("XAI_API_KEY")),
    openai: Boolean(envKey("OPENAI_API_KEY")),
    grokModel: envKey("XAI_MODEL") || "grok-4.6",
    openaiModel: envKey("OPENAI_MODEL") || "gpt-4o-mini",
    grokVoice: envKey("XAI_TTS_VOICE") || "eve",
    openaiVoice: envKey("OPENAI_TTS_VOICE") || "nova",
    transcribe: Boolean(envKey("OPENAI_API_KEY")),
  });
});

app.post(
  "/api/transcribe",
  express.raw({
    limit: "8mb",
    type: (req) => /^audio\//.test(String(req.headers["content-type"] || "")),
  }),
  async (req, res) => {
    loadEnv();
    const apiKey = envKey("OPENAI_API_KEY");
    if (!apiKey) {
      res.status(503).json({ error: "No OpenAI key for transcription" });
      return;
    }
    const audio = req.body;
    if (!audio || !audio.length) {
      res.status(400).json({ error: "Missing audio" });
      return;
    }
    const type = String(req.headers["content-type"] || "audio/webm").split(";")[0];
    const ext = type.includes("mp4") ? "mp4" : "webm";
    const form = new FormData();
    form.append("file", new Blob([audio], { type }), `speech.${ext}`);
    form.append("model", "whisper-1");
    form.append("language", "en");
    const t0 = Date.now();
    try {
      const upstream = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const data = await upstream.json().catch(() => ({}));
      if (!upstream.ok) {
        res.status(502).json({ error: data.error?.message || `whisper ${upstream.status}` });
        return;
      }
      const text = String(data.text || "").trim();
      console.log(`[timing] transcribe: ${Date.now() - t0}ms · ${text.slice(0, 60)}`);
      res.json({ text });
    } catch (err) {
      res.status(502).json({ error: String(err.message || err) });
    }
  }
);

app.post("/api/suggest", async (req, res) => {
  loadEnv();
  const profile = String(req.body?.profile || "").slice(0, 1500);
  const heard = String(req.body?.heard || "").slice(0, 500);
  const avoid = (Array.isArray(req.body?.avoid) ? req.body.avoid : [])
    .map((line) => String(line || "").trim().slice(0, 120))
    .filter(Boolean)
    .slice(0, 16);
  if (!heard.trim() && !avoid.length) {
    return res.status(400).json({ error: "heard required" });
  }
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-6) : [];
  const facts = (Array.isArray(req.body?.facts) ? req.body.facts : [])
    .map((line) => String(line || "").trim().slice(0, 160))
    .filter(Boolean)
    .slice(-20);
  const summaries = (Array.isArray(req.body?.summaries) ? req.body.summaries : [])
    .map((item) => (typeof item === "string" ? item : item?.text) || "")
    .map((line) => String(line).trim().slice(0, 220))
    .filter(Boolean)
    .slice(-3);
  const lowConfidence = Boolean(req.body?.lowConfidence);
  const preferred = String(req.body?.provider || "race");
  const customPrompt = String(req.body?.customPrompt || "").slice(0, 2000);
  const userContent = [
    profile.trim() ? `Profile:\n${profile}` : "",
    customPrompt.trim() ? `Caregiver notes:\n${customPrompt}` : "",
    facts.length ? `Facts:\n${facts.map((line) => `- ${line}`).join("\n")}` : "",
    summaries.length ? `Earlier:\n${summaries.map((line) => `- ${line}`).join("\n")}` : "",
    history.length ? `Just now:\n${history.join("\n")}` : "",
    heard.trim() ? `They said:\n"${heard}"` : "They have not spoken yet. Offer openers.",
    "Answer only that last line. Background (profile/facts/earlier) must not introduce a new topic.",
    lowConfidence
      ? "Low confidence. Replace the least relevant reply with exactly: Can you say that again?"
      : "Do not include: Can you say that again?",
    avoid.length ? `Do not repeat:\n${avoid.map((line) => `- ${line}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const grok = {
    url: XAI_URL,
    apiKey: envKey("XAI_API_KEY"),
    model: envKey("XAI_MODEL") || "grok-4.6",
    extra: {},
  };
  const openai = {
    url: OPENAI_URL,
    apiKey: envKey("OPENAI_API_KEY"),
    model: envKey("OPENAI_MODEL") || "gpt-4o-mini",
    extra: {},
  };

  const keyed = [grok, openai].filter((p) => p.apiKey);
  const sequential = preferred === "openai" ? [openai, grok].filter((p) => p.apiKey) : [grok, openai].filter((p) => p.apiKey);
  const race = preferred === "race" || preferred === "both";
  const recognizeMs = Number(req.body?.recognizeMs);
  const suggestStarted = Date.now();

  try {
    let chosen;
    if (race && keyed.length > 1) {
      const controllers = keyed.map(() => new AbortController());
      chosen = await raceValid(
        keyed.map((provider, i) =>
          suggestFromProvider(provider, messages, controllers[i].signal, false).then((content) => {
            const payload = extractPayload(content);
            if (!payload) return null;
            controllers.forEach((c, j) => { if (j !== i) c.abort(); });
            return { payload, source: providerName(provider.url), model: provider.model };
          })
        )
      );
    } else {
      const errors = [];
      for (const provider of sequential) {
        try {
          const content = await suggestFromProvider(provider, messages);
          const payload = extractPayload(content);
          if (payload) {
            chosen = { payload, source: providerName(provider.url), model: provider.model };
            break;
          }
          errors.push(`${providerName(provider.url)}: invalid JSON`);
        } catch (err) {
          errors.push(`${providerName(provider.url)}: ${err.message || err}`);
        }
      }
      if (!chosen) throw new Error(errors.join(" | ") || "No API keys configured in .env");
    }

    const suggestMs = Date.now() - suggestStarted;
    if (Number.isFinite(recognizeMs) && recognizeMs >= 0) {
      logTiming("speech recognition (after talk stopped)", recognizeMs);
    }
    logTiming("suggest", suggestMs, `via ${chosen.source}${race && keyed.length > 1 ? " (race)" : ""}`);
    return res.json({
      replies: chosen.payload.replies,
      category: chosen.payload.category,
      facts: chosen.payload.facts || [],
      source: chosen.source,
      model: chosen.model,
    });
  } catch (err) {
    console.error("suggest failed:", err.message || err);
    res.status(502).json({
      error: "AI suggest failed",
      detail: String(err.message || err),
    });
  }
});

const SUMMARIZE_PROMPT = `You write a one-sentence summary of an AAC conversation and any new lasting facts about the nonverbal user.
Return ONLY JSON:
{"summary":"one sentence","facts":["label: value"]}
The summary is from the user's point of view, under 30 words. facts are only new or updated lasting details (preference, person, routine). If none, use [].`;

app.post("/api/summarize", async (req, res) => {
  loadEnv();
  const profile = String(req.body?.profile || "").slice(0, 1500);
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-12) : [];
  if (history.length < 2) {
    return res.status(400).json({ error: "history required" });
  }
  const facts = (Array.isArray(req.body?.facts) ? req.body.facts : [])
    .map((line) => String(line || "").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 40);

  const messages = [
    { role: "system", content: SUMMARIZE_PROMPT },
    {
      role: "user",
      content: [
        profile ? `User profile:\n${profile}` : "",
        facts.length ? `Facts already stored:\n${facts.map((line) => `- ${line}`).join("\n")}` : "",
        `Conversation:\n${history.join("\n")}`,
        "Write the summary now.",
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
  ];

  const grok = {
    url: XAI_URL,
    apiKey: envKey("XAI_API_KEY"),
    model: envKey("XAI_MODEL") || "grok-4.6",
    extra: { reasoning_effort: "low" },
  };
  const openai = {
    url: OPENAI_URL,
    apiKey: envKey("OPENAI_API_KEY"),
    model: envKey("OPENAI_MODEL") || "gpt-4o-mini",
    extra: {},
  };
  const errors = [];

  for (const provider of [grok, openai]) {
    if (!provider.apiKey) continue;
    try {
      let content;
      try {
        content = await chatComplete({ ...provider, messages, extra: { ...provider.extra, max_tokens: 180 } });
      } catch (firstErr) {
        if (provider.extra?.reasoning_effort) {
          content = await chatComplete({ ...provider, extra: { max_tokens: 180 }, messages });
        } else {
          throw firstErr;
        }
      }
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error("no JSON");
      const parsed = JSON.parse(content.slice(start, end + 1));
      const summary = String(parsed.summary || "").trim().slice(0, 220);
      if (!summary) throw new Error("empty summary");
      const newFacts = (Array.isArray(parsed.facts) ? parsed.facts : [])
        .map((line) => String(line).trim().slice(0, 160))
        .filter(Boolean)
        .slice(0, 8);
      return res.json({ summary, facts: newFacts });
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }

  res.status(502).json({
    error: "AI summarize failed",
    detail: errors.join(" | ") || "No API keys configured in .env",
  });
});

function streamTtsWebsocket({ text, apiKey, voice, signal, onChunk }) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      language: "en",
      voice,
      codec: "mp3",
      optimize_streaming_latency: "1",
    });
    const ws = new WebSocket(`${XAI_TTS_WS}?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    let settled = false;
    let gotAudio = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      try { ws.close(); } catch { /* already closed */ }
      if (err) reject(err);
      else resolve();
    };
    const onAbort = () => {
      finish(Object.assign(new Error("aborted"), { name: "AbortError" }));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "text.delta", delta: text }));
      ws.send(JSON.stringify({ type: "text.done" }));
    });
    ws.on("message", (data) => {
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        return;
      }
      if (event.type === "audio.delta" && event.delta) {
        try {
          gotAudio = true;
          onChunk(Buffer.from(event.delta, "base64"));
        } catch (err) {
          finish(err);
        }
      } else if (event.type === "audio.done") {
        finish();
      } else if (event.type === "error") {
        finish(new Error(event.message || "TTS stream error"));
      }
    });
    ws.on("error", (err) => {
      console.error("TTS websocket error:", err.message || err);
      finish(err);
    });
    ws.on("unexpected-response", (_req, res) => {
      finish(new Error(`TTS websocket ${res.statusCode}`));
    });
    ws.on("close", () => {
      if (!settled) finish(gotAudio ? undefined : new Error("TTS stream closed early"));
    });
  });
}

function normalizeVoiceProvider(raw) {
  const value = String(raw || "").toLowerCase();
  if (value === "both") return "race";
  if (value === "openai" || value === "grok" || value === "race") return value;
  return "openai";
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      }
    );
  });
}

async function openaiTtsBuffer({ text, apiKey, voice, model, signal }) {
  const upstream = await raceAbort(fetch(OPENAI_TTS_URL, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: text,
      voice,
      response_format: "mp3",
    }),
  }), signal);
  if (!upstream.ok) {
    const detail = await upstream.text();
    throw new Error(`openai ${upstream.status} ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await raceAbort(upstream.arrayBuffer(), signal));
}

async function grokTtsBuffer({ text, apiKey, voice, signal }) {
  const upstream = await raceAbort(fetch(XAI_TTS_URL, {
    method: "POST",
    signal,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_id: voice,
      language: "en",
      output_format: TTS_FORMAT,
    }),
  }), signal);
  if (!upstream.ok) {
    const detail = await upstream.text();
    throw new Error(`grok ${upstream.status} ${detail.slice(0, 200)}`);
  }
  return Buffer.from(await raceAbort(upstream.arrayBuffer(), signal));
}

function ttsJobs(text, signal) {
  const grokKey = envKey("XAI_API_KEY");
  const openaiKey = envKey("OPENAI_API_KEY");
  const grokVoice = envKey("XAI_TTS_VOICE") || "eve";
  const openaiVoice = envKey("OPENAI_TTS_VOICE") || "nova";
  const openaiModel = envKey("OPENAI_TTS_MODEL") || "tts-1";
  const jobs = [];
  if (openaiKey) {
    jobs.push({
      name: "openai",
      run: (jobSignal) => openaiTtsBuffer({
        text,
        apiKey: openaiKey,
        voice: openaiVoice,
        model: openaiModel,
        signal: jobSignal || signal,
      }),
    });
  }
  if (grokKey) {
    jobs.push({
      name: "grok",
      run: (jobSignal) => grokTtsBuffer({
        text,
        apiKey: grokKey,
        voice: grokVoice,
        signal: jobSignal || signal,
      }),
    });
  }
  return jobs;
}

function orderedTtsJobs(provider, jobs) {
  if (provider === "grok") {
    return [...jobs].sort((a, b) => (a.name === "grok" ? -1 : b.name === "grok" ? 1 : 0));
  }
  if (provider === "openai") {
    return [...jobs].sort((a, b) => (a.name === "openai" ? -1 : b.name === "openai" ? 1 : 0));
  }
  return jobs;
}

function raceTts(jobs, parentSignal) {
  return new Promise((resolve, reject) => {
    const controllers = jobs.map(() => new AbortController());
    const errors = [];
    let pending = jobs.length;
    let settled = false;
    const abortChildren = () => controllers.forEach((c) => c.abort());
    if (!pending) {
      reject(new Error("No TTS keys configured in .env"));
      return;
    }
    if (parentSignal?.aborted) {
      abortChildren();
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      return;
    }
    parentSignal?.addEventListener("abort", abortChildren, { once: true });
    jobs.forEach((job, i) => {
      job.run(controllers[i].signal)
        .then((buf) => {
          if (settled) return;
          settled = true;
          controllers.forEach((c, j) => { if (j !== i) c.abort(); });
          parentSignal?.removeEventListener("abort", abortChildren);
          resolve({ buf, provider: job.name });
        })
        .catch((err) => {
          if (settled) return;
          if (err?.name !== "AbortError") errors.push(String(err.message || err));
          pending -= 1;
          if (!pending) {
            parentSignal?.removeEventListener("abort", abortChildren);
            reject(new Error(errors.join(" | ") || "aborted"));
          }
        });
    });
  });
}

async function speakBuffer({ text, provider, signal }) {
  const jobs = orderedTtsJobs(provider, ttsJobs(text, signal));
  if (!jobs.length) throw new Error("No TTS keys configured in .env");
  if (provider === "race" && jobs.length > 1) {
    return raceTts(jobs, signal);
  }
  const errors = [];
  for (const job of jobs) {
    try {
      const buf = await job.run(signal);
      return { buf, provider: job.name };
    } catch (err) {
      if (err?.name === "AbortError") throw err;
      errors.push(String(err.message || err));
    }
  }
  throw new Error(errors.join(" | "));
}

app.post("/api/speak", async (req, res) => {
  loadEnv();
  const text = String(req.body?.text || "").slice(0, 400);
  if (!text) return res.status(400).json({ error: "text required" });
  const provider = normalizeVoiceProvider(req.body?.provider);
  const jobs = ttsJobs(text);
  if (!jobs.length) {
    return res.status(501).json({ error: "Voice not configured" });
  }

  const speakStarted = Date.now();
  console.log(`[speak] start ${provider} · ${text.slice(0, 40)}`);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 25000);
  res.on("close", () => {
    if (!res.writableEnded) controller.abort();
  });

  const grokKey = envKey("XAI_API_KEY");
  const grokVoice = envKey("XAI_TTS_VOICE") || "eve";
  const wantStream = String(req.query.stream || "") === "1";

  try {
    if (wantStream && provider === "grok" && grokKey) {
      try {
        res.setHeader("Content-Type", "audio/mpeg");
        res.setHeader("Cache-Control", "no-store");
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        await streamTtsWebsocket({
          text,
          apiKey: grokKey,
          voice: grokVoice,
          signal: controller.signal,
          onChunk: (chunk) => {
            if (!res.writableEnded) res.write(chunk);
          },
        });
        logTiming("speak", Date.now() - speakStarted, `grok stream · ${text.slice(0, 40)}`);
        if (!res.writableEnded) res.end();
        return;
      } catch (err) {
        if (err?.name === "AbortError") throw err;
        if (!res.headersSent) {
          console.error("TTS websocket failed, falling back to REST:", err.message || err);
        } else {
          throw err;
        }
      }
    }

    const { buf, provider: used } = await speakBuffer({
      text,
      provider,
      signal: controller.signal,
    });
    logTiming("speak", Date.now() - speakStarted, `${used} · ${text.slice(0, 40)}`);
    res.setHeader("Content-Type", "audio/mpeg");
    res.send(buf);
  } catch (err) {
    if (req.destroyed) return;
    if (err?.name === "AbortError") {
      if (!res.headersSent) {
        res.status(timedOut ? 504 : 499).json({
          error: timedOut ? "TTS timed out" : "TTS cancelled",
        });
      } else if (!res.writableEnded) {
        res.end();
      }
      return;
    }
    if (!res.headersSent) {
      res.status(502).json({ error: "TTS failed", detail: String(err.message || err) });
    } else if (!res.writableEnded) {
      res.end();
    }
  } finally {
    clearTimeout(timer);
  }
});

app.post("/api/timing", (req, res) => {
  const stage = String(req.body?.stage || "").slice(0, 80);
  const ms = Number(req.body?.ms);
  const extra = String(req.body?.extra || "").slice(0, 120);
  if (!stage || !Number.isFinite(ms)) return res.status(204).end();
  // Suggest + recognition are already printed when /api/suggest finishes.
  if (stage === "suggest" || stage.startsWith("speech recognition")) {
    return res.status(204).end();
  }
  logTiming(stage, ms, extra);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`SpeakEasy proxy on http://127.0.0.1:${PORT}`);
  console.log(`Reading env from ${envPath}`);
  if (!envKey("XAI_API_KEY") && !envKey("OPENAI_API_KEY")) {
    console.warn("No API keys in .env — the board will use offline replies.");
  } else {
    console.log(
      `Keys loaded: grok=${Boolean(envKey("XAI_API_KEY"))} openai=${Boolean(envKey("OPENAI_API_KEY"))}`
    );
  }
});
