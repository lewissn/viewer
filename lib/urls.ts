const MODEL_EXTENSIONS = /\.(3ds|obj|stl|ply|glb|gltf)$/i;

/**
 * Normalize Dropbox URLs and clean up user input.
 * - Trims whitespace
 * - Removes empty lines
 * - Deduplicates
 * - Converts Dropbox dl=0 → dl=1
 */
export function normalizeUrls(raw: string): string[] {
  const lines = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of lines) {
    let url = line;
    if (url.includes("dropbox.com") && url.includes("dl=0")) {
      url = url.replace("dl=0", "dl=1");
    }
    if (!seen.has(url)) {
      seen.add(url);
      result.push(url);
    }
  }

  return result;
}

/**
 * Validate that the URL list contains at least one model file.
 */
export function validateUrls(urls: string[]): { valid: boolean; error?: string } {
  if (urls.length === 0) {
    return { valid: false, error: "At least one URL is required." };
  }

  const hasModel = urls.some((u) => {
    // Strip query string and fragment before checking extension
    const path = u.split("?")[0].split("#")[0];
    return MODEL_EXTENSIONS.test(path);
  });
  if (!hasModel) {
    return {
      valid: false,
      error: "At least one URL must be a 3D model file (.3ds, .obj, .stl, .ply, .glb, .gltf).",
    };
  }

  return { valid: true };
}
