# In-office AI assistant

NexSpace has a built-in **🤖 Assistant** you talk to from chat. In any chat scope (Nearby / Floor /
#channel / DM), type:

```
@ai summarize the last few messages
@ai what's a good agenda for a 30-min standup?
@ai draft quick notes for this meeting
```

…or click the **🤖** button next to the chat input (it prefixes `@ai` for you). The assistant replies in
the same scope, so the room sees the answer. It has the **recent room chat** as context, so "summarize"
and "take notes" work.

## Enable it for FREE (recommended: Google Gemini)

The most generous free option is **Google Gemini** — ~**1,500 requests/day, no credit card, no expiry**.

1. Go to **https://aistudio.google.com/apikey** (sign in with a Google account) → **Create API key**. Copy it.
2. In **Render → your service → Environment**, add:
   ```
   GEMINI_API_KEY=AIza...
   ```
   Save → it redeploys. That's it — type `@ai hello` in chat.

Set **one** key. The server auto-detects the provider; if several are set it prefers Anthropic, then OpenAI, then Gemini:

```
GEMINI_API_KEY=AIza...            # FREE — recommended (Google AI Studio)
# ANTHROPIC_API_KEY=sk-ant-...    # paid
# OPENAI_API_KEY=sk-...           # paid
# AI_MODEL=gemini-2.5-flash       # optional override (defaults per provider)
```

Other good free tiers if you prefer: **Groq** (https://console.groq.com — fast, ~1,000 req/day) and
**OpenRouter** free models (https://openrouter.ai) — both are OpenAI-compatible, so set `OPENAI_API_KEY`
to that provider's key **and** point `AI_MODEL` at one of their model names. (Gemini is the simplest.)

- Without any key, `@ai` still works but replies "I'm not enabled yet" — nothing breaks.
- A small/fast model is used by default to stay within free limits. There's a ~3s per-user cooldown to avoid spam.

## Cost & privacy notes
- Each `@ai` is one API call billed to **your** key (the cheap default models are fractions of a cent each).
- The request includes the **recent room chat** on that floor as context so summaries work — don't enable it
  in spaces where that's sensitive, or clear the context expectations with your team.
- The key lives only in the server environment; it's never sent to clients.
