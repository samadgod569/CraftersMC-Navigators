# Nyxo Code

> AI coding agent CLI — powered by **NyxoAI** or **any custom worker API**.

---

## Features

- 🤖 **Dual API support** — NyxoAI (native) or your own worker endpoint (`?question=`)
- 🧠 **Recall memory** — AI auto-saves tokens, API keys, and preferences to `recall.txt`
- 🛠️ **Skills injection** — Create `skills.txt` to define custom AI behaviors per project
- 🔧 **MCP tool support** — File read/write, shell commands, web tools
- 💬 **Interactive REPL** + one-shot `run` mode

---

## Install

```bash
bash install.sh
```

---

## Quick Start

```bash
nyxo          # Start interactive session (prompts for setup on first run)
nyxo config   # Switch API backend at any time
nyxo run "refactor src/index.ts to use async/await"
```

---

## API Backends

### NyxoAI (default)
Uses the official NyxoAI API with an API key + model key.

```bash
nyxo config
# → Choose "NyxoAI"
# → Enter your API Key
# → Enter your Model Key (e.g. mistralai/Mistral-7B-Instruct-v0.2)
```

### Custom Worker API
Use your own worker endpoint where the API key is already baked in server-side.
Questions are sent as a GET request: `GET <your-url>?question=<full prompt>`.

```bash
nyxo config
# → Choose "Custom Worker"
# → Enter your worker URL (e.g. https://my-worker.example.com/ai)
```

The full prompt — including recall memory, skills, conversation history, and your message — is sent as the `question` parameter. Your worker handles authentication.

You can also pass the worker URL inline:
```bash
nyxo run -w https://my-worker.example.com/ai "explain this codebase"
nyxo chat -w https://my-worker.example.com/ai
```

---

## Recall Memory (`recall.txt`)

Nyxo Code remembers things across sessions using `~/.nyxo/recall.txt`.

**How it works:**
- Tell the AI something once → it stores it → never asks again
- The AI uses the syntax `[[RECALL:key=value]]` in its response to save data silently
- Recall is injected into every prompt automatically

**Example:**
```
You: My GitHub token is ghp_abc123
AI:  Got it, I'll remember that.     ← silently writes [[RECALL:github_token=ghp_abc123]]

# Next session — no need to tell it again
You: Push this to GitHub
AI:  (uses github_token from recall automatically)
```

**CLI commands:**
```bash
nyxo recall          # View all saved recall entries
nyxo recall --clear  # Clear all recall memory
# Or in REPL:
/recall              # View recall
/recall clear        # Clear recall
```

**Manual editing** — open `~/.nyxo/recall.txt` in any editor. Format: `key=value`, one per line.

---

## Skills (`skills.txt`)

Define custom behaviors the AI follows on every message.

**Create the file:**
```bash
# Project-specific (takes priority):
nano ./skills.txt

# Global fallback:
nano ~/.nyxo/skills.txt
```

**Example `skills.txt`:**
```
Always reply in a concise, direct style.
When writing code, always include error handling.
Prefer TypeScript over JavaScript for new files.
My project uses pnpm, not npm or yarn.
Always run tests after making changes.
```

The AI reads this on every message. No restart needed — it's loaded fresh each turn.

View loaded skills in REPL: `/skills`

---

## REPL Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/recall` | View recall memory |
| `/recall clear` | Clear recall memory |
| `/skills` | Show loaded skills.txt |
| `/api` | Show current API backend |
| `/model <key>` | Switch model (NyxoAI mode) |
| `/history` | Show session history |
| `/actions` | Show this session's action log |
| `/mcp` | Show connected MCP servers |
| `/clear` | Clear terminal |
| `/exit` | Exit and save session |

---

## Config Files

| File | Location | Managed by |
|------|----------|------------|
| `config.json` | `~/.nyxo/config.json` | Nyxo Code (API key, model, worker URL) |
| `recall.txt` | `~/.nyxo/recall.txt` | AI auto-writes, user can edit |
| `skills.txt` | `./skills.txt` or `~/.nyxo/skills.txt` | User creates manually |
| `history.json` | `~/.nyxo/history.json` | Nyxo Code (session history) |

---

## Environment Variables

```bash
NYXO_API_KEY=...        # NyxoAI API key
NYXO_MODEL=...          # Model key
NYXO_WORKER_URL=...     # Custom worker URL (overrides config)
```
