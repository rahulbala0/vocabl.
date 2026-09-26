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

const SYSTEM_PROMPT = `You generate replies for a nonverbal person using an AAC communication board.
Return ONLY JSON, no markdown, no labels:
{"category":"Food"|"Feelings"|"People"|"Help"|"Chat","replies":["...","...","...","..."],"facts":["label: value"]}
Pick category from what the other person just said:
- Food: eating, drinking, meals, hunger, thirst
- Feelings: mood, pain, energy, how they are
- People: family, friends, staff, who is present
- Help: bathroom, emergency, position, discomfort, stop
- Chat: anything else, small talk, choices, general talk
Each reply is a short first-person spoken line, under 10 words.
The 4 replies MUST cover different intents, not rewordings:
1) agree / accept
2) decline / not that
3) ask a question back or something specific from the profile or remembered facts
4) a neutral, clarifying, or topic-shifting response
The transcript may contain speech-recognition mistakes. Use the conversation history, remembered facts, and any alternative transcripts to work out what was most likely meant, then reply to that meaning.
If speech-recognition confidence is marked low, one of the 4 replies MUST be exactly: Can you say that again?
If you learn a lasting fact about the user (preference, person, routine), add it to "facts" as a short "label: value" string. Only new or updated facts, not ones already listed. If nothing new, use "facts":[].
Sound like a real person, not a robot.`;

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
      /* fall through to array format */
    }
  }

  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const replies = cleanReplies(JSON.parse(text.slice(start, end + 1)));
    if (!replies) return null;
    return { replies, category: "", facts: [] };
  } catch {
    return null;
  }
}

async function chatComplete({ url, apiKey, model, messages, extra = {} }) {
  const body = {
    model,
    messages,
    temperature: 0.8,
    max_tokens: 280,
    ...extra,
  };
  const res = await fetch(url, {
    method: "POST",
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
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
  const facts = (Array.isArray(req.body?.facts) ? req.body.facts : [])
    .map((line) => String(line || "").trim().slice(0, 160))
    .filter(Boolean)
    .slice(0, 40);
  const summaries = (Array.isArray(req.body?.summaries) ? req.body.summaries : [])
    .map((item) => (typeof item === "string" ? item : item?.text) || "")
    .map((line) => String(line).trim().slice(0, 220))
    .filter(Boolean)
    .slice(-8);
  const alternatives = (Array.isArray(req.body?.alternatives) ? req.body.alternatives : [])
    .map((item) => ({
      text: String(item?.text || item || "").trim().slice(0, 200),
      confidence: Number(item?.confidence),
    }))
    .filter((item) => item.text)
    .slice(0, 5);
  const lowConfidence = Boolean(req.body?.lowConfidence);
  const preferred = String(req.body?.provider || "grok");
  const customPrompt = String(req.body?.customPrompt || "").slice(0, 2000);

  const altLines = alternatives
    .map((item) => {
      const pct = Number.isFinite(item.confidence) ? ` (${Math.round(item.confidence * 100)}%)` : "";
      return `- "${item.text}"${pct}`;
    })
    .join("\n");

  const userContent = [
    profile ? `User profile:\n${profile}` : "User profile: not provided.",
    customPrompt ? `Custom instructions from the caregiver:\n${customPrompt}` : "",
    facts.length ? `Remembered facts about the user:\n${facts.map((line) => `- ${line}`).join("\n")}` : "",
    summaries.length ? `Recent conversation summaries:\n${summaries.map((line) => `- ${line}`).join("\n")}` : "",
    history.length ? `Recent conversation:\n${history.join("\n")}` : "No earlier conversation.",
    heard.trim()
      ? `The other person just said (top speech-recognition guess):\n"${heard}"`
      : "Nobody has said anything yet. Offer general conversation openers.",
    altLines
      ? `Other speech-recognition alternatives (the transcript may be wrong; pick the meaning that fits history and memory):\n${altLines}`
      : "",
    lowConfidence
      ? "Speech-recognition confidence is low. One of the 4 replies MUST be exactly: Can you say that again?"
      : "",
    avoid.length
      ? `The user rejected these replies. Do NOT repeat or reword any of them; give 4 clearly different options:\n${avoid.map((line) => `- ${line}`).join("\n")}`
      : "",
    "Classify the moment into one category, then write the 4 replies now.",
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

  const order = preferred === "openai" ? [openai, grok] : [grok, openai];
  const errors = [];

  for (const provider of order) {
    if (!provider.apiKey) continue;
    try {
      let content;
      try {
        content = await chatComplete({ ...provider, messages });
      } catch (firstErr) {
        if (provider.extra?.reasoning_effort) {
          content = await chatComplete({
            ...provider,
            extra: {},
            messages,
          });
        } else {
          throw firstErr;
        }
      }
      const payload = extractPayload(content);
      if (payload) {
        console.log(`suggest ok via ${provider.url.includes("x.ai") ? "grok" : "openai"}`);
        return res.json({
          replies: payload.replies,
          category: payload.category,
          facts: payload.facts || [],
          source: provider.url.includes("x.ai") ? "grok" : "openai",
          model: provider.model,
        });
      }
      errors.push("model did not return 4 JSON strings");
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }

  console.error("suggest failed:", errors.join(" | ") || "No API keys configured in .env");
  res.status(502).json({
    error: "AI suggest failed",
    detail: errors.join(" | ") || "No API keys configured in .env",
  });
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

  try {
    const upstream = await fetch(XAI_TTS_URL, {
      method: "POST",
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
    res.status(502).json({ error: "Grok TTS failed", detail: String(err.message || err) });
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
