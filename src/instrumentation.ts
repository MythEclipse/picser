import { processQueue } from "@/lib/queue-processor";

export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    console.log("[Instrumentation] Starting background queue processor...");

    // Process queue every 1 second for fast batching
    setInterval(async () => {
      try {
        const result = await processQueue();
        if (result.processed) {
          console.log(`[Instrumentation] Processed queue: ${result.message}`);
        }
      } catch (error) {
        console.error("[Instrumentation] Error processing queue:", error);
      }
    }, 1000);
  }
}
