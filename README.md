# mindcraft, on Claude Code

A port of [mindcraft](https://github.com/mindcraft-bots/mindcraft) (MIT) in which the Minecraft bots get their replies from **Claude Code** instead of a model API, so you don't need API keys. Everything else is upstream mindcraft, so see its README for general docs.

## What changed

- **`claude-code` model** (`src/models/claude_code.js`): every bot prompt runs headless `claude -p` and signs in with your Claude Code login. `andy.json` uses it by default.
- **`claude-mcp` model** (`src/models/claude_code_mcp.js` + `services/claude_mcp_bridge/`): a local MCP server that bots send their prompts to. A Claude Code session you keep open answers them.
- Example profiles are in `profiles/claude-code.json` and `profiles/claude-mcp.json`.

The original API providers still work if you set a profile's `model` back to one of them.

## Run

You need Node 18 or 20, Minecraft Java Edition, and [Claude Code](https://code.claude.com) installed and logged in. To log in, run `claude` once.

```bash
npm install
node main.js
```

Before running `node main.js`, open a Minecraft world to LAN on port `55916`. You can change the port in `settings.js`.

To pick a model, edit `andy.json`:

```json
{ "name": "andy", "model": "claude-code/sonnet" }
```

`claude-code` on its own uses Claude Code's default model. You can also name any model `claude --model` accepts, such as `haiku`, `opus` or a full model ID. These optional profile `params` are available: `effort`, `timeout_ms`, `claude_path` and `extra_args`.

### Optional: MCP bridge mode

```bash
npm run claude-bridge                                                    # 1. start the bridge
claude mcp add --transport http mindcraft http://127.0.0.1:7790/mcp      # 2. once
claude --allowedTools "mcp__mindcraft__wait_for_request,mcp__mindcraft__respond"
#    then type /mcp__mindcraft__drive inside that session                # 3.
```

Then set the bot's model to `"claude-mcp"` and run `node main.js`. Headless mode is more reliable for long sessions, because the bridge session's context fills up over time.

## Caveats

- Each reply takes about 3–10 s in headless mode.
- Claude has no embedding model, so mindcraft uses word overlap to pick examples.
- `claude -p` still loads your personal `~/.claude/CLAUDE.md` and hooks.
- Don't enable `allow_insecure_coding` on public servers.
