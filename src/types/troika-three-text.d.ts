/**
 * Minimal types for troika-three-text (the package ships none that TypeScript can find).
 * Only what the text layer uses; extend as needed.
 */
declare module 'troika-three-text' {
  import type { Color, Material, Mesh } from 'three';

  export class Text extends Mesh {
    text: string;
    /** URL of a .ttf/.otf/.woff font, or null for the default (fetched by troika's font resolver). */
    font: string | null;
    /** em-box height in local units (output px here). */
    fontSize: number;
    anchorX: number | string;
    anchorY: number | string;
    textAlign: 'left' | 'right' | 'center' | 'justify';
    maxWidth: number;
    /** Multiple of fontSize, or 'normal'. */
    lineHeight: number | string;
    /** In em units. */
    letterSpacing: number;
    whiteSpace: 'normal' | 'nowrap';
    color: string | number | Color | null;
    fillOpacity: number;
    outlineWidth: number | string;
    outlineColor: string | number | Color;
    outlineOpacity: number;
    depthOffset: number;
    sdfGlyphSize: number | null;
    /** Base material; troika derives its SDF material from it (prototype-inherited). */
    material: Material | Material[];
    /** Lays the text out in troika's worker; the old geometry renders until it completes. */
    sync(callback?: () => void): void;
    /** Disposes the glyph geometry (not the base material). */
    dispose(): void;
  }
}
