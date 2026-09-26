import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

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

const CATEGORIES = ["Food", "Feelings", "People", "Help", "Chat"];

const SYSTEM_PROMPT = `Write 4 short first-person AAC replies for a nonverbal person.
JSON only: {"category":"Food"|"Feelings"|"People"|"Help"|"Chat","replies":["...","...","...","..."],"facts":[]}
category: Food meals/drink, Feelings mood/pain, People family/staff, Help bathroom/emergency/stop, else Chat.
replies: under 10 words, four different intents — accept, decline, ask or specific, clarify or shift.
Transcripts can be wrong; use history and facts to infer meaning.
If confidence is low, one reply must be exactly: Can you say that again?
facts: only new lasting "label: value" details, else [].`;

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
      const category = normalizeCategory(parsed.category);
      if (replies && category) {
        const facts = (Array.isArray(parsed.facts) ? parsed.facts : [])
          .map((line) => String(line).trim().slice(0, 160))
          .filter(Boolean)
          .slice(0, 8);
        return { replies, category, facts };
      }
    } catch {
      return null;
    }
  }

  return null;
}

function providerName(url) {
  return String(url || "").includes("x.ai") ? "grok" : "openai";
}

async function chatComplete({ url, apiKey, model, messages, extra = {}, signal, json = true }) {
  const body = {
    model,
    messages,
    temperature: 0.8,
    max_tokens: 1000,
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

async function suggestFromProvider(provider, messages, signal) {
  try {
    return await chatComplete({ ...provider, messages, signal });
  } catch (firstErr) {
    if (signal?.aborted) throw firstErr;
    return chatComplete({
      ...provider,
      messages,
      extra: { max_tokens: 1000 },
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
  });
});

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
    lowConfidence ? "Low confidence. One reply must be: Can you say that again?" : "",
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
    extra: { reasoning_effort: "low" },
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

  try {
    let chosen;
    if (race && keyed.length > 1) {
      const controllers = keyed.map(() => new AbortController());
      chosen = await raceValid(
        keyed.map((provider, i) =>
          suggestFromProvider(provider, messages, controllers[i].signal).then((content) => {
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

    console.log(`suggest ok via ${chosen.source}${race && keyed.length > 1 ? " (race)" : ""}`);
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

app.post("/api/speak", async (req, res) => {
  loadEnv();
  const text = String(req.body?.text || "").slice(0, 400);
  if (!text) return res.status(400).json({ error: "text required" });
  const apiKey = envKey("XAI_API_KEY");
  if (!apiKey) {
    return res.status(501).json({ error: "Grok Voice not configured" });
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 25000);
  req.on("close", () => controller.abort());

  try {
    const upstream = await fetch(XAI_TTS_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_id: envKey("XAI_TTS_VOICE") || "eve",
        language: "en",
      }),
    });
    if (!upstream.ok) {
      const detail = await upstream.text();
      return res.status(upstream.status).json({
        error: "Grok TTS failed",
        detail: detail.slice(0, 400),
      });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "audio/mpeg");
    res.send(buf);
  } catch (err) {
    if (req.destroyed) return;
    if (err?.name === "AbortError") {
      if (!res.headersSent) {
        res.status(timedOut ? 504 : 499).json({
          error: timedOut ? "Grok TTS timed out" : "Grok TTS cancelled",
        });
      }
      return;
    }
    res.status(502).json({ error: "Grok TTS failed", detail: String(err.message || err) });
  } finally {
    clearTimeout(timer);
  }
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
