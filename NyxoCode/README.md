# ◉ Nyxo Code

**AI Agent CLI powered by NyxoAI** — reads files, writes code, runs commands, thinks step by step.

```
        · · ·
      · ▓▓ ·       ███╗   ██╗██╗   ██╗██╗  ██╗ ██████╗
    ·  ░(*)░  ·     ████╗  ██║╚██╗ ██╔╝╚██╗██╔╝██╔═══██╗
   /~~◉~~~~◉~~\    ██╔██╗ ██║ ╚████╔╝  ╚███╔╝ ██║   ██║
  |  \  ✦  /  |    ██║╚██╗██║  ╚██╔╝   ██╔██╗ ██║   ██║
   \~~◉~~~~◉~~/     ██║ ╚████║   ██║   ██╔╝ ██╗╚██████╔╝
    ·  ░·░  ·       ╚═╝  ╚═══╝   ╚═╝   ╚═╝  ╚═╝ ╚═════╝
      · · ·          C O D E  v1.0.0
```

---

## Install

```bash
npm install -g nyxo-code
# or run locally:
npm install
npm link
```

## Setup

```bash
nyxo config
# Enter your NyxoAI API key and model key
```

Or set environment variables:
```bash
export NYXO_API_KEY=your_key_here
export NYXO_MODEL=mistralai/Mistral-7B-Instruct-v0.2
```

---

## Usage

### Interactive chat (default)
```bash
nyxo
```

### One-shot message
```bash
nyxo run "refactor my index.js to use async/await"
nyxo "explain what this codebase does"   # shorthand
```

### Commands inside chat

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/history` | View past sessions |
| `/actions` | View this session's action log |
| `/model <key>` | Switch model |
| `/cwd` | Show working directory |
| `/clear` | Clear screen |
| `/exit` | Exit and save session |

---

## What It Can Do

Nyxo Code uses an **agentic loop** — it reads your message, decides if it needs to use tools, executes them, then responds. It can:

- **Read files** — `src/index.js`, any path
- **Write & create files** — full file creation with directory creation
- **Append to files** — add to existing content
- **Delete files** — safely
- **List directories** — with a clean tree view, filtering out noise
- **Run shell commands** — `npm install`, `git log`, `python script.py`, etc.
- **Search files** — glob patterns like `**/*.ts`
- **Grep in files** — find patterns in specific files

### Example prompts

```
> explain this codebase and what each file does
> find all TODO comments in the src folder
> create a new Express route for user authentication
> run the tests and fix any failures
> refactor this function to be cleaner
> what does the package.json say our dependencies are?
```

---

## Smart Context Management

Nyxo Code is designed to **not overload the AI**:

- Only the last 6 conversation turns are sent each time
- File contents are capped at 8,000 chars (with a truncation notice)
- Command output is capped at 4,000 chars
- Tool results are capped at 3,000 chars when fed back
- Long assistant responses in history are truncated to 1,200 chars

---

## File Structure

```
nyxo-code/
├── bin/
│   └── nyxo.js          ← CLI entry point & REPL
├── src/
│   ├── agent.js         ← Agentic loop (tool call → execute → loop)
│   ├── api.js           ← NyxoAI API client
│   ├── ascii.js         ← Logo & branding
│   ├── config.js        ← ~/.nyxo/config.json management
│   ├── context.js       ← Lean prompt builder
│   ├── history.js       ← Session & persistent history
│   ├── setup.js         ← First-time setup wizard
│   ├── tools.js         ← readFile, writeFile, runCommand, etc.
│   └── ui.js            ← Terminal output formatting
├── package.json
└── README.md
```

---

## Config Location

Config and history are stored in `~/.nyxo/`:

```
~/.nyxo/
├── config.json    ← API key, model key
└── history.json   ← Past session summaries
```

---

## License

MIT
