# ADR 0048 — DeepSeek: reasoning replay and cache usage

Date: 2026-11-17. Status: implemented; live requests **Needs verification**
(`FUTRYN_LIVE_DEEPSEEK=1` is reserved for a live test; none is run by default).

Evidence: OpenCode @0ac0d7e `packages/ai/src/protocols/openai-chat.ts` always replays assistant
`reasoning_content` for DeepSeek and reads `prompt_cache_hit_tokens`.

- Preset `deepseek`: `https://api.deepseek.com`, `chat`, API key, 15 minute stream idle timeout,
  `replayReasoning`.
- Contract: assistant messages with tool calls may carry `reasoning` (already redacted by
  `redactModel`; persisted in the message `parts`; never rendered again). The adapter sends it
  back as `reasoning_content` only when the provider has `replayReasoning` (preset or
  `replay_reasoning = true` in config.toml).
- Usage: `prompt_cache_hit_tokens` counts as cache reads when `prompt_tokens_details.cached_tokens`
  is absent.
