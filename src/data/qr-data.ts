/**
 * QR code layers: what to encode, the module matrix, and the texture bytes. Pure (no GPU), so
 * it is unit-tested, and the tests decode the result back with jsQR.
 *
 * The output draws the code as one quad sampling a single-channel texture of one texel per
 * module, quiet-zone margin included, with nearest filtering, so module edges stay hard at
 * any size (see client/output/layers/qr.ts).
 *
 * Text is encoded as UTF-8 in byte mode (what phone readers expect for URLs and for text
 * such as "Māori"). The version (size) is the smallest that holds the text at the chosen
 * error correction level.
 */
import qrcode from 'qrcode-generator';
import type { Dataset } from '../shared/project-schema.ts';
import type { QR_LEVELS, QrLayer } from '../shared/layer-schema.ts';

export type QrLevel = (typeof QR_LEVELS)[number];

/** Bytes a version 40 code (the largest) holds in byte mode, per error correction level. */
export const QR_MAX_BYTES: Record<QrLevel, number> = { L: 2953, M: 2331, Q: 1663, H: 1273 };

/** A QR code's modules: `count` x `count`, row-major from the top-left, 1 = dark. */
export interface QrMatrix {
  count: number;
  modules: Uint8Array;
}

/**
 * The text a QR layer encodes, or null when there is nothing to encode (empty text, no
 * dataset, or a dataset without a url). Leading and trailing whitespace is dropped: a
 * pasted URL with a trailing newline should still open.
 */
export function qrText(layer: Pick<QrLayer, 'content' | 'text' | 'datasetId'>, datasets: readonly Pick<Dataset, 'id' | 'url'>[]): string | null {
  let text: string;
  if (layer.content === 'text') {
    text = layer.text;
  } else {
    const dataset = layer.datasetId === null ? undefined : datasets.find((d) => d.id === layer.datasetId);
    if (!dataset) return null;
    text = dataset.url;
  }
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/** `text` as a "binary string" of its UTF-8 bytes (one char per byte), which the encoder takes as is. */
function utf8Binary(text: string): { binary: string; length: number } {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return { binary, length: bytes.length };
}

/**
 * Encode `text` at error correction `level`. Throws a readable Error when the text is too long
 * for the largest QR code (the layer is then flagged in the control window).
 */
export function encodeQr(text: string, level: QrLevel): QrMatrix {
  const { binary, length } = utf8Binary(text);
  const max = QR_MAX_BYTES[level];
  if (length > max) throw new Error(tooLong(length, level));
  const qr = qrcode(0, level);
  qr.addData(binary, 'Byte');
  try {
    qr.make();
  } catch (err) {
    // The encoder throws plain strings ("code length overflow").
    throw new Error(err instanceof Error ? err.message : /overflow/.test(String(err)) ? tooLong(length, level) : `QR encoding failed: ${String(err)}`);
  }
  const count = qr.getModuleCount();
  const modules = new Uint8Array(count * count);
  for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) modules[r * count + c] = qr.isDark(r, c) ? 1 : 0;
  return { count, modules };
}

function tooLong(bytes: number, level: QrLevel): string {
  const lower = level === 'L' ? '' : '; a lower error correction level holds more';
  return `text too long for a QR code: ${bytes} bytes, at most ${QR_MAX_BYTES[level]} at level ${level}${lower}`;
}

/** Texels per side of the code's texture: the modules plus `margin` light modules each side. */
export function qrSide(matrix: QrMatrix, margin: number): number {
  return matrix.count + 2 * margin;
}

/**
 * The code plus its quiet zone as single-channel texture bytes (255 = dark, 0 = light),
 * `side` x `side` (see qrSide). Rows run bottom-up, as WebGL reads a DataTexture (texture
 * v = 0 is the first row), so the code is upright on a quad with the usual uvs. Writes into
 * `out` when it has the right length.
 */
export function qrTexels(matrix: QrMatrix, margin: number, out?: Uint8Array): Uint8Array {
  const side = qrSide(matrix, margin);
  const data = out && out.length === side * side ? out : new Uint8Array(side * side);
  data.fill(0);
  const { count, modules } = matrix;
  for (let r = 0; r < count; r++) {
    const row = side - 1 - (r + margin);
    for (let c = 0; c < count; c++) if (modules[r * count + c]) data[row * side + c + margin] = 255;
  }
  return data;
}
