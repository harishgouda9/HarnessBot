import type { EffortLevel, ModelSelection } from '../shared/types.ts';

const EFFORTS = new Set<EffortLevel>(['none', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * A PATCH may send only the engine and model (the MCP switch_model tool does).
 * Effort, auto, and any other fields already on the bot stay unless the patch sets them.
 */
export function mergeModelSelection(current: ModelSelection, patch: unknown): ModelSelection {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new Error('modelSelection must be an object');
  }
  const incoming = patch as Partial<ModelSelection>;
  const instanceId = typeof incoming.instanceId === 'string' ? incoming.instanceId.trim() : current.instanceId;
  const model = typeof incoming.model === 'string' ? incoming.model.trim() : current.model;
  if (!instanceId || !model) throw new Error('modelSelection needs an engine and a model');
  if (incoming.effort !== undefined && !EFFORTS.has(incoming.effort)) {
    throw new Error('modelSelection effort is not recognised');
  }
  if (incoming.auto !== undefined && typeof incoming.auto !== 'boolean') {
    throw new Error('modelSelection auto must be true or false');
  }
  return { ...current, ...incoming, instanceId, model };
}
