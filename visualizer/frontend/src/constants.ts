/**
 * Perceptual space dimension — sized to fit the highest perceptualMapping
 * offset across the example machine corpus (4109 at time of writing, with
 * a safety margin of ~0.5%).
 *
 * The Reality Engine's PerceptualSpace and the Perception Engine's
 * persistentVector both auto-grow to fit machine mappings, so this constant
 * is *not* a hard cap on what the backend supports — it is the
 * default-display size used by frontend heatmap/legend components and the
 * default length for algorithmic vector generators.
 *
 * Change only here; all components import PERCEPTUAL_DIM from this file.
 */
export const PERCEPTUAL_DIM = 4128;
