import "dotenv/config";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json({ limit: "32kb" }));

const PORT = Number(process.env.PORT || 8787);
const XAI_URL = "https://api.x.ai/v1/chat/completions";
const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const XAI_TTS_URL = "https://api.x.ai/v1/tts";

const SYSTEM_PROMPT = `You generate replies for a nonverbal person using an AAC communication board.
Return ONLY a JSON array of exactly 4 strings. No markdown, no labels.
Each string is a short first-person spoken reply, under 12 words.
The 4 replies MUST cover different intents, not rewordings:
1) agree / accept
2) decline / not that
3) ask a question back
4) something specific from the profile or what was just said
Sound like a real person, not a robot.`;

function extractReplies(text) {
  if (!text) return null;
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    const cleaned = parsed
      .map((item) => String(item).trim())
      .filter(Boolean)
      .slice(0, 4);
    if (cleaned.length < 4) return null;
    return cleaned.map((line) =>
      line.split(/\s+/).length > 14 ? line.split(/\s+/).slice(0, 12).join(" ") : line
    );
  } catch {
    return null;
  }
}

async function chatComplete({ url, apiKey, model, messages, extra = {} }) {
  const body = {
    model,
    messages,
    temperature: 0.8,
    max_tokens: 220,
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
  res.json({
    ok: true,
    grok: Boolean(process.env.XAI_API_KEY),
    openai: Boolean(process.env.OPENAI_API_KEY),
    grokModel: process.env.XAI_MODEL || "grok-4.6",
    openaiModel: process.env.OPENAI_MODEL || "gpt-4o-mini",
  });
});

app.post("/api/suggest", async (req, res) => {
  const profile = String(req.body?.profile || "").slice(0, 1500);
  const heard = String(req.body?.heard || "").slice(0, 500);
  const history = Array.isArray(req.body?.history) ? req.body.history.slice(-8) : [];
  const preferred = String(req.body?.provider || "grok");

  const userContent = [
    profile ? `User profile:\n${profile}` : "User profile: not provided.",
    history.length ? `Recent conversation:\n${history.join("\n")}` : "No earlier conversation.",
    `The other person just said:\n"${heard}"`,
    "Write the 4 replies now.",
  ].join("\n\n");

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userContent },
  ];

  const grok = {
    url: XAI_URL,
    apiKey: process.env.XAI_API_KEY,
    model: process.env.XAI_MODEL || "grok-4.6",
    extra: { reasoning_effort: "low" },
  };
  const openai = {
    url: OPENAI_URL,
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
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
      const replies = extractReplies(content);
      if (replies) {
        return res.json({
          replies,
          source: provider.url.includes("x.ai") ? "grok" : "openai",
          model: provider.model,
        });
      }
      errors.push("model did not return 4 JSON strings");
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }

  res.status(502).json({
    error: "AI suggest failed",
    detail: errors.join(" | ") || "No API keys configured in .env",
  });
});

app.post("/api/speak", async (req, res) => {
  const text = String(req.body?.text || "").slice(0, 400);
  if (!text) return res.status(400).json({ error: "text required" });
  if (!process.env.XAI_API_KEY) {
    return res.status(501).json({ error: "Grok Voice not configured" });
  }

  try {
    const upstream = await fetch(XAI_TTS_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.XAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        voice_id: process.env.XAI_TTS_VOICE || "eve",
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
  if (!process.env.XAI_API_KEY && !process.env.OPENAI_API_KEY) {
    console.warn("No API keys in .env — the board will use offline replies.");
  }
});
