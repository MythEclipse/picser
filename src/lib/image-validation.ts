import sharp from "sharp";

/**
 * Validates an image buffer to ensure it is a valid image format.
 * It uses sharp to parse the image headers and metadata.
 *
 * @param buffer - The original image file buffer
 * @returns A Promise resolving to the image metadata
 * @throws Error if the image format is invalid or corrupted metadata
 */
export async function validateImage(buffer: Buffer): Promise<sharp.Metadata> {
  try {
    const image = sharp(buffer);

    // Read metadata (this strictly validates the header and magic bytes)
    const metadata = await image.metadata();

    return metadata;
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    console.warn(`[ImageValidator] Rejected input buffer: ${msg}`);
    throw new Error("Invalid or corrupted image file");
  }
}
