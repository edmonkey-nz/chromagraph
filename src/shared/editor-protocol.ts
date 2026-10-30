import type { LayerTransform } from './layer-schema.ts';
import type { OrbitCamera } from './project-schema.ts';

/**
 * Messages between the control window and its embedded preview (`/output/?preview`) for
 * direct manipulation. They travel by window.postMessage (same origin only); the preview
 * never patches state itself — it reports what the user dragged and the control window
 * sends the patch, so the server stays the single writer and everything stays undoable
 * through the normal path.
 *
 * control -> preview
 *   edit       turn edit mode on/off, choose the selected layer and the gizmo mode.
 *              While editing, the preview shows a transform gizmo on the selected layer
 *              and (in 3D) mouse orbit/zoom/pan of the camera.
 * preview -> control
 *   ready      the preview loaded (control re-sends its current `edit` message)
 *   transform  the selected layer's new transform while dragging (throttled ~30 Hz) and
 *              once more on release (`final: true`)
 *   camera     new camera after orbit/zoom/pan (3D only), same throttling
 *   select     the user clicked a layer in the preview (best effort; may be null)
 */

export type GizmoMode = 'translate' | 'rotate' | 'scale';

export type ControlToPreview = {
  t: 'edit';
  enabled: boolean;
  layerId: string | null;
  mode: GizmoMode;
  /** Snap: px for translate, degrees for rotate, 0.05 steps for scale; 0 = off. */
  snap: number;
};

export type PreviewToControl =
  | { t: 'ready' }
  | { t: 'transform'; layerId: string; transform: LayerTransform; final: boolean }
  | { t: 'camera'; camera: OrbitCamera; final: boolean }
  | { t: 'select'; layerId: string | null };

const TAG = 'chromagraph-editor';

export function wrap<T>(msg: T): { tag: typeof TAG; msg: T } {
  return { tag: TAG, msg };
}

/** Unwrap a postMessage event's data if it is one of ours from the same origin. */
export function unwrap<T>(ev: MessageEvent): T | null {
  if (ev.origin !== location.origin) return null;
  const d = ev.data as { tag?: unknown; msg?: unknown } | null;
  if (!d || d.tag !== TAG || typeof d.msg !== 'object' || d.msg === null) return null;
  return d.msg as T;
}
