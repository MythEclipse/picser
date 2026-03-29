import { redisQueue, QueueItem } from "@/lib/redis-queue";
import { Octokit } from "@octokit/rest";
import { getAutoSubmitThreshold } from "@/lib/config";
import { isServerlessEnvironment } from "@/lib/environment";

export const MAX_BATCH_SIZE = 100;
export const BATCH_TIMEOUT = 1000; // 1 second

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
  success?: boolean;
}

export async function processQueue(): Promise<QueueProcessResult> {
  const isServerless = isServerlessEnvironment();
  const useRedis = redisQueue.isEnabled();

  if (!useRedis || isServerless) {
    return {
      message: "Queueing disabled (no Redis or serverless environment)",
      processed: false,
      disabled: true,
      success: false
    };
  }

  let lockToken: string | null = null;
  let items: QueueItem[] = [];

  try {
    const AUTO_SUBMIT_THRESHOLD = getAutoSubmitThreshold();
    const shouldProcess = await redisQueue.shouldProcess();
    const queueSize = await redisQueue.size();
    
    if (queueSize === 0) {
      return { message: "Queue is empty", processed: false, queueSize: 0, success: true };
    }

    const oldestTimestamp = await redisQueue.getOldestTimestamp();
    const isOldEnough = typeof oldestTimestamp === "number" && (Date.now() - oldestTimestamp >= BATCH_TIMEOUT);
    const isFull = queueSize >= AUTO_SUBMIT_THRESHOLD;

    if (!shouldProcess) {
      return { message: "Queue is being processed by another instance", processed: false, success: true };
    }

    if (!isOldEnough && !isFull) {
      return {
        message: "Queue not ready (batch timeout or size not met)",
        processed: false,
        queueSize,
        success: true
      };
    }

    // Attempt to acquire distributed lock
    lockToken = await redisQueue.acquireLock();
    if (!lockToken) {
      return { message: "Lock acquisition failed (concurrent processing)", processed: false, success: true };
    }

    // CRITICAL SECTION START
    items = await redisQueue.getItems(MAX_BATCH_SIZE, 100 * 1024 * 1024);
    if (items.length === 0) {
      return { message: "Queue is empty after lock", processed: false, success: true };
    }

    console.log(`[process-queue] Processing batch of ${items.length} files (Distributed Instance: ${Math.random().toString(36).substring(7)})`);

    const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
    const owner = process.env.GITHUB_OWNER!;
    const repo = process.env.GITHUB_REPO!;
    const branch = process.env.GITHUB_BRANCH || "main";

    // Serialized blob creation for Rate-Limit avoidance
    const blobs: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
    for (const item of items) {
      const { data: blob } = await octokit.git.createBlob({ owner, repo, content: item.base64Content, encoding: "base64" });
      blobs.push({ path: item.filename, mode: "100644", type: "blob", sha: blob.sha });
    }

    const commitMessage = items.length === 1 
      ? `Upload: ${items[0].originalName}` 
      : `Batch upload ${items.length} images`;

    // RETRY LOOP FOR REF UPDATE (handles "not a fast forward" 422 errors)
    let finalCommitSha: string | null = null;
    let updateRetries = 0;
    const maxUpdateRetries = 5;

    while (updateRetries <= maxUpdateRetries) {
      try {
        // 1. Get latest head ref
        const { data: refData } = await octokit.git.getRef({ owner, repo, ref: `heads/${branch}` });
        const latestHeadSha = refData.object.sha;
        const { data: latestCommit } = await octokit.git.getCommit({ owner, repo, commit_sha: latestHeadSha });
        
        // 2. Create tree on top of latest head
        const { data: newTree } = await octokit.git.createTree({ 
          owner, repo, base_tree: latestCommit.tree.sha, tree: blobs 
        });

        // 3. Create commit
        const { data: newCommit } = await octokit.git.createCommit({
          owner, repo, message: commitMessage, tree: newTree.sha, parents: [latestHeadSha]
        });

        // 4. Update ref
        await octokit.git.updateRef({ 
          owner, repo, ref: `heads/${branch}`, sha: newCommit.sha, force: false 
        });
        
        finalCommitSha = newCommit.sha;
        break; // Success!
      } catch (err: unknown) {
        const error = err as { status?: number; message?: string };
        if (error.status === 422 && error.message?.includes("not a fast forward") && updateRetries < maxUpdateRetries) {
          updateRetries++;
          console.warn(`[process-queue] Conflict detected (not a fast forward). Retry ${updateRetries}/${maxUpdateRetries}...`);
          // Brief jittered delay
          await new Promise(r => setTimeout(r, Math.random() * 1000 + 200));
          continue;
        }
        throw error;
      }
    }

    if (!finalCommitSha) throw new Error("Failed to update GitHub ref after retries");

    await redisQueue.removeItems(items.length);

    // Update individual item statuses to 'success'
    for (const item of items) {
      const urls = {
        github: `https://github.com/${owner}/${repo}/blob/${branch}/${item.filename}`,
        raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.filename}`,
        jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${item.filename}`,
        github_commit: `https://github.com/${owner}/${repo}/blob/${finalCommitSha}/${item.filename}`,
        raw_commit: `https://raw.githubusercontent.com/${owner}/${repo}/${finalCommitSha}/${item.filename}`,
        jsdelivr_commit: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${finalCommitSha}/${item.filename}`,
      };

      await redisQueue.setItemStatus(item.filename, {
        status: "success",
        filename: item.filename,
        urls,
        url: urls.jsdelivr_commit,
        commit_sha: finalCommitSha,
        timestamp: Date.now(),
      });
    }

    return {
      success: true,
      processed: true,
      batchSize: items.length,
      commitSha: finalCommitSha,
      message: `Successfully batch uploaded ${items.length} files`
    };

  } catch (error) {
    console.error("[process-queue] Distributed worker error:", error);
    
    // Attempt to mark items as failed if we have them in memory
    if (items && items.length > 0) {
      for (const item of items) {
         await redisQueue.setItemStatus(item.filename, {
          status: "failed",
          filename: item.filename,
          error: error instanceof Error ? error.message : "Batch upload failed",
          timestamp: Date.now(),
        }).catch(() => {});
      }
    }

    return {
      success: false,
      processed: false,
      error: error instanceof Error ? error.message : "Unknown error",
      message: "Internal worker exception"
    };
  } finally {
    if (lockToken) {
      await redisQueue.releaseLock(lockToken);
    }
  }
}
