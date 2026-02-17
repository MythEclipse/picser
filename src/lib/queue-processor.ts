import { redisQueue } from "@/lib/redis-queue";
import { uploadQueue } from "@/lib/upload-queue";
import { Octokit } from "@octokit/rest";
import { getAutoSubmitThreshold } from "@/lib/config";

export const MAX_BATCH_SIZE = 100;
export const BATCH_TIMEOUT = 5000; // 5 seconds

export interface QueueProcessResult {
  processed: boolean;
  message: string;
  queueSize?: number;
  waitingTime?: number;
  processedCount?: number;
  batchSize?: number;
  commitSha?: string;
  error?: string;
  disabled?: boolean;
}

export async function processQueue(): Promise<QueueProcessResult> {
  try {
    // Autodetect queue: use Redis if enabled, else fallback to in-memory
    const useRedis = redisQueue.isEnabled();

    // Auto-detect serverless/edge; if running serverless or no Redis, disable queueing
    const isServerless = (
      await import("@/lib/environment")
    ).isServerlessEnvironment();

    if (!useRedis || isServerless) {
      return {
        message: "Queueing disabled (no Redis or serverless environment)",
        processed: false,
        disabled: true,
        queueSize: 0,
      };
    }

    const AUTO_SUBMIT_THRESHOLD = getAutoSubmitThreshold();

    // Use Redis to check readiness
    const shouldProcess = await redisQueue.shouldProcess();
    const queueSize = await redisQueue.size();
    const oldestTimestamp = await redisQueue.getOldestTimestamp();
    const isOldEnough =
      typeof oldestTimestamp === "number" &&
      Date.now() - oldestTimestamp >= BATCH_TIMEOUT;
    const isFull = queueSize >= AUTO_SUBMIT_THRESHOLD;

    console.log(
      `[process-queue] Queue status - size: ${queueSize}, shouldProcess: ${shouldProcess}, isOldEnough: ${isOldEnough}, isFull: ${isFull}, AUTO_SUBMIT_THRESHOLD: ${AUTO_SUBMIT_THRESHOLD}`,
    );

    if (!shouldProcess) {
      console.log(
        "[process-queue] Cannot process: queue is being processed or empty",
      );
      return {
        message: "Queue is being processed or empty",
        processed: false,
      };
    }

    if (!isOldEnough && !isFull) {
      console.log(
        `[process-queue] Queue not ready - waiting for timeout or size. Age: ${oldestTimestamp ? Date.now() - oldestTimestamp : 0}ms (threshold: ${BATCH_TIMEOUT}ms), Size: ${queueSize} (threshold: ${AUTO_SUBMIT_THRESHOLD})`,
      );
      return {
        message: "Queue not ready yet",
        queueSize,
        waitingTime: oldestTimestamp ? Date.now() - oldestTimestamp : 0,
        processed: false,
      };
    }

    // If using in-memory queue, process it directly
    if (!useRedis) {
      const processedCount = await uploadQueue.processNow();
      if (processedCount === 0) {
        return {
          message: "Queue is empty",
          processed: false,
        };
      }
      return {
        message: "Processed in-memory queue",
        processed: true,
        processedCount,
      };
    }

    // Try to acquire lock for Redis-based processing
    const lockAcquired = await redisQueue.acquireLock();
    if (!lockAcquired) {
      return {
        message: "Another process is handling the queue",
        processed: false,
      };
    }

    try {
      // Get items from queue (100MB limit for batch)
      const items = await redisQueue.getItems(
        MAX_BATCH_SIZE,
        100 * 1024 * 1024,
      );
      console.log(`[process-queue] Retrieved ${items.length} items from queue`);
      if (items.length === 0) {
        await redisQueue.releaseLock();
        return {
          message: "Queue is empty",
          processed: false,
        };
      }

      // Calculate total size
      const totalSize = items.reduce((sum, item) => sum + item.size, 0);
      console.log(
        `[process-queue] Total batch size: ${(totalSize / 1024 / 1024).toFixed(2)}MB`,
      );

      console.log(`Processing batch of ${items.length} files`);

      // Upload batch to GitHub
      const octokit = new Octokit({
        auth: process.env.GITHUB_TOKEN,
      });

      const owner = process.env.GITHUB_OWNER!;
      const repo = process.env.GITHUB_REPO!;
      const branch = process.env.GITHUB_BRANCH || "main";

      // Get current commit
      const { data: refData } = await octokit.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      const currentCommitSha = refData.object.sha;

      const { data: currentCommit } = await octokit.git.getCommit({
        owner,
        repo,
        commit_sha: currentCommitSha,
      });
      const currentTreeSha = currentCommit.tree.sha;

      // Create blobs
      const blobs = await Promise.all(
        items.map(async (item) => {
          const { data: blob } = await octokit.git.createBlob({
            owner,
            repo,
            content: item.base64Content,
            encoding: "base64",
          });
          return {
            path: item.filename,
            mode: "100644" as const,
            type: "blob" as const,
            sha: blob.sha,
          };
        }),
      );

      // Create tree
      const { data: newTree } = await octokit.git.createTree({
        owner,
        repo,
        base_tree: currentTreeSha,
        tree: blobs,
      });

      // Create commit
      const fileNames = items.map((item) => item.originalName).join(", ");
      const commitMessage =
        items.length === 1
          ? `Upload image: ${fileNames}`
          : `Batch upload ${items.length} images: ${fileNames.substring(0, 100)}${fileNames.length > 100 ? "..." : ""}`;

      const { data: newCommit } = await octokit.git.createCommit({
        owner,
        repo,
        message: commitMessage,
        tree: newTree.sha,
        parents: [currentCommitSha],
      });

      // Update reference
      await octokit.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: newCommit.sha,
      });

      // Remove processed items from queue
      await redisQueue.removeItems(items.length);
      console.log(`[process-queue] Removed ${items.length} items from queue`);

      console.log(`Successfully uploaded batch of ${items.length} files`);

      return {
        success: true,
        processed: true,
        batchSize: items.length,
        commitSha: newCommit.sha,
        message: `Uploaded ${items.length} files in single commit`,
      } as any; // Cast for now as success field isn't in interface but useful
    } finally {
      // Always release lock
      await redisQueue.releaseLock();
    }
  } catch (error) {
    console.error("[process-queue] Queue processor error:", error);
    if (error instanceof Error) {
      console.error("[process-queue] Error message:", error.message);
      console.error("[process-queue] Error stack:", error.stack);
    }

    // Release lock on error
    try {
      await redisQueue.releaseLock();
    } catch (e) {
      // Ignore lock release errors
    }

    if (error instanceof Error) {
      return {
        error: `Queue processing failed: ${error.message}`,
        processed: false,
        message: error.message,
      };
    }

    return {
      error: "Queue processing failed: Unknown error",
      processed: false,
      message: "Unknown error",
    };
  }
}
