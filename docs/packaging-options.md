# Packaging data-wrangler as an app for Windows, macOS and Linux

FUTURE.md item 24: can data-wrangler become something you download and double-click,
on Windows, macOS and Ubuntu? This page compares the options. Nothing has been built yet.

## Where it stands today

data-wrangler is three parts: a Node server, a control window and an output window. Both
windows are web pages shown in Chrome. To run it you need Node, `npm install`, then
`npm run dev` (or `npm run build && npm start`), and Chrome open on two URLs.

What stops it from being a one-click app:

| Problem | Why it matters |
|---|---|
| Needs Node, npm and a terminal | Not something to hand to a non-developer. |
| TypeScript runs at start-up (`tsx`) | Fine for development; an app should ship plain JavaScript. |
| The **Output** buttons are Linux-only | They use `xrandr` to find the projector, `/proc` to find Chrome, and Linux Chrome paths and flags. |
| Projects live inside the code folder | An installed app can't write into its own folder (Program Files, /Applications). Projects, calibration profiles and `server-state.json` must move to a per-user folder. |
| `npm start` uses Unix shell syntax | `NODE_ENV=production …` fails in a Windows command prompt. |
| The "sans" font downloads from the internet | Offline venues would fall back or stall; it should be bundled like VT323. |
| The GPU warning checks for "NVIDIA" | It warns wrongly on machines with dedicated AMD, Intel or Apple graphics. |
| Fixed port 8080 | It could clash with something else on another machine. |

Everything else (the server, the rendering, the data parsing) is already cross-platform.

## Groundwork every option needs

These are worth doing whichever option is chosen, and most of them improve the Linux setup
today as well.

| Work | Effort |
|---|---|
| Move projects, profiles and state to a per-user folder (e.g. `Documents/data-wrangler`), with a one-off move of existing projects | ½ day |
| Build the server into plain JavaScript (one bundled file), with a cross-platform start | ½ day |
| Bundle the sans font for offline use | 1 hour |
| GPU check that knows dedicated from integrated GPUs on all vendors | 1–2 hours |
| Pick a free port when 8080 is taken | 1 hour |
| Automated builds and tests on all three systems (GitHub Actions) | ½–1 day |

Testing on Windows and macOS needs real machines (or the CI runners). Only Linux can be
tested on the current laptop.

## The options

### A. Portable folder per system

A zip for each system, containing a copy of Node, the built app, and a double-click start
file (`start.bat`, `start.command`, `start.sh`). It starts the server and opens the control
window in Chrome. The output still opens in the installed Chrome.

- **Extra effort:** about 1 day, plus porting the Output buttons to Windows and macOS (finding
  Chrome, listing displays, placing a window on the projector, closing it): about 1 day.
- **Size:** about 40–60 MB per system.
- **Good:** smallest change to how it works now; easy to update (replace the folder).
- **Not so good:** Chrome must be installed; a terminal window stays open behind it; the
  projector-window logic has to be written three times.

### B. Single executable (Node "single executable application")

Like A, but the server and its files are packed into one program file per system.

- **Extra effort:** about 1–2 days, plus the same Output-button porting as A.
- **Size:** about 80–120 MB per file.
- **Good:** one file to copy.
- **Not so good:** still needs Chrome; macOS needs the file re-signed after packing, and
  this Node feature is newer and less travelled than the alternatives.

### C. Electron app (recommended for handing to other people)

A real desktop app with its own copy of Chromium (the engine inside Chrome). The server runs
inside the app; the control and output are app windows.

- **Output windows done properly:** Electron can list the displays and open the output full
  screen on the chosen one in kiosk mode, on every system. That replaces the Linux-only
  Output-button code instead of porting it.
- **No Chrome needed**, and the same Chromium version everywhere, so WebGL behaves the same
  on every machine.
- **GPU:** it can ask for the high-performance GPU on Windows and macOS laptops. Linux hybrid
  graphics still need the PRIME offload variables, which the app's launcher can set.
- **Installations:** start at login, open straight into the last project, no browser chrome
  or tabs.
- **Robustness:** the server should run in its own background process (Electron's
  "utility process"), so a server crash can't take the output window down. That keeps the
  rule that the output never goes dark.
- **The control window can still be opened in a browser** on another computer or tablet on
  the same network, as it can now when the server is started with `HOST=0.0.0.0`.
- **Extra effort:** about 3–4 days on top of the groundwork.
- **Size:** about 100–150 MB per system. Installers: `.exe` (Windows), `.dmg` (macOS),
  AppImage or `.deb` (Linux).

### D. Tauri (not recommended)

A small app that uses the system's built-in web view instead of bundling Chromium. On Linux
that web view is WebKitGTK, whose WebGL performance is poor and can't be steered to the
dedicated GPU, and each system would behave differently. That defeats the purpose here.

## Signing and warnings

Apps downloaded from the internet are checked by Windows and macOS:

- **macOS:** an unsigned app is blocked. People can still open it through System Settings →
  Privacy & Security → **Open Anyway**. Signing it properly needs an Apple Developer account
  (US$99 a year) plus Apple's notarisation step, which the automated build can do.
- **Windows:** an unsigned app shows a SmartScreen warning ("More info → Run anyway").
  A code-signing certificate costs from about US$10 a month (Microsoft's signing service) to
  a few hundred dollars a year.
- **Linux:** no signing needed.

Unsigned builds are fine for your own machines and for people you can talk through the
warning.

## Effort summary

| Option | Groundwork | Option work | Total | Chrome needed | Best for |
|---|---|---|---|---|---|
| A. Portable folder | 2–3 days | 2 days | ~4–5 days | yes | You, on a few machines |
| B. Single executable | 2–3 days | 2–3 days | ~5 days | yes | Same, with one file |
| C. Electron | 2–3 days | 3–4 days | ~6–7 days | no | Other people; installations |

## Suggested path

1. Do the groundwork first. It helps whatever comes next, and the Linux setup gains
   offline fonts, a per-user projects folder and a fairer GPU check.
2. Then choose A or C:
   - **A** if it's only for you on two or three machines;
   - **C** if other people will install it, or for unattended installations on
     Windows or Mac machines.
3. Decide on signing once there's a build people actually download.

## Questions to settle before building

- Who installs it: only you, or other people too?
- Is macOS needed, or Windows and Linux only?
- Is a signing budget available (Apple US$99 a year; Windows optional)?
- Should the control window stay usable from another device on the network?
