import jsQR from 'jsqr';
import { describe, expect, it } from 'vitest';
import { encodeQr, QR_MAX_BYTES, qrSide, qrTexels, qrText, utf8Length, type QrLevel, type QrMatrix } from '../../src/data/qr-data.ts';
import { blankQrLayer, QR_LEVELS } from '../../src/shared/layer-schema.ts';

/**
 * Render the texture bytes (bottom-up rows) as an upright RGBA image, `px` pixels per module,
 * as the output's quad shows them (dark = black, light = white), and decode it with jsQR.
 */
function decode(matrix: QrMatrix, margin: number, px = 4): string | null {
  const side = qrSide(matrix, margin);
  const texels = qrTexels(matrix, margin);
  const w = side * px;
  const rgba = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) {
    const row = side - 1 - Math.floor(y / px);
    for (let x = 0; x < w; x++) {
      const v = texels[row * side + Math.floor(x / px)] ? 0 : 255;
      const i = (y * w + x) * 4;
      rgba[i] = rgba[i + 1] = rgba[i + 2] = v;
      rgba[i + 3] = 255;
    }
  }
  return jsQR(rgba, w, w, { inversionAttempts: 'dontInvert' })?.data ?? null;
}

const LONG = `https://example.org/data?${'q=rainfall&'.repeat(60)}end`;

describe('qrText', () => {
  const linked = { url: ' https://niwa.co.nz/cliflo \n' };

  it('encodes the typed text, trimmed, or nothing when blank', () => {
    const layer = blankQrLayer('q', 'QR', null);
    expect(qrText(layer, linked)).toBe('https://example.org');
    expect(qrText({ ...layer, text: '  https://x.nz/a b \n' }, null)).toBe('https://x.nz/a b');
    expect(qrText({ ...layer, text: '   ' }, linked)).toBeNull();
  });

  it("follows the layer's dataset url in dataset mode", () => {
    const layer = { ...blankQrLayer('q', 'QR', 'a'), content: 'dataset' as const };
    expect(qrText(layer, linked)).toBe('https://niwa.co.nz/cliflo');
    expect(qrText(layer, { url: '' })).toBeNull();
    expect(qrText(layer, null)).toBeNull();
    expect(qrText(layer, undefined)).toBeNull();
  });
});

describe('encodeQr', () => {
  it('builds a square matrix of the smallest version that fits', () => {
    const m = encodeQr('https://example.org', 'M');
    expect(m.count).toBe(25); // version 2
    expect(m.modules.length).toBe(25 * 25);
    // The top-left finder pattern: a dark 7 x 7 ring.
    expect([...m.modules.slice(0, 7)]).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(m.modules[1 * 25 + 1]).toBe(0);
    expect(encodeQr(LONG, 'H').count).toBeGreaterThan(encodeQr(LONG, 'L').count);
  });

  for (const level of QR_LEVELS) {
    for (const [name, text] of [
      ['short url', 'https://example.org'],
      ['long url', LONG],
      ['UTF-8 text', 'Te Awa Tupua — Whanganui, 12.30 mm, Māori ✓'],
    ] as const) {
      it(`decodes back: ${name} at level ${level}`, () => {
        expect(decode(encodeQr(text, level), 4)).toBe(text);
      });
    }
  }

  it('decodes with other margins and module sizes', () => {
    const m = encodeQr('https://example.org/more-info', 'Q');
    expect(decode(m, 4, 2)).toBe('https://example.org/more-info');
    expect(decode(m, 2, 6)).toBe('https://example.org/more-info');
  });

  it('fits exactly the largest capacity, and fails clearly beyond it', () => {
    const level: QrLevel = 'H';
    const max = QR_MAX_BYTES[level];
    expect(encodeQr('a'.repeat(max), level).count).toBe(177); // version 40
    expect(() => encodeQr('a'.repeat(max + 1), level)).toThrow(/too long for a QR code: 1274 bytes, at most 1273 at level H/);
    // Counted in UTF-8 bytes: "ā" is two.
    expect(utf8Length('ā1')).toBe(3);
    expect(() => encodeQr('ā'.repeat(1000), 'Q')).toThrow(/2000 bytes, at most 1663/);
    expect(encodeQr('a'.repeat(QR_MAX_BYTES.L), 'L').count).toBe(177);
  });
});

describe('qrTexels', () => {
  it('surrounds the code with light margin modules, rows bottom-up', () => {
    const m: QrMatrix = { count: 2, modules: Uint8Array.from([1, 0, 0, 1]) };
    expect(qrSide(m, 1)).toBe(4);
    // Top row of the code (1, 0) lands on texture row 2 (counting from the bottom).
    expect([...qrTexels(m, 1)]).toEqual([0, 0, 0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 0, 0, 0, 0]);
    expect([...qrTexels(m, 0)]).toEqual([0, 255, 255, 0]);
  });

  it('reuses an output buffer of the right length', () => {
    const m = encodeQr('x', 'L');
    const out = new Uint8Array(qrSide(m, 4) ** 2).fill(7);
    expect(qrTexels(m, 4, out)).toBe(out);
    expect(out[0]).toBe(0);
    expect(qrTexels(m, 3, out)).not.toBe(out);
  });
});
