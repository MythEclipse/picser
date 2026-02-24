import sharp from "sharp";

/**
 * Validates an image buffer to ensure it is a valid image and not corrupted.
 * It uses sharp to fully decode the image pixels (via stats computation).
 *
 * @param buffer - The original image file buffer
 * @returns A Promise resolving to the image metadata
 * @throws Error if the image is invalid or corrupted
 */
export async function validateImage(buffer: Buffer): Promise<sharp.Metadata> {
  try {
    const image = sharp(buffer);

    // Read metadata (this validates the header)
    const metadata = await image.metadata();

    // Compute statistics (this fully decodes the pixel data, catching deeper corruption)
    await image.stats();

    return metadata;
  } catch (error: any) {
    console.warn(`[ImageValidator] Rejected input buffer: ${error.message}`);
    throw new Error("Invalid or corrupted image file");
  }
}
