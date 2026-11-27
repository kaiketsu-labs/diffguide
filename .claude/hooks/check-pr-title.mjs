#!/usr/bin/env node
// PreToolUse hook: block `gh pr create` or `gh pr edit` when its --title would fail CI's title check.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const command = JSON.parse(readFileSync(0, "utf8")).tool_input?.command ?? "";
if (!/\bgh\s+pr\s+(create|edit)\b/.test(command)) process.exit(0);

const match = command.match(/(?:--title|-t)(?:\s+|=)(?:"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s'"]+))/);
if (!match) process.exit(0);
const title = match[1] !== undefined ? match[1].replace(/\\(["\\$`])/g, "$1") : (match[2] ?? match[3]);

const script = join(process.env.CLAUDE_PROJECT_DIR ?? ".", "scripts/check-pr-title.sh");
const result = spawnSync(script, [title], { encoding: "utf8" });
if (result.status !== 0) {
  process.stderr.write(result.stderr || `${script} failed\n`);
  process.exit(2);
}
