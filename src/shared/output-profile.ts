import { z } from 'zod';
import { IDENTITY_QUAD, isConvexQuad, type Quad } from './homography.ts';

/**
 * Output profile: calibration for one venue/projector, kept outside projects
 * (output-profiles/<name>.json) so a project can move between rooms.
 */
export const OUTPUT_PROFILE_VERSION = 1;

const corner = z.tuple([z.number().min(-1).max(2), z.number().min(-1).max(2)]);

export const OutputProfileSchema = z.object({
  version: z.literal(OUTPUT_PROFILE_VERSION),
  name: z.string(),
  /**
   * Where the 1920x1080 image's corners land in the output window: TL, TR, BR, BL, in
   * normalised window coordinates ((0,0) top-left, (1,1) bottom-right). Identity fills
   * the window. Corners may sit slightly outside the window.
   */
  corners: z
    .tuple([corner, corner, corner, corner])
    .refine((q) => isConvexQuad(q as Quad), 'corners must form a convex shape (no corner dragged across another)'),
});
export type OutputProfile = z.infer<typeof OutputProfileSchema>;

export function defaultProfile(name: string): OutputProfile {
  return {
    version: OUTPUT_PROFILE_VERSION,
    name,
    corners: IDENTITY_QUAD.map(([x, y]) => [x, y]) as OutputProfile['corners'],
  };
}
