#!/usr/bin/env node
import { homedir } from "os";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { createInterface } from "readline";

const DEFAULT_PORT = 9009;
const envDir = process.env.CLAUDECK_HOME || join(homedir(), ".claudeck");
const envPath = join(envDir, ".env");
mkdirSync(envDir, { recursive: true });

function readEnv() {
  try { return readFileSync(envPath, "utf-8"); } catch { return ""; }
}

function savePort(port) {
  let content = readEnv();
  if (/^PORT=.*/m.test(content)) {
    content = content.replace(/^PORT=.*/m, `PORT=${port}`);
  } else {
    content = content.trimEnd() + `\nPORT=${port}\n`;
  }
  writeFileSync(envPath, content);
}

function getSavedPort() {
  const match = readEnv().match(/^PORT=(\d+)/m);
  return match ? match[1] : null;
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()); });
  });
}

async function main() {
  // --port flag takes priority
  const portArg = process.argv.find(a => a.startsWith('--port'));
  if (portArg) {
    const port = portArg.includes('=') ? portArg.split('=')[1] : process.argv[process.argv.indexOf(portArg) + 1];
    if (port) {
      process.env.PORT = port;
      savePort(port);
      return import("./server.js");
    }
  }

  // If port already saved, use it
  const saved = getSavedPort();
  if (saved) {
    process.env.PORT = saved;
    return import("./server.js");
  }

  // First run — ask user
  console.log(`\n\x1b[36m  Claudeck\x1b[0m — first-time setup\n`);
  const answer = await ask(`  Which port would you like to use? \x1b[2m(default: ${DEFAULT_PORT})\x1b[0m `);
  const port = answer && /^\d+$/.test(answer) ? answer : String(DEFAULT_PORT);
  process.env.PORT = port;
  savePort(port);
  console.log(`\x1b[2m  Saved to ~/.claudeck/.env\x1b[0m\n`);
  return import("./server.js");
}

main();
