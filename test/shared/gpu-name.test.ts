import { describe, expect, it } from 'vitest';
import { gpuInfo } from '../../src/shared/gpu-name.ts';

describe('GPU names', () => {
  it.each([
    ['ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1650/PCIe/SSE2, OpenGL 4.5.0 NVIDIA 595.99.02)', 'GTX 1650', 'nvidia'],
    ['ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'RTX 3060', 'nvidia'],
    ['ANGLE (AMD, AMD Radeon Graphics (radeonsi, renoir, LLVM 17.0.6, DRM 3.57, 6.8.0), OpenGL 4.6)', 'Radeon Graphics', 'other'],
    ['ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00005917) Direct3D11 vs_5_0 ps_5_0, D3D11)', 'UHD Graphics 620', 'other'],
    ['ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'ANGLE Metal Renderer: M2', 'other'],
    ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'SwiftShader', 'software'],
    ['llvmpipe (LLVM 15.0.7, 256 bits)', 'llvmpipe', 'software'],
    ['ANGLE (AMD, Vulkan 1.3.274 (AMD Radeon Graphics (RADV RENOIR) (0x00001636)), radv-24.0.9-0ubuntu0.1)', 'Radeon Graphics', 'other'],
    ['ANGLE (AMD, AMD Radeon Graphics (renoir, LLVM 17.0.6, DRM 3.57, 6.8.0-45-generic), OpenGL 4.6 (Core Profile) Mesa 24.0.9)', 'Radeon Graphics', 'other'],
    ['AMD Radeon RX 6600 (navi23)', 'Radeon RX 6600', 'other'],
    ['', 'unknown', 'unknown'],
  ])('%s', (renderer, name, kind) => {
    expect(gpuInfo(renderer)).toEqual({ name, kind });
  });
});
