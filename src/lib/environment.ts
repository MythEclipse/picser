/**
 * Heuristic checks to determine if we're running in a serverless/edge environment.
 * Uses feature detection first (Edge/Workers/Deno) and falls back to well-known
 * provider environment variables as a secondary signal.
 */
export function isServerlessEnvironment(): boolean {
  try {
    // Deno runtime → treated as serverless-style (detect via globalThis)
    if ((globalThis as any).Deno !== undefined) return true;

    // Edge workers and Cloudflare Workers typically have `fetch` on globalThis
    // but do not expose Node's `process` object.
    if ((globalThis as any).fetch !== undefined && (globalThis as any).process === undefined) {
      return true;
    }

    // If process exists, check common serverless env vars (fallback)
    if (typeof process !== "undefined" && process.env) {
      const serverlessVars = [
        "VERCEL",
        "AWS_LAMBDA_FUNCTION_NAME",
        "FUNCTIONS_WORKER_RUNTIME",
        "K_SERVICE",
        "GCP_PROJECT",
        "GCLOUD_PROJECT",
      ];

      for (const v of serverlessVars) {
        if (process.env[v]) return true;
      }
    }
  } catch (e) {
    // Fail safe → assume not serverless
    // Log at debug level so we have visibility when troubleshooting
    // but don't throw since detection is heuristic.
    // eslint-disable-next-line no-console
    console.debug("isServerlessEnvironment detection error:", e);
  }

  return false;
}
