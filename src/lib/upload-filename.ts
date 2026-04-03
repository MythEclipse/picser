import crypto from "crypto";

export function buildDeterministicUploadFilename(
  buffer: Buffer,
  originalName: string,
  folder = "uploads",
): { filename: string; contentHash: string } {
  const contentHash = crypto.createHash("sha256").update(buffer).digest("hex");
  const extension = getNormalizedExtension(originalName);
  const cleanFolder = folder.replace(/^\/+|\/+$/g, "") || "uploads";

  return {
    filename: `${cleanFolder}/${contentHash}.${extension}`,
    contentHash,
  };
}

function getNormalizedExtension(fileName: string): string {
  const rawExtension = fileName.split(".").pop()?.trim().toLowerCase();

  if (rawExtension && /^[a-z0-9]+$/.test(rawExtension)) {
    return rawExtension;
  }

  return "jpg";
}