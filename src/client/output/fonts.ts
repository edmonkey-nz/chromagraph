import terminalFont from './fonts/VT323-Regular.ttf?url';

/**
 * Fonts for in-scene text (troika). 'terminal' is VT323, a fixed-width 1970s DEC terminal
 * face (SIL Open Font License, see fonts/VT323-OFL.txt), bundled so an offline installation
 * never waits on a font download; it is the default. 'sans' is troika's own default (Roboto,
 * fetched by troika). Anything else is the URL of a font the app serves.
 */
export const TERMINAL_FONT_URL: string = terminalFont;

export function fontUrl(font: string): string | null {
  if (font === 'terminal') return TERMINAL_FONT_URL;
  if (font === 'sans') return null;
  return font;
}

/** Text as shown: in capitals when `uppercase` (the source text is kept as written). */
export function displayText(s: string, uppercase: boolean): string {
  return uppercase ? s.toLocaleUpperCase('en-NZ') : s;
}
