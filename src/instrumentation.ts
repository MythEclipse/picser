import { processQueue } from "@/lib/queue-processor";

export async function register() {
  if (
    process.env.NEXT_RUNTIME === "nodejs" &&
    process.env.NEXT_PHASE !== "phase-production-build"
  ) {
    console.log("[Instrumentation] Starting background queue processor...");

    // Process queue every 5 seconds
    setInterval(async () => {
      try {
        const result = await processQueue();
        if (result.processed) {
          console.log(`[Instrumentation] Processed queue: ${result.message}`);
        }
      } catch (error) {
        console.error("[Instrumentation] Error processing queue:", error);
      }
    }, 5000);
  }
}
