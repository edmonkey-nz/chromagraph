import { describe, expect, it } from 'vitest';
import { chromeLaunch, isOutputBrowser, parseMonitors, pickProjector } from '../../src/server/launch-args.ts';

const LAPTOP_ONLY = 'Monitors: 1\n 0: +*eDP-1 1920/340x1080/190+0+0  eDP-1\n';
const WITH_PROJECTOR = 'Monitors: 2\n 0: +*eDP-1 1920/340x1080/190+0+0  eDP-1\n 1: +HDMI-1 1920/1600x1080/900+1920+0  HDMI-1\n';

describe('parseMonitors', () => {
  it('reads name, primary flag, size and position', () => {
    expect(parseMonitors(WITH_PROJECTOR)).toEqual([
      { name: 'eDP-1', primary: true, width: 1920, height: 1080, x: 0, y: 0 },
      { name: 'HDMI-1', primary: false, width: 1920, height: 1080, x: 1920, y: 0 },
    ]);
  });

  it('handles negative offsets (projector to the left)', () => {
    const m = parseMonitors(' 1: +HDMI-1 1920/1600x1080/900-1920+0  HDMI-1');
    expect(m[0]).toMatchObject({ x: -1920, y: 0 });
  });

  it('returns nothing for unexpected output', () => {
    expect(parseMonitors('')).toEqual([]);
    expect(parseMonitors("Can't open display")).toEqual([]);
  });
});

describe('pickProjector', () => {
  it('prefers the non-primary monitor', () => {
    expect(pickProjector(parseMonitors(WITH_PROJECTOR))?.name).toBe('HDMI-1');
  });
  it('falls back to the only monitor, then to null', () => {
    expect(pickProjector(parseMonitors(LAPTOP_ONLY))?.name).toBe('eDP-1');
    expect(pickProjector([])).toBeNull();
  });
});

describe('chromeLaunch', () => {
  const base = { url: 'http://127.0.0.1:8080/output/', profileDir: '/home/x/.config/data-wrangler-output' };
  const projector = pickProjector(parseMonitors(WITH_PROJECTOR));

  it('kiosk on the projector, under X11, in its own profile, with PRIME offload', () => {
    const { args, env } = chromeLaunch({ ...base, mode: 'projector', monitor: projector, nvidia: true });
    expect(args).toContain('--ozone-platform=x11');
    expect(args).toContain(`--user-data-dir=${base.profileDir}`);
    expect(args).toContain('--window-position=1920,0');
    expect(args.slice(-2)).toEqual(['--kiosk', base.url]);
    expect(env).toEqual({ __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia' });
  });

  it('a movable app window, no position, and no PRIME variables without the NVIDIA driver', () => {
    const { args, env } = chromeLaunch({ ...base, mode: 'window', monitor: null, nvidia: false });
    expect(args).toContain(`--app=${base.url}`);
    expect(args).not.toContain('--kiosk');
    expect(args.some((a) => a.startsWith('--window-position'))).toBe(false);
    expect(env).toEqual({});
  });
});

describe('isOutputBrowser', () => {
  const dir = '/home/x/.config/data-wrangler-output';
  it('matches the main process only, NUL- or space-separated', () => {
    expect(isOutputBrowser(`/opt/google/chrome/chrome\0--user-data-dir=${dir}\0--kiosk\0`, dir)).toBe(true);
    expect(isOutputBrowser(`/opt/google/chrome/chrome --ozone-platform=x11 --user-data-dir=${dir} --kiosk`, dir)).toBe(true);
    expect(isOutputBrowser(`/opt/google/chrome/chrome --type=gpu-process --user-data-dir=${dir}`, dir)).toBe(false);
    expect(isOutputBrowser('/opt/google/chrome/chrome --user-data-dir=/home/x/.config/google-chrome', dir)).toBe(false);
    expect(isOutputBrowser(`/opt/google/chrome/chrome --user-data-dir=${dir}-old`, dir)).toBe(false);
  });
});
