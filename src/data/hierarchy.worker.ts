/// <reference lib="webworker" />
/**
 * Groups rows into hierarchy trees and lays them out, off the output's main thread.
 * Inputs (copied columns) are cached per layer and trees per row range, so a layout-only
 * change re-lays out a cached tree and a row-range change regroups without new columns.
 * Results come back as transferred typed arrays.
 */
import type { HierarchyRequest, HierarchyResponse } from './hierarchy-client.ts';
import { cloneTree, groupHierarchy, treeTransferables, type GroupInputs, type HierarchyTree } from './hierarchy-data.ts';
import { layoutHierarchy, layoutTransferables } from './hierarchy-layout.ts';

declare const self: DedicatedWorkerGlobalScope;

/** Inputs kept per layer, and trees kept in all (least recently used dropped first). */
const MAX_INPUTS = 8;
const MAX_TREES = 16;

const inputs = new Map<string, GroupInputs>();
const trees = new Map<string, { inputKey: string; tree: HierarchyTree }>();

function touch<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) map.delete(map.keys().next().value as K);
}

self.onmessage = (ev: MessageEvent<HierarchyRequest>) => {
  const msg = ev.data;
  if (msg.t === 'drop') {
    inputs.delete(msg.inputKey);
    for (const [k, v] of [...trees]) if (v.inputKey === msg.inputKey) trees.delete(k);
    return;
  }
  const { id } = msg;
  let response: HierarchyResponse;
  try {
    if (msg.inputs) touch(inputs, msg.inputKey, msg.inputs, MAX_INPUTS);
    const t0 = performance.now();
    let entry = trees.get(msg.groupKey);
    let fresh = false;
    if (!entry) {
      const source = inputs.get(msg.inputKey);
      if (!source) {
        self.postMessage({ id, ok: false, error: 'inputs not cached', needInputs: true } satisfies HierarchyResponse);
        return;
      }
      entry = { inputKey: msg.inputKey, tree: groupHierarchy(source, msg.aggregate, msg.first, msg.last) };
      fresh = true;
    }
    touch(trees, msg.groupKey, entry, MAX_TREES);
    // Keep the cached input set warm too.
    const source = inputs.get(msg.inputKey);
    if (source) touch(inputs, msg.inputKey, source, MAX_INPUTS);
    const t1 = performance.now();
    const layout = layoutHierarchy(entry.tree, msg.layout);
    const t2 = performance.now();
    // The cached tree stays here; the caller gets a copy it can own.
    const tree = msg.wantTree || fresh ? cloneTree(entry.tree) : null;
    const transfer = layoutTransferables(layout);
    if (tree) transfer.push(...treeTransferables(tree));
    response = { id, ok: true, tree, layout, groupMs: t1 - t0, layoutMs: t2 - t1 };
    self.postMessage(response, transfer);
    return;
  } catch (err) {
    response = { id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  self.postMessage(response);
};
