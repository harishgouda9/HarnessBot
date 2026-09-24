/**
 * Local model runtimes.
 *
 * A "local models" screen that is only a form asks the user to know their own port
 * number. Every runtime worth supporting speaks the OpenAI `/models` route on
 * loopback, so the honest version of this screen is a probe: say which ones are
 * actually running and what they are holding, then let one click point an engine at it.
 *
 * Loopback only, by construction. These addresses are never taken from configuration
 * or from a model — they are a fixed list of well-known local ports, so this cannot
 * become a request forger.
 */

export interface LocalRuntime {
  id: string;
  name: string;
  baseUrl: string;
  /** How to get it running, shown when it is not. */
  hint: string;
  running: boolean;
  models: string[];
  reason?: string;
}

interface RuntimeSpec {
  id: string;
  name: string;
  port: number;
  /** Most speak /v1; Ollama also answers there. */
  path: string;
  hint: string;
}

const SPECS: RuntimeSpec[] = [
  { id: 'ollama', name: 'Ollama', port: 11434, path: '/v1', hint: 'Install Ollama, then: ollama pull llama3.2' },
  { id: 'lmstudio', name: 'LM Studio', port: 1234, path: '/v1', hint: 'Open LM Studio and start its local server' },
  { id: 'llamacpp', name: 'llama.cpp', port: 8080, path: '/v1', hint: 'Run: llama-server -m model.gguf --port 8080' },
  { id: 'vllm', name: 'vLLM', port: 8000, path: '/v1', hint: 'Run: vllm serve <model>' },
  { id: 'jan', name: 'Jan', port: 1337, path: '/v1', hint: 'Open Jan and enable its local API server' },
];

/** Short: a runtime that is not listening should not hold the settings screen open. */
const PROBE_TIMEOUT_MS = 700;

async function probe(spec: RuntimeSpec): Promise<LocalRuntime> {
  const baseUrl = `http://127.0.0.1:${spec.port}${spec.path}`;
  const base: LocalRuntime = { id: spec.id, name: spec.name, baseUrl, hint: spec.hint, running: false, models: [] };

  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    if (!res.ok) return { ...base, reason: `responded ${res.status}` };
    const json = (await res.json()) as { data?: { id?: string }[] };
    const models = (json.data ?? []).map((m) => String(m.id ?? '')).filter(Boolean);
    // Listening but empty is a real state worth naming: the server is up and no model
    // is loaded, which looks identical to "not installed" if you only report a boolean.
    return { ...base, running: true, models, reason: models.length ? undefined : 'running, but no model is loaded' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ...base, reason: /abort|timeout/i.test(message) ? 'not responding' : 'not running' };
  }
}

/** Probe every known runtime at once. Running ones first. */
export async function detectLocalRuntimes(): Promise<LocalRuntime[]> {
  const found = await Promise.all(SPECS.map(probe));
  return found.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name));
}
