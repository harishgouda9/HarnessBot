#!/usr/bin/env node
/**
 * Desktop MCP for a bot that was opted into this computer.
 *
 * The harness decides whether a click is allowed. This process only moves the
 * pointer after that check passes. It does not store passwords or complete a sign-in.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const WIN_PS = path.join(HERE, 'computer-win.ps1');
const TOKEN = process.env.HB_INTERNAL_TOKEN;
const BASE = process.env.HB_INTERNAL_URL ?? 'http://127.0.0.1:8799';
const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const TOOLS = [
  {
    name: 'screenshot',
    description: 'Capture the primary screen. Click and move use this image’s coordinates. Take one before every action and after anything that should have changed the screen.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'click',
    description: 'Click at screenshot coordinates. button is left, right, or middle. clicks is 1 or 2.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string' },
        clicks: { type: 'number' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'move',
    description: 'Move the pointer to screenshot coordinates without clicking.',
    inputSchema: {
      type: 'object',
      properties: { x: { type: 'number' }, y: { type: 'number' } },
      required: ['x', 'y'],
    },
  },
  {
    name: 'scroll',
    description: 'Scroll at screenshot coordinates. direction is up or down. amount is a small number of notches.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        direction: { type: 'string' },
        amount: { type: 'number' },
      },
      required: ['x', 'y'],
    },
  },
  {
    name: 'type_text',
    description: 'Type text into the focused window. Do not use this for passwords, one-time codes, or cookies. Stop and ask the user instead.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'key',
    description: 'Press a key in the focused window. Examples: enter, tab, escape, ctrl+l, alt+tab, f5.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'open_target',
    description: 'Open an http(s) URL in the default browser, or start an app by a simple name such as notepad. This does not sign in.',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target'],
    },
  },
];

const KEYS = {
  enter: '{ENTER}',
  return: '{ENTER}',
  tab: '{TAB}',
  escape: '{ESC}',
  esc: '{ESC}',
  backspace: '{BKSP}',
  delete: '{DEL}',
  up: '{UP}',
  down: '{DOWN}',
  left: '{LEFT}',
  right: '{RIGHT}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  space: ' ',
};
for (let i = 1; i <= 12; i++) KEYS[`f${i}`] = `{F${i}}`;

/** Image pixels from the last screenshot, mapped onto the real screen. */
let originX = 0;
let originY = 0;
let scaleX = 1;
let scaleY = 1;

export function compileKey(spec) {
  const parts = String(spec ?? '')
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 3) throw new Error('key must look like enter, ctrl+l, or alt+tab');
  let mods = '';
  let key = '';
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') mods += '^';
    else if (part === 'alt') mods += '%';
    else if (part === 'shift') mods += '+';
    else if (key) throw new Error('only one key besides ctrl, alt, and shift');
    else if (KEYS[part]) key = KEYS[part];
    else if (/^[a-z0-9]$/.test(part)) key = part;
    else throw new Error(`unsupported key: ${part}`);
  }
  if (!key) throw new Error('key is missing');
  return mods + key;
}

export function sanitizeTarget(target) {
  const text = String(target ?? '').trim();
  if (!text || text.length > 500) throw new Error('target is empty or too long');
  if (/[\r\n\0]/.test(text)) throw new Error('target cannot contain a newline');
  if (/^https?:\/\//i.test(text)) {
    let url;
    try {
      url = new URL(text);
    } catch {
      throw new Error('target is not a valid URL');
    }
    if (url.username || url.password) throw new Error('URLs must not carry a username or password');
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('only http and https URLs can be opened');
    return url.href;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,80}$/.test(text)) {
    throw new Error('open_target accepts an http(s) URL or a simple app name, not a path or a command');
  }
  return text;
}

function point(x, y) {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error('x and y must be numbers from the last screenshot');
  const sx = Math.round(originX + nx * scaleX);
  const sy = Math.round(originY + ny * scaleY);
  if (sx < -8000 || sy < -8000 || sx > 20000 || sy > 20000) throw new Error('coordinates are off the screen');
  return { x: sx, y: sy };
}

function rememberShot(shot) {
  const width = Number(shot.width) || 1;
  const height = Number(shot.height) || 1;
  const screenWidth = Number(shot.screenWidth) || width;
  const screenHeight = Number(shot.screenHeight) || height;
  originX = Number(shot.originX) || 0;
  originY = Number(shot.originY) || 0;
  scaleX = screenWidth / width;
  scaleY = screenHeight / height;
}

export function escapeSendKeys(text) {
  return String(text).replace(/[+^%~(){}]/g, (ch) => `{${ch}}`).replace(/\r?\n/g, '{ENTER}');
}

async function callHarness(pathname, body) {
  if (!TOKEN) throw new Error('Desktop driver is missing its harness token');
  const res = await fetch(`${BASE}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body ?? {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text || `harness returned ${res.status}`);
  return text ? JSON.parse(text) : null;
}

async function gate(act) {
  const status = await callHarness('/api/internal/computer-control', { act });
  if (status?.held) throw new Error('A person is driving this computer. Hands are paused.');
  if (!status?.placement?.available || status.placement.backend !== 'host') {
    throw new Error(status?.placement?.reason || 'This computer is not opted in.');
  }
  if (act && status.actions && status.actions.allowed === false) {
    throw new Error(`Action ceiling reached (${status.actions.used} of ${status.maxActions}).`);
  }
}

async function runHost(action) {
  if (process.env.HB_COMPUTER_DRY === '1') {
    if (action.op === 'screenshot') {
      return {
        ok: true,
        width: 2,
        height: 2,
        screenWidth: 4,
        screenHeight: 4,
        originX: 10,
        originY: 20,
        mime: 'image/png',
        data: TINY_PNG,
        dry: true,
      };
    }
    return { ok: true, dry: true, op: action.op, x: action.x, y: action.y };
  }
  if (process.platform !== 'win32') {
    throw new Error(`Desktop control is implemented for Windows. This machine is ${process.platform}.`);
  }
  const file = path.join(os.tmpdir(), `hb-act-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(file, JSON.stringify(action));
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', WIN_PS, '-ActionPath', file],
      { windowsHide: true, timeout: 30_000, maxBuffer: 12 * 1024 * 1024 },
    );
    const line = stdout
      .split(/\r?\n/)
      .map((row) => row.trim())
      .filter(Boolean)
      .pop();
    if (!line) throw new Error('desktop driver returned nothing');
    const parsed = JSON.parse(line);
    if (parsed.ok === false) throw new Error(parsed.error || 'desktop action failed');
    return parsed;
  } finally {
    try {
      fs.unlinkSync(file);
    } catch {
      /* temp file is not the action */
    }
  }
}

function textResult(text, extra = []) {
  return { content: [{ type: 'text', text }, ...extra] };
}

function fail(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callTool(name, args) {
  await gate(true);
  if (name === 'screenshot') {
    const shot = await runHost({ op: 'screenshot' });
    rememberShot(shot);
    await callHarness('/api/internal/screen', { png: shot.data, mime: shot.mime, keep: false }).catch(() => {});
    return textResult(
      `Screenshot ${shot.width}x${shot.height}. Click and move use these coordinates, not the raw screen size.`,
      [{ type: 'image', mimeType: shot.mime, data: shot.data }],
    );
  }
  if (name === 'click') {
    const button = ['left', 'right', 'middle'].includes(args.button) ? args.button : 'left';
    const at = point(args.x, args.y);
    await runHost({ op: 'click', ...at, button, clicks: Number(args.clicks) === 2 ? 2 : 1 });
    return textResult(`Clicked ${button} at screenshot ${args.x},${args.y} (screen ${at.x},${at.y}).`);
  }
  if (name === 'move') {
    const at = point(args.x, args.y);
    await runHost({ op: 'move', ...at });
    return textResult(`Moved to screenshot ${args.x},${args.y}.`);
  }
  if (name === 'scroll') {
    const direction = String(args.direction ?? 'down').toLowerCase() === 'up' ? 'up' : 'down';
    const amount = Math.min(10, Math.max(1, Math.round(Number(args.amount) || 1)));
    const at = point(args.x, args.y);
    await runHost({ op: 'scroll', ...at, delta: (direction === 'up' ? 1 : -1) * amount * 120 });
    return textResult(`Scrolled ${direction} at screenshot ${args.x},${args.y}.`);
  }
  if (name === 'type_text') {
    const text = String(args.text ?? '');
    if (!text) throw new Error('text is empty');
    if (text.length > 2000) throw new Error('text is too long to type in one step');
    await runHost({ op: 'keys', keys: escapeSendKeys(text) });
    return textResult(`Typed ${text.length} characters into the focused window.`);
  }
  if (name === 'key') {
    const keys = compileKey(args.key);
    await runHost({ op: 'keys', keys });
    return textResult(`Pressed ${args.key}.`);
  }
  if (name === 'open_target') {
    const target = sanitizeTarget(args.target);
    await runHost({ op: 'open', target });
    return textResult(`Opened ${target}.`);
  }
  throw new Error(`unknown tool: ${name}`);
}

async function handle(request) {
  switch (request.method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'harnessbot-computer', version: '0.1.44' },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: TOOLS };
    case 'tools/call': {
      const { name, arguments: args = {} } = request.params ?? {};
      try {
        return await callTool(name, args);
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err));
      }
    }
    default:
      throw new Error(`unsupported method: ${request.method}`);
  }
}

let framing = 'newline';

function reply(message) {
  const json = JSON.stringify(message);
  if (framing === 'content-length') {
    const body = Buffer.from(json, 'utf8');
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
    return;
  }
  process.stdout.write(`${json}\n`);
}

async function dispatch(message) {
  if (message.method && message.id === undefined) return;
  try {
    const result = await handle(message);
    reply({ jsonrpc: '2.0', id: message.id, result });
  } catch (err) {
    reply({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    });
  }
}

function consume(buffer) {
  while (buffer.length) {
    if (buffer[0] === 0x7b) {
      framing = 'newline';
      const nl = buffer.indexOf(0x0a);
      if (nl < 0) return buffer;
      const line = buffer.slice(0, nl).toString('utf8').replace(/\r$/, '').trim();
      buffer = buffer.slice(nl + 1);
      if (line) void dispatch(JSON.parse(line));
      continue;
    }
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return buffer;
    framing = 'content-length';
    const header = buffer.slice(0, headerEnd).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return buffer;
    const body = buffer.slice(start, start + length).toString('utf8');
    buffer = buffer.slice(start + length);
    void dispatch(JSON.parse(body));
  }
  return buffer;
}

async function shotAndExit() {
  try {
    const shot = await runHost({ op: 'screenshot' });
    process.stdout.write(
      `${JSON.stringify({ data: shot.data, mime: shot.mime, width: shot.width, height: shot.height })}\n`,
    );
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n`);
    process.exitCode = 1;
  }
}

const invoked =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invoked) {
  if (process.argv.includes('--shot')) {
    void shotAndExit();
  } else {
    let buffer = Buffer.alloc(0);
    process.stdin.on('data', (chunk) => {
      buffer = consume(Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]));
    });
  }
}
