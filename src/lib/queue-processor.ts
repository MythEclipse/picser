import { redisQueue, QueueItem, ItemStatus } from "@/lib/redis-queue";
import { Octokit } from "@octokit/rest";
import { getAutoSubmitThreshold } from "@/lib/config";
import { isServerlessEnvironment } from "@/lib/environment";

export const MAX_BATCH_SIZE = 100;
export const LOCK_REFRESH_MS = 30000; // 30 seconds
export const MAX_ITEM_ATTEMPTS = 3;

async function directUploadSingleToGithub(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  item: QueueItem,
) {
  const message = `Fallback direct upload: ${item.originalName}`;

  const response = await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: item.filename,
    message,
    content: item.base64Content,
    branch,
  });

  const commitSha = response?.data?.content?.sha ?? response?.data?.commit?.sha;
  return commitSha;
}
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
  let lockRefresher: ReturnType<typeof setInterval> | null = null;
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

      lockRefresher = setInterval(async () => {
        if (lockToken) {
          const renewed = await redisQueue.renewLock(lockToken);
          if (!renewed) {
            console.warn("[process-queue] Failed to renew lock (possibly stolen)");
          }
        }
      }, LOCK_REFRESH_MS);

      // CRITICAL SECTION START: move items into in-progress set to avoid reprocessing
      items = await redisQueue.moveBatchToProcessing(MAX_BATCH_SIZE);
      if (items.length === 0) {
        return { message: "Queue is empty after lock", processed: false, success: true };
      }

      console.log(`[process-queue] Processing batch of ${items.length} files (Distributed Instance: ${Math.random().toString(36).substring(7)})`);

      // Increment attempts and separate items that should still be processed.
      const processableItems: QueueItem[] = [];
      for (const item of items) {
        item.attempts = (item.attempts ?? 0) + 1;
        if (item.attempts > MAX_ITEM_ATTEMPTS) {
          const failedPayload: ItemStatus = {
            status: "failed",
            filename: item.filename,
            error: "Max retry attempts exceeded",
            timestamp: Date.now(),
          };
          if (item.id) {
            await redisQueue.setItemStatus(item.id, failedPayload).catch(() => {});
          }
          await redisQueue.setItemStatus(item.filename, failedPayload).catch(() => {});
          continue;
        }
        processableItems.push(item);
      }

      if (processableItems.length === 0) {
        await redisQueue.removeProcessedItems(items.length);
        return {
          success: true,
          processed: true,
          batchSize: 0,
          message: "All items exceeded retry limit, none processed",
        };
      }

      const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
      const owner = process.env.GITHUB_OWNER!;
      const repo = process.env.GITHUB_REPO!;
      const branch = process.env.GITHUB_BRANCH || "main";

    // Serialized blob creation for Rate-Limit avoidance
    const blobs: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
    const failedItems: QueueItem[] = [];

    for (const item of processableItems) {
      try {
        const { data: blob } = await octokit.git.createBlob({ owner, repo, content: item.base64Content, encoding: "base64" });
        blobs.push({ path: item.filename, mode: "100644", type: "blob", sha: blob.sha });
      } catch (blobErr) {
        const errMessage = blobErr instanceof Error ? blobErr.message : "Blob creation failed";
        const failedPayload: ItemStatus = {
          status: "failed",
          filename: item.filename,
          error: errMessage,
          timestamp: Date.now(),
        };
        if (item.id) await redisQueue.setItemStatus(item.id, failedPayload).catch(() => {});
        await redisQueue.setItemStatus(item.filename, failedPayload).catch(() => {});

        if ((item.attempts ?? 0) < MAX_ITEM_ATTEMPTS) {
          failedItems.push(item);
        }
      }
    }

    const itemsToCommit = processableItems.filter(item => !failedItems.includes(item));
    const commitMessage = itemsToCommit.length === 1 
      ? `Upload: ${itemsToCommit[0].originalName}` 
      : `Batch upload ${itemsToCommit.length} images`;

    const requeueItems: QueueItem[] = [];
    for (const item of failedItems) {
      if ((item.attempts ?? 0) < MAX_ITEM_ATTEMPTS) {
        requeueItems.push(item);
      }
    }

    if (itemsToCommit.length === 0) {
      if (requeueItems.length > 0) {
        await redisQueue.requeueItems(requeueItems);
      }
      await redisQueue.removeProcessedItems(items.length);
      return {
        success: false,
        processed: false,
        batchSize: 0,
        message: "All processable items failed blob creation, queued for retry where possible",
      };
    }

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

    if (!finalCommitSha) {
      console.warn("[process-queue] Batch commit not obtained after retries, attempting per-item fallback upload");

      let anythingSucceeded = false;
      const retryAfterFallback: QueueItem[] = [];

      for (const item of itemsToCommit) {
        try {
          const itemCommitSha = await directUploadSingleToGithub(octokit, owner, repo, branch, item);
          anythingSucceeded = true;

          const urls = {
            github: `https://github.com/${owner}/${repo}/blob/${branch}/${item.filename}`,
            raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.filename}`,
            jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${item.filename}`,
            github_commit: `https://github.com/${owner}/${repo}/blob/${itemCommitSha}/${item.filename}`,
            raw_commit: `https://raw.githubusercontent.com/${owner}/${repo}/${itemCommitSha}/${item.filename}`,
            jsdelivr_commit: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${itemCommitSha}/${item.filename}`,
          };

          const statusPayload: ItemStatus = {
            status: "success",
            filename: item.filename,
            urls,
            url: urls.jsdelivr_commit,
            commit_sha: itemCommitSha,
            timestamp: Date.now(),
          };

          if (item.id) await redisQueue.setItemStatus(item.id, statusPayload);
          await redisQueue.setItemStatus(item.filename, statusPayload);
        } catch (itemErr) {
          const errMessage = itemErr instanceof Error ? itemErr.message : "Unknown per-item fallback error";
          const statusPayload: ItemStatus = {
            status: "failed",
            filename: item.filename,
            error: errMessage,
            timestamp: Date.now(),
          };
          if (item.id) await redisQueue.setItemStatus(item.id, statusPayload).catch(() => {});
          await redisQueue.setItemStatus(item.filename, statusPayload).catch(() => {});

          if ((item.attempts ?? 0) < MAX_ITEM_ATTEMPTS) {
            retryAfterFallback.push(item);
          }
        }
      }

      // Requeue items that can still be retried after failed fallback.
      if (retryAfterFallback.length > 0) {
        await redisQueue.requeueItems(retryAfterFallback);
      }

      // Drain queue after fallback attempt to avoid reprocessing same items repeatedly
      await redisQueue.removeProcessedItems(items.length);

      return {
        success: anythingSucceeded,
        processed: true,
        batchSize: items.length,
        commitSha: anythingSucceeded ? "partial-fallback" : undefined,
        message: anythingSucceeded
          ? "Batch commit failed, fallback per-item uploads completed (some may have failed)"
          : "Batch commit and per-item fallback uploads both failed",
        error: anythingSucceeded ? undefined : "Batch+Fallback failed",
      };
    }

    await redisQueue.removeProcessedItems(items.length);

    // Update individual item statuses to 'success'
    for (const item of itemsToCommit) {
      const urls = {
        github: `https://github.com/${owner}/${repo}/blob/${branch}/${item.filename}`,
        raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.filename}`,
        jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${item.filename}`,
        github_commit: `https://github.com/${owner}/${repo}/blob/${finalCommitSha}/${item.filename}`,
        raw_commit: `https://raw.githubusercontent.com/${owner}/${repo}/${finalCommitSha}/${item.filename}`,
        jsdelivr_commit: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${finalCommitSha}/${item.filename}`,
      };

      const statusPayload: ItemStatus = {
        status: "success",
        filename: item.filename,
        urls,
        url: urls.jsdelivr_commit,
        commit_sha: finalCommitSha,
        timestamp: Date.now(),
      };

      // Store by id and by filename for compatibility
      if (item.id) {
        await redisQueue.setItemStatus(item.id, statusPayload);
      }
      await redisQueue.setItemStatus(item.filename, statusPayload);
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
        const failedPayload: ItemStatus = {
          status: "failed",
          filename: item.filename,
          error: error instanceof Error ? error.message : "Batch upload failed",
          timestamp: Date.now(),
        };

        if (item.id) {
          await redisQueue.setItemStatus(item.id, failedPayload).catch(() => {});
        }
        await redisQueue.setItemStatus(item.filename, failedPayload).catch(() => {});
      }
      // Avoid infinite reprocessing of same failed items
      await redisQueue.removeProcessedItems(items.length);
    }

    return {
      success: false,
      processed: false,
      error: error instanceof Error ? error.message : "Unknown error",
      message: "Internal worker exception"
    };
  } finally {
    if (lockRefresher) {
      clearInterval(lockRefresher);
    }
    if (lockToken) {
      await redisQueue.releaseLock(lockToken);
    }
  }
}
