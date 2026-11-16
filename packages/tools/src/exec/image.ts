import {createHash} from 'node:crypto';

/** The pinned, approved base image (ADR 0032). Commands never pull. */
export const EXECUTION_IMAGE = 'oven/bun@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d';

/**
 * Optional derived image with Debian's signed `git` package (ADR 0034, dependency catalog). Built
 * explicitly during host setup by `bun scripts/build-exec-image.ts`, never by a command. A locally
 * built image ID is not reproducible across hosts, so the runtime verifies it structurally: its layer
 * chain must start with the exact pinned base chain plus exactly one layer, and carry this recipe hash.
 */
export const GIT_IMAGE_RECIPE = `FROM ${EXECUTION_IMAGE}
RUN apt-get update \\
 && apt-get install -y --no-install-recommends git=1:2.47.3-0+deb13u1 \\
 && rm -rf /var/lib/apt/lists/*
`;
export const GIT_IMAGE_RECIPE_HASH = createHash('sha256').update(GIT_IMAGE_RECIPE).digest('hex');
export const GIT_IMAGE_TAG = 'futryn-exec:git-' + GIT_IMAGE_RECIPE_HASH.slice(0, 16);

interface InspectedImage {
  Id?: string;
  RootFS?: {Layers?: string[]};
  Config?: {Labels?: Record<string, string> | null};
}

/** True when `derived` is exactly the recipe applied on `base`. */
export function verifiedDerivedImage(base: InspectedImage, derived: InspectedImage): boolean {
  const b = base.RootFS?.Layers,
    d = derived.RootFS?.Layers;
  return (
    !!b?.length &&
    !!d &&
    d.length === b.length + 1 &&
    b.every((layer, i) => d[i] === layer) &&
    derived.Config?.Labels?.['futryn.exec.recipe'] === GIT_IMAGE_RECIPE_HASH
  );
}
