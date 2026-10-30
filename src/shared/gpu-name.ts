/**
 * Short GPU names for the control window's GPU pill, from a WebGL renderer string (Chrome's
 * unmasked renderer, usually wrapped by ANGLE):
 *   "ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1650/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 595.99.02)"
 *     -> "GTX 1650"
 *   "ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir, LLVM 17.0.6), OpenGL 4.6)" -> "Radeon Graphics"
 *   "ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) ...), SwiftShader driver)" -> "SwiftShader"
 * Pure, so it is tested.
 */

export type GpuKind = 'nvidia' | 'other' | 'software' | 'unknown';

export interface GpuInfo {
  /** A few words: the model where it can be found, else the device part of the string. */
  name: string;
  kind: GpuKind;
}

/** Software renderers: no GPU at all (slow, and never what an installation should run on). */
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software|microsoft basic render/i;

export function gpuInfo(renderer: string): GpuInfo {
  const raw = renderer.trim();
  if (raw === '') return { name: 'unknown', kind: 'unknown' };
  if (SOFTWARE.test(raw)) return { name: /swiftshader/i.test(raw) ? 'SwiftShader' : /llvmpipe/i.test(raw) ? 'llvmpipe' : 'software', kind: 'software' };
  const kind: GpuKind = /nvidia/i.test(raw) ? 'nvidia' : 'other';
  // ANGLE (vendor, device, backend): the device is the second part.
  const angle = /^ANGLE \((.*)\)$/i.exec(raw);
  let device = raw;
  if (angle) {
    const parts = splitTopLevel(angle[1]!);
    device = parts[1] ?? parts[0] ?? raw;
  }
  // ANGLE on Vulkan wraps the device once more: "Vulkan 1.3.0 (AMD Radeon Graphics (RADV RENOIR) …)".
  const api = /^(?:Vulkan|OpenGL(?: ES)?|Metal)\s[\d.]*\s*\((.*)\)\s*$/i.exec(device);
  if (api) device = api[1]!;
  device = device
    .replace(/\((R|TM)\)/gi, '')
    .replace(/\s*\b(Direct3D|OpenGL|Vulkan|Metal \d).*$/i, ''); // the API and shader model after the name
  // Everything in brackets (driver notes, chip codenames, PCI ids), innermost first.
  for (let before = ''; before !== device; ) {
    before = device;
    device = device.replace(/\s*\([^()]*\)/g, '');
  }
  device = device
    .replace(/\/(PCIe|SSE2|AGP)\b/gi, '')
    .replace(/\b(NVIDIA|AMD|ATI|Intel|Apple|Corporation|GeForce)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { name: device || raw, kind };
}

/** Split on commas that are not inside brackets. */
function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(s.slice(start).trim());
  return out;
}
