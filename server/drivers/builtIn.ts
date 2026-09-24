import type { DriverCapabilities, ModelInfo, TurnIntegrations } from '../contracts.ts';
import type { Registry } from '../harness/registry.ts';
import { defineAcpDriver, type AcpDriverSpec } from './acp.ts';
import { defineCliDriver, type BuildArgsInput, type CliDriverSpec } from './cli.ts';
import { miniMaxDriver, openAiCompatDriver } from './openai-compat.ts';

/**
 * The engine table. Adding a provider is one entry here plus a fake CLI contract test
 * (HB-OPS-001 s8). A vendor that needs real protocol work overrides `parse`.
 */

const m = (id: string, label: string, isDefault?: boolean): ModelInfo => ({ id, label, default: isDefault });

/** Full hands: this CLI can mount every MCP integration the harness offers. */
const FULL_HANDS: Partial<DriverCapabilities> = {
  images: true,
  steer: true,
  queueing: true,
  sessionModelSwitch: true,
  computerMcp: true,
  composioMcp: true,
  agentsMcp: true,
  phoneMcp: true,
  browserMcp: true,
  customMcp: true,
};

/** Tools but no local seat — safe for a CLI without computer-use support. */
const TOOLS_ONLY: Partial<DriverCapabilities> = {
  queueing: true,
  composioMcp: true,
  agentsMcp: true,
  customMcp: true,
};

const SPECS: CliDriverSpec[] = [
  {
    kind: 'claude',
    displayName: 'Claude Code',
    bin: 'claude',
    secretEnv: 'ANTHROPIC_API_KEY',
    models: [
      m('claude-opus-5', 'Opus 5', true),
      m('claude-sonnet-5', 'Sonnet 5'),
      m('claude-fable-5-1', 'Fable 5.1'),
      m('claude-haiku-4-5-20251001', 'Haiku 4.5'),
    ],
    capabilities: { ...FULL_HANDS, effortLevels: ['low', 'medium', 'high'] },
    interactiveStdin: true,
    buildArgs: ({ input, resume }) => [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--model',
      input.model,
      ...(resume ? ['--resume', resume] : []),
      ...(input.cwd ? ['--add-dir', input.cwd] : []),
      ...mcpArgs(input),
    ],
  },
  {
    kind: 'codex',
    displayName: 'Codex',
    bin: 'codex',
    models: [m('gpt-5-codex', 'GPT-5 Codex', true), m('gpt-5', 'GPT-5'), m('o4-mini', 'o4-mini')],
    capabilities: { ...FULL_HANDS, effortLevels: ['low', 'medium', 'high', 'xhigh'] },
    interactiveStdin: true,
    buildArgs: ({ input, resume }) => [
      'exec',
      '--json',
      '--model',
      input.model,
      ...(input.effort ? ['-c', `model_reasoning_effort=${input.effort}`] : []),
      ...(resume ? ['resume', resume] : []),
    ],
  },
  {
    kind: 'grok',
    displayName: 'Grok',
    bin: 'grok',
    secretEnv: 'XAI_API_KEY',
    // Grok Build TUI currently advertises grok-4.6 / grok-4.5. Older picker ids
    // still appear so a pinned bot is not silently empty; argv maps them below.
    models: [
      m('grok-4.6', 'Grok 4.6', true),
      m('grok-4.5', 'Grok 4.5'),
      m('grok-4', 'Grok 4'),
      m('grok-4-fast', 'Grok 4 Fast'),
      m('grok-code', 'Grok Code'),
    ],
    capabilities: { ...FULL_HANDS, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    // Headless Grok ignores stdin and rejects --stream-json (it suggests --prompt-json).
    promptVia: 'file',
    interactiveStdin: false,
    buildArgs: ({ input, resume }) => grokBuildArgs({ input, resume }),
  },
  {
    kind: 'cursor',
    displayName: 'Cursor Agent',
    bin: 'cursor-agent',
    models: [m('auto', 'Auto', true), m('sonnet-5', 'Sonnet 5'), m('gpt-5', 'GPT-5')],
    capabilities: { ...FULL_HANDS },
    interactiveStdin: true,
    buildArgs: ({ input, resume }) => [
      '--print',
      '--output-format',
      'stream-json',
      '--model',
      input.model,
      ...(resume ? ['--resume', resume] : []),
    ],
  },
  {
    kind: 'kimi',
    displayName: 'Kimi',
    bin: 'kimi',
    models: [m('kimi-k2', 'Kimi K2', true)],
    capabilities: { ...TOOLS_ONLY, images: true },
    interactiveStdin: true,
    buildArgs: ({ input }) => ['--json', '--model', input.model],
  },
  {
    kind: 'droid',
    displayName: 'Droid',
    bin: 'droid',
    models: [m('droid-default', 'Droid', true)],
    capabilities: { ...FULL_HANDS },
    interactiveStdin: true,
    buildArgs: ({ input, resume }) => ['exec', '--json', '--model', input.model, ...(resume ? ['--resume', resume] : [])],
  },
  {
    kind: 'antigravity',
    displayName: 'Antigravity',
    bin: 'antigravity',
    models: [m('antigravity-default', 'Antigravity', true)],
    capabilities: { ...FULL_HANDS },
    interactiveStdin: true,
    buildArgs: ({ input }) => ['--stream-json', '--model', input.model],
  },
  {
    kind: 'opencode',
    displayName: 'OpenCode',
    bin: 'opencode',
    models: [m('opencode-default', 'OpenCode', true)],
    capabilities: { ...TOOLS_ONLY },
    interactiveStdin: true,
    buildArgs: ({ input }) => ['run', '--json', '--model', input.model],
  },
  {
    kind: 'opencodeGo',
    displayName: 'OpenCode Go',
    bin: 'opencode-go',
    secretEnv: 'OPENCODE_API_KEY',
    models: [m('opencode-go', 'OpenCode Go', true)],
    capabilities: { ...TOOLS_ONLY },
    interactiveStdin: true,
    buildArgs: ({ input }) => ['run', '--json', '--model', input.model],
  },
  {
    kind: 'qwen',
    displayName: 'Qwen Code',
    bin: 'qwen',
    models: [m('qwen3-coder', 'Qwen3 Coder', true)],
    capabilities: { ...TOOLS_ONLY },
    interactiveStdin: true,
    buildArgs: ({ input }) => ['--json', '--model', input.model],
  },
  {
    kind: 'pi',
    displayName: 'Pi',
    bin: 'pi',
    models: [m('pi-default', 'Pi', true)],
    capabilities: { queueing: true },
    buildArgs: ({ input }) => ['--json', '--model', input.model],
  },
  {
    kind: 'boxAgent',
    displayName: 'Box Agent',
    bin: 'box-agent',
    models: [m('box-default', 'Box Agent', true)],
    capabilities: { computerMcp: true, queueing: true },
    interactiveStdin: true,
    buildArgs: ({ input }) => ['--json', '--model', input.model],
  },
];

/**
 * MCP mounts are passed as harness-controlled argv. Only mounts the driver actually
 * declared support for reach this point — the turn builder gates on capabilities.
 */
const ACP_SPECS: AcpDriverSpec[] = [
  {
    kind: 'hermes',
    displayName: 'Hermes',
    bin: 'hermes',
    acpArgs: ['acp'],
    // `default` leaves Hermes on its own config. The rest of the catalogue is whatever
    // session/new reports — every provider Hermes is signed into, not just the current one.
    models: [m('default', 'As configured in Hermes', true)],
    // Hermes has no computer-use of its own. The hands are MCP servers this harness
    // mounts (this computer, a VM, cloud, browser, phone) and passes into the session.
    capabilities: { ...TOOLS_ONLY, computerMcp: true, browserMcp: true, phoneMcp: true },
  },
  {
    kind: 'customAcp',
    displayName: 'Custom ACP',
    bin: 'acp',
    acpArgs: ['--acp'],
    models: [m('default', 'Default', true)],
    capabilities: { ...TOOLS_ONLY },
  },
  {
    kind: 'geminiAcp',
    displayName: 'Gemini (ACP)',
    bin: 'gemini',
    acpArgs: ['--experimental-acp'],
    models: [m('gemini-3-pro', 'Gemini 3 Pro', true), m('gemini-3-flash', 'Gemini 3 Flash')],
    capabilities: { ...TOOLS_ONLY, images: true },
  },
];

/** Map picker ids the old driver shipped onto what Grok Build actually serves. */
export function grokModelId(id: string): string {
  if (id === 'grok-4' || id === 'grok-4-fast' || id === 'grok-code') return 'grok-4.6';
  return id;
}

/**
 * Grok Build TUI headless argv. `--stream-json` is not a flag; clap suggests
 * `--prompt-json` and the turn dies with that usage line. Prompt text is not
 * here — the adapter writes `--prompt-file` so `ps` does not see it.
 */
export function grokBuildArgs({ input, resume }: BuildArgsInput): string[] {
  return [
    '--output-format',
    'streaming-messages-json',
    '--no-plan',
    '-m',
    grokModelId(input.model),
    ...(input.cwd ? ['--cwd', input.cwd] : []),
    ...(input.effort ? ['--effort', input.effort] : []),
    ...(resume ? ['-r', resume] : []),
  ];
}

/**
 * Headless `grok` rejects `--plugin-dir` and has no `--mcp-config`. Desktop tools
 * go through `grok agent --no-leader stdio`, which takes MCP servers on session/new.
 */
export function grokHandsArgs(model: string, effort?: string): string[] {
  return ['agent', '--no-leader', '-m', grokModelId(model), ...(effort ? ['--reasoning-effort', effort] : []), 'stdio'];
}

function mcpArgs(input: { integrations: TurnIntegrations }): string[] {
  const args: string[] = [];
  for (const [name, mount] of Object.entries(input.integrations) as [string, unknown][]) {
    if (!mount || name === 'custom') continue;
    args.push('--mcp-config', JSON.stringify({ [name]: mount }));
  }
  const custom = input.integrations.custom;
  for (const [name, mount] of Object.entries(custom ?? {})) {
    args.push('--mcp-config', JSON.stringify({ [name]: mount }));
  }
  return args;
}

export function registerBuiltInDrivers(registry: Registry): void {
  for (const spec of SPECS) registry.register(defineCliDriver(spec) as never);
  // ACP engines are a connection, not a command: separate adapter, same registry.
  for (const spec of ACP_SPECS) registry.register(defineAcpDriver(spec) as never);
  // Text and reasoning only: no tools, so no computer and no connected apps.
  // This one must never be advertised as having hands (HB-PRD-001 F-ENG-06).
  registry.register(openAiCompatDriver as never);
  registry.register(miniMaxDriver as never);
}
