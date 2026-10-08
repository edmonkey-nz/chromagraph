/**
 * Pure helpers for starting the output window from the control window: reading the monitor
 * layout and building Chrome's command line. Process handling is in `launcher.ts`.
 */

export interface Monitor {
  name: string;
  primary: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LaunchMode = 'projector' | 'window';

/**
 * Parse `xrandr --listmonitors`, whose lines look like
 * ` 0: +*eDP-1 1920/340x1080/190+0+0  eDP-1` (`*` marks the primary monitor).
 */
export function parseMonitors(text: string): Monitor[] {
  const out: Monitor[] = [];
  const re = /^\s*\d+:\s+\+?(\*?)(\S+)\s+(\d+)\/\d+x(\d+)\/\d+([+-]\d+)([+-]\d+)/;
  for (const line of text.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    out.push({
      name: m[2] ?? '',
      primary: m[1] === '*',
      width: Number(m[3]),
      height: Number(m[4]),
      x: Number(m[5]),
      y: Number(m[6]),
    });
  }
  return out;
}

/**
 * The monitor the projector is on: the first one that isn't the primary (the laptop panel),
 * or the primary if it is the only one. Null when nothing was detected.
 */
export function pickProjector(monitors: Monitor[]): Monitor | null {
  return monitors.find((m) => !m.primary) ?? monitors[0] ?? null;
}

export interface ChromeLaunch {
  args: string[];
  env: Record<string, string>;
}

/**
 * Chrome's arguments and extra environment for the output window.
 *
 * On this laptop's GNOME Wayland desktop Chrome only reaches the NVIDIA GPU when it runs under
 * X11 (XWayland) with PRIME offload: forcing the NVIDIA render node on Wayland crashes it
 * (the compositor rejects the frames). See the README's GPU section.
 */
export function chromeLaunch(opts: {
  mode: LaunchMode;
  url: string;
  profileDir: string;
  monitor: Monitor | null;
  nvidia: boolean;
}): ChromeLaunch {
  const { mode, url, profileDir, monitor, nvidia } = opts;
  const args = [
    '--ozone-platform=x11',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-session-crashed-bubble',
    '--disable-features=Translate',
  ];
  if (mode === 'projector') {
    if (monitor) args.push(`--window-position=${monitor.x},${monitor.y}`);
    args.push('--kiosk', url);
  } else {
    // A normal, draggable window on the primary screen; F11 makes it full screen.
    args.push('--window-size=1280,760', `--app=${url}`);
  }
  const env: Record<string, string> = nvidia ? { __NV_PRIME_RENDER_OFFLOAD: '1', __GLX_VENDOR_LIBRARY_NAME: 'nvidia' } : {};
  return { args, env };
}

/**
 * True for the main process of a Chrome started with `profileDir`, given its
 * /proc/<pid>/cmdline. Chrome rewrites its process title, so the arguments may be joined by
 * spaces rather than NULs. Helper processes (`--type=gpu-process` and so on) share the
 * profile flag but must not be signalled.
 */
export function isOutputBrowser(cmdline: string, profileDir: string): boolean {
  const args = cmdline.split(/[\0 ]/);
  return args.includes(`--user-data-dir=${profileDir}`) && !args.some((a) => a.startsWith('--type='));
}
