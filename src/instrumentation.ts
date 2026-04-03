import { processQueue } from "@/lib/queue-processor";
import { logger } from "@/lib/logger";

export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    logger.info("[Instrumentation] Starting background queue processor...");

    // Process queue every 2 seconds for anti-burst batching
    setInterval(async () => {
      try {
        const result = await processQueue();
        if (result.processed) {
          logger.info(`[Instrumentation] Processed queue: ${result.message}`);
        }
      } catch (error) {
        logger.error("[Instrumentation] Error processing queue:", error);
      }
    }, 2000); // 2 second interval
  }
}
