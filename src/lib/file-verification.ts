/**
 * Verify that a file is accessible via GitHub/CDN before returning to user
 * Uses exponential backoff to handle GitHub's processing delay
 */
export async function verifyFileAccessible(
  url: string,
  maxAttempts: number = 15,
  initialDelay: number = 500
): Promise<boolean> {
  let attempt = 0;
  let delay = initialDelay;

  while (attempt < maxAttempts) {
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'follow',
        // Use shorter timeout for HEAD requests
        signal: AbortSignal.timeout(5000),
      });

      // Success on 2xx status
      if (response.ok) {
        return true;
      }

      // 404 means file not accessible yet, retry
      if (response.status === 404) {
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, delay));
        // Exponential backoff: 500ms, 750ms, 1125ms, etc
        delay = Math.min(delay * 1.5, 3000);
        continue;
      }

      // Other server errors, also retry
      if (response.status >= 500) {
        attempt++;
        await new Promise((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 1.5, 3000);
        continue;
      }

      // Other errors (403, 429, etc) - don't retry, might be permission issue
      return false;
    } catch (error) {
      // Network error or timeout, retry
      attempt++;
      if (attempt >= maxAttempts) break;
      
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 1.5, 3000);
    }
  }

  return false;
}
