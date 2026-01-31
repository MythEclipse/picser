import { NextRequest, NextResponse } from "next/server";
import { redisQueue } from "@/lib/redis-queue";
import { uploadQueue } from "@/lib/upload-queue";
import { Octokit } from "@octokit/rest";

export const runtime = "edge";
export const maxDuration = 60; // 60 seconds max

const MAX_BATCH_SIZE = 100;
import { getAutoSubmitThreshold } from "@/lib/config";
const AUTO_SUBMIT_THRESHOLD = getAutoSubmitThreshold(); // auto-submit when queue reaches this
const BATCH_TIMEOUT = 5000; // 5 seconds

export async function POST(request: NextRequest) {
  try {
    // Autodetect queue: use Redis if enabled, else fallback to in-memory
    const useRedis = redisQueue.isEnabled();
    let queueSize = 0;
    let oldestTimestamp = null;
    let isOldEnough = false;
    let isFull = false;
    let shouldProcess = false;

    // Auto-detect serverless/edge; if running serverless or no Redis, disable queueing
    const isServerless = (await import("@/lib/environment")).isServerlessEnvironment();
    if (!useRedis || isServerless) {
      return NextResponse.json({
        message: "Queueing disabled (no Redis or serverless environment)",
        processed: false,
        disabled: true,
        queueSize: 0,
      });
    }

    // Use Redis to check readiness
    shouldProcess = await redisQueue.shouldProcess();
    queueSize = await redisQueue.size();
    oldestTimestamp = await redisQueue.getOldestTimestamp();
    isOldEnough = typeof oldestTimestamp === "number" && Date.now() - oldestTimestamp >= BATCH_TIMEOUT;
    isFull = queueSize >= AUTO_SUBMIT_THRESHOLD;

    if (!shouldProcess) {
      return NextResponse.json({
        message: "Queue is being processed or empty",
        processed: false,
      });
    }

    if (!isOldEnough && !isFull) {
      return NextResponse.json({
        message: "Queue not ready yet",
        queueSize,
        waitingTime: oldestTimestamp ? Date.now() - oldestTimestamp : 0,
        processed: false,
      });
    }

    // If using in-memory queue, process it directly
    if (!useRedis) {
      const processedCount = await uploadQueue.processNow();
      if (processedCount === 0) {
        return NextResponse.json({
          message: "Queue is empty",
          processed: false,
        });
      }
      return NextResponse.json({
        message: "Processed in-memory queue",
        processed: true,
        processedCount,
      });
    }

    // Try to acquire lock for Redis-based processing
    const lockAcquired = await redisQueue.acquireLock();
    if (!lockAcquired) {
      return NextResponse.json({
        message: "Another process is handling the queue",
        processed: false,
      });
    }

    try {
      // Get items from queue
      const items = await redisQueue.getItems(MAX_BATCH_SIZE);
      if (items.length === 0) {
        await redisQueue.releaseLock();
        return NextResponse.json({
          message: "Queue is empty",
          processed: false,
        });
      }

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

      console.log(`Successfully uploaded batch of ${items.length} files`);

      return NextResponse.json({
        success: true,
        processed: true,
        batchSize: items.length,
        commitSha: newCommit.sha,
        message: `Uploaded ${items.length} files in single commit`,
      });
    } finally {
      // Always release lock
      await redisQueue.releaseLock();
    }
  } catch (error) {
    console.error("Queue processor error:", error);

    // Release lock on error
    try {
      await redisQueue.releaseLock();
    } catch (e) {
      // Ignore lock release errors
    }

    if (error instanceof Error) {
      return NextResponse.json(
        {
          error: `Queue processing failed: ${error.message}`,
          processed: false,
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { error: "Queue processing failed: Unknown error", processed: false },
      { status: 500 },
    );
  }
}

export async function GET() {
  try {
    const queueSize = await redisQueue.size();
    const oldestTimestamp = await redisQueue.getOldestTimestamp();

    return NextResponse.json({
      queueSize,
      oldestTimestamp,
      waitingTime: oldestTimestamp ? Date.now() - oldestTimestamp : 0,
      maxBatchSize: MAX_BATCH_SIZE,
      batchTimeout: BATCH_TIMEOUT,
    });
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to get queue status" },
      { status: 500 },
    );
  }
}
