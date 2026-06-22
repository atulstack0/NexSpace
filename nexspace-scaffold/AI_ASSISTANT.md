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

## Enable it (one env var)

The assistant calls an LLM, so it needs an API key. Set **one** of these in **Render → your service →
Environment** (or locally in `apps/api/.env`), then it redeploys:

```
# Anthropic (preferred if both are set)
ANTHROPIC_API_KEY=sk-ant-...
# or OpenAI
OPENAI_API_KEY=sk-...
# optional — override the model (defaults: claude-3-5-haiku-latest / gpt-4o-mini)
AI_MODEL=claude-3-5-haiku-latest
```

- Get a key: Anthropic → https://console.anthropic.com  ·  OpenAI → https://platform.openai.com
- Without a key, `@ai` still works but replies "I'm not enabled yet" — nothing breaks.
- A small/cheap model is used by default to keep costs low. There's a ~3s per-user cooldown to avoid spam.

## Cost & privacy notes
- Each `@ai` is one API call billed to **your** key (the cheap default models are fractions of a cent each).
- The request includes the **recent room chat** on that floor as context so summaries work — don't enable it
  in spaces where that's sensitive, or clear the context expectations with your team.
- The key lives only in the server environment; it's never sent to clients.
