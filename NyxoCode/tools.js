// src/tools.js
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// Safety limits
const MAX_FILE_READ = 8000;   // chars — keeps context lean
const MAX_CMD_OUTPUT = 4000;  // chars
const MAX_DIR_ENTRIES = 80;

// ─── Tool Definitions (sent to AI as a short schema) ──────────────────────────

const TOOL_SCHEMA = `
You have these tools. Call ONE at a time using this EXACT format:

<tool_call>
{
  "tool": "TOOL_NAME",
  "args": { ...args }
}
</tool_call>

TOOLS:
- readFile(path)           → Read a file's contents
- writeFile(path, content) → Write/overwrite a file
- appendFile(path, content)→ Append to a file
- deleteFile(path)         → Delete a file
- listDir(path?)           → List directory (default: current dir)
- runCommand(cmd)          → Run a shell command (be careful)
- searchFiles(pattern, dir?)→ Find files matching glob pattern
- grepInFile(pattern, path)→ Search text in a file

After receiving a tool result, either call another tool or give your FINAL ANSWER.
When done, write your response normally (no tool_call block).
`.trim();

// ─── Tool Implementations ─────────────────────────────────────────────────────

function readFile(args) {
  const { path: filePath } = args;
  if (!filePath) return "Error: path required";
  try {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) return `Error: File not found: ${filePath}`;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) return `Error: ${filePath} is a directory, use listDir`;
    const content = fs.readFileSync(abs, "utf-8");
    if (content.length > MAX_FILE_READ) {
      return (
        content.slice(0, MAX_FILE_READ) +
        `\n\n[...TRUNCATED — ${content.length - MAX_FILE_READ} more chars. Ask to read a specific section if needed.]`
      );
    }
    return content;
  } catch (e) {
    return `Error reading file: ${e.message}`;
  }
}

function writeFile(args) {
  const { path: filePath, content } = args;
  if (!filePath || content === undefined) return "Error: path and content required";
  try {
    const abs = path.resolve(filePath);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf-8");
    const lines = content.split("\n").length;
    return `✓ Written ${lines} lines to ${filePath}`;
  } catch (e) {
    return `Error writing file: ${e.message}`;
  }
}

function appendFile(args) {
  const { path: filePath, content } = args;
  if (!filePath || content === undefined) return "Error: path and content required";
  try {
    const abs = path.resolve(filePath);
    fs.appendFileSync(abs, content, "utf-8");
    return `✓ Appended to ${filePath}`;
  } catch (e) {
    return `Error appending: ${e.message}`;
  }
}

function deleteFile(args) {
  const { path: filePath } = args;
  if (!filePath) return "Error: path required";
  try {
    const abs = path.resolve(filePath);
    if (!fs.existsSync(abs)) return `Error: File not found: ${filePath}`;
    fs.unlinkSync(abs);
    return `✓ Deleted ${filePath}`;
  } catch (e) {
    return `Error deleting: ${e.message}`;
  }
}

function listDir(args = {}) {
  const dirPath = args.path || ".";
  try {
    const abs = path.resolve(dirPath);
    if (!fs.existsSync(abs)) return `Error: Directory not found: ${dirPath}`;

    function walk(dir, prefix = "", depth = 0) {
      if (depth > 3) return [];
      let entries;
      try {
        entries = fs.readdirSync(dir);
      } catch {
        return [];
      }

      // Filter noise
      const filtered = entries.filter(
        (e) =>
          !["node_modules", ".git", ".nyxo", "dist", "build", "__pycache__", ".next"].includes(e) &&
          !e.startsWith(".")
      );

      const lines = [];
      filtered.slice(0, MAX_DIR_ENTRIES).forEach((entry, i) => {
        const isLast = i === filtered.length - 1;
        const connector = isLast ? "└── " : "├── ";
        const fullPath = path.join(dir, entry);
        let stat;
        try {
          stat = fs.statSync(fullPath);
        } catch {
          return;
        }
        if (stat.isDirectory()) {
          lines.push(prefix + connector + entry + "/");
          const sub = walk(fullPath, prefix + (isLast ? "    " : "│   "), depth + 1);
          lines.push(...sub);
        } else {
          const size = stat.size > 1024 ? `${(stat.size / 1024).toFixed(1)}kb` : `${stat.size}b`;
          lines.push(prefix + connector + entry + chalk_gray(` (${size})`));
        }
      });
      if (filtered.length > MAX_DIR_ENTRIES) {
        lines.push(prefix + `... and ${filtered.length - MAX_DIR_ENTRIES} more`);
      }
      return lines;
    }

    const tree = walk(abs);
    return `${dirPath}/\n` + tree.join("\n");
  } catch (e) {
    return `Error listing directory: ${e.message}`;
  }
}

function chalk_gray(s) {
  return s; // no chalk in tool output going to AI
}

function runCommand(args) {
  const { cmd } = args;
  if (!cmd) return "Error: cmd required";

  // Block destructive commands
  const blocked = [/rm\s+-rf\s+\//, /mkfs/, /dd\s+if=/, /:\(\)\{.*\}/, /shutdown/, /reboot/];
  if (blocked.some((r) => r.test(cmd))) {
    return "Error: That command is blocked for safety.";
  }

  try {
    const output = execSync(cmd, {
      timeout: 15000,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      cwd: process.cwd(),
    });
    const trimmed = (output || "").slice(0, MAX_CMD_OUTPUT);
    return trimmed || "(no output)";
  } catch (e) {
    const errOut = (e.stderr || e.stdout || e.message || "").slice(0, MAX_CMD_OUTPUT);
    return `Error (exit ${e.status}):\n${errOut}`;
  }
}

function searchFiles(args) {
  const { pattern, dir = "." } = args;
  if (!pattern) return "Error: pattern required";
  try {
    const glob = require("fast-glob");
    const matches = glob.sync(pattern, {
      cwd: path.resolve(dir),
      ignore: ["node_modules/**", ".git/**", "dist/**", "build/**"],
      onlyFiles: false,
      absolute: false,
    });
    if (!matches.length) return `No files found matching: ${pattern}`;
    return matches.slice(0, 50).join("\n") + (matches.length > 50 ? `\n...and ${matches.length - 50} more` : "");
  } catch (e) {
    return `Search error: ${e.message}`;
  }
}

function grepInFile(args) {
  const { pattern, path: filePath } = args;
  if (!pattern || !filePath) return "Error: pattern and path required";
  try {
    const abs = path.resolve(filePath);
    const content = fs.readFileSync(abs, "utf-8");
    const lines = content.split("\n");
    const regex = new RegExp(pattern, "gi");
    const matches = lines
      .map((line, i) => ({ line, num: i + 1 }))
      .filter(({ line }) => regex.test(line));
    if (!matches.length) return `No matches for "${pattern}" in ${filePath}`;
    return matches
      .slice(0, 40)
      .map(({ num, line }) => `${String(num).padStart(4)}: ${line}`)
      .join("\n");
  } catch (e) {
    return `Grep error: ${e.message}`;
  }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

const TOOLS = {
  readFile,
  writeFile,
  appendFile,
  deleteFile,
  listDir,
  runCommand,
  searchFiles,
  grepInFile,
};

function executeTool(name, args) {
  const fn = TOOLS[name];
  if (!fn) return `Unknown tool: ${name}. Available: ${Object.keys(TOOLS).join(", ")}`;
  return fn(args);
}

// ─── Parser: extract tool_call from AI response ───────────────────────────────

function parseToolCall(text) {
  const match = text.match(/<tool_call>([\s\S]*?)<\/tool_call>/);
  if (!match) return null;
  try {
    const json = JSON.parse(match[1].trim());
    return { tool: json.tool, args: json.args || {} };
  } catch {
    return null;
  }
}

function stripToolCall(text) {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
}

module.exports = {
  TOOL_SCHEMA,
  executeTool,
  parseToolCall,
  stripToolCall,
  TOOLS,
};
