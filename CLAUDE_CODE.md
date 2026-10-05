# Running mindcraft on Claude Code

This fork can get its answers from [Claude Code](https://code.claude.com) instead of a model API. You don't need API keys: requests go through whatever account Claude Code is logged into (a Pro/Max subscription or an API key).

There are two ways to connect:

| | `claude-code` (headless, the default) | `claude-mcp` (MCP bridge) |
|---|---|---|
| How it works | Each bot prompt runs `claude -p` once | Bots queue prompts on a local MCP server; a Claude Code session you keep open picks them up and answers them |
| Setup | Install Claude Code and log in | Install Claude Code, start the bridge, add it as an MCP server, and leave a session running |
| Latency | About 3–10 s per reply (CLI startup plus the model) | Depends on how fast the session loops |
| Context | Every request starts fresh, as with an API | Every request builds up in one session; Claude Code compacts it automatically |
| Good for | Normal play, several bots | Watching or steering the bots from a Claude Code session |

## Requirements

1. Install Claude Code and log in once by running `claude` in a terminal.
2. Make sure `claude` is on your `PATH`, or set `CLAUDE_CODE_PATH` (or `params.claude_path` in a profile) to the executable.
3. Run `npm install` as usual. You can leave `keys.json` empty for Claude Code models.

## Mode 1: headless `claude-code`

`andy.json` already uses it:

```json
{ "name": "andy", "model": "claude-code" }
```

Pick a model and settings:

```json
{
    "name": "andy",
    "model": {
        "model": "claude-code/sonnet",
        "params": { "effort": "low" }
    }
}
```

- The `model` is `claude-code` (Claude Code's default model) or `claude-code/<model>`, where `<model>` is any value `claude --model` accepts: `sonnet`, `opus`, `haiku`, `fable`, or a full model ID.
- These `params` are optional:
  - `effort`: `low` | `medium` | `high` | `xhigh` | `max`. Lower is faster, and `low` suits chatting in game.
  - `fallback_model`: the model to use when the main one is overloaded.
  - `max_budget_usd`: a spending cap per request (API-key billing only).
  - `timeout_ms`: default `180000`.
  - `claude_path`: the path to the `claude` executable.
  - `extra_args`: an array of extra `claude` CLI flags.

Each request runs `claude -p` with mindcraft's system prompt, no Claude Code tools, no MCP servers, and no saved session. The bot acts only through the `!commands` in its reply, just as it does with an API model. Chat history is passed in as a transcript, and screenshots (with `allow_vision`) are passed as images.

You can also give `code_model` or `vision_model` a Claude Code model, for example `"code_model": "claude-code/opus"`.

## Mode 2: MCP bridge (`claude-mcp`)

1. Start the bridge. It listens on `127.0.0.1:7790`, and you can change the port with `MINDCRAFT_BRIDGE_PORT` or `--port`:

   ```bash
   npm run claude-bridge
   ```

2. Add it to Claude Code once:

   ```bash
   claude mcp add --transport http mindcraft http://127.0.0.1:7790/mcp
   ```

3. Start a Claude Code session that may call the bridge's tools without asking, and give it the loop prompt:

   ```bash
   claude --allowedTools "mcp__mindcraft__wait_for_request,mcp__mindcraft__respond"
   ```

   Then in that session run:

   ```
   /mcp__mindcraft__drive
   ```

4. Use a profile with `"model": "claude-mcp"` (see `profiles/claude-mcp.json`), add it to `settings.js`, and run `node main.js`.

The bridge provides two tools:

- `wait_for_request`: waits up to 50 s for the next bot prompt and returns the bot's name, its system prompt, its conversation, and any screenshot.
- `respond(request_id, text)`: sends the reply back to the bot.

The `drive` prompt tells Claude Code to repeat those two calls until you interrupt it. If nothing answers within `params.timeout_ms` (default 300 s), the bot gets "My brain disconnected, try again." and continues. `GET http://127.0.0.1:7790/` shows queued and in-flight requests.

If the bridge runs somewhere else, set `"url"` in the profile or `MINDCRAFT_BRIDGE_URL`.

## Notes

- Claude has no embedding model. Example and skill-doc selection falls back to word overlap, as it already did for the `claude` profiles that had no `embedding` set. To use embeddings, set `"embedding"` to another provider.
- `claude -p` sees your user-level `~/.claude/CLAUDE.md` and settings, such as hooks. It runs from an empty temp directory, so project `CLAUDE.md` files are ignored.
- The API providers (`claude`, `gpt`, and the rest) are unchanged. Set a profile's `model` back to one of them to use the API again.

## Files

- `src/models/claude_code.js` is the headless provider (prefix `claude-code`).
- `src/models/claude_code_mcp.js` is the bot-side bridge client (prefix `claude-mcp`).
- `services/claude_mcp_bridge/server.js` is the MCP bridge server.
- `src/utils/claude_code_format.js` turns mindcraft's turns into a single Claude Code prompt.
