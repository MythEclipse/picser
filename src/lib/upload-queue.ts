// Upload Queue Manager for batching uploads
// Collects up to 100 files and uploads them in a single commit after 5 seconds

interface QueueItem {
  file: { name: string; size: number; type: string; lastModified?: number };
  base64Content: string;
  filename: string;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timestamp?: number;
}

class UploadQueue {
  private queue: QueueItem[] = [];
    // Public method to get queue size
    public getSize(): number {
      return this.queue.length;
    }

    // Public method to get oldest timestamp
    public getOldestTimestamp(): number | null {
      if (this.queue.length === 0) return null;
      // Use file.lastModified if available, else fallback to timestamp or Date.now()
      const item = this.queue[0];
      if (item.file && typeof item.file.lastModified === "number") {
        return item.file.lastModified;
      }
      if (typeof item.timestamp === "number") return item.timestamp;
      return Date.now();
    }

    // Public method to manually trigger processing now
    public async processNow(): Promise<number> {
      return await this.processBatch();
    }
  private timer: any = null;
  private processing = false;
  private processingLock = false;
  private readonly MAX_BATCH_SIZE = 100;
  // auto-submit threshold is configurable via env AUTO_SUBMIT_THRESHOLD (default 20)
  private readonly AUTO_SUBMIT_THRESHOLD = ((): number => {
    try {
      const { getAutoSubmitThreshold } = require("@/lib/config");
      return getAutoSubmitThreshold();
    } catch (e) {
      return 20;
    }
  })();
  private readonly BATCH_TIMEOUT = 5000; // 5 seconds

  async add(item: QueueItem): Promise<any> {
    return new Promise((resolve, reject) => {
      this.queue.push({ ...item, resolve, reject, timestamp: Date.now() });

      console.log(`Queue size: ${this.queue.length}`);

      // Auto-submit when threshold reached
      if (this.queue.length >= this.AUTO_SUBMIT_THRESHOLD) {
        console.log(`Auto-submit threshold reached (${this.AUTO_SUBMIT_THRESHOLD}), processing batch`);
        // Start processing immediately
        this.processBatch();
      }

      // Start timer on first item
      if (this.queue.length === 1 && !this.timer && !this.processing) {
        console.log("Starting 5 second timer for batch");
        this.startTimer();
      }

      // Process immediately if batch is full
      if (this.queue.length >= this.MAX_BATCH_SIZE) {
        console.log("Batch full (100 files), processing immediately");
        this.processBatch();
      }
    });
  }

  private startTimer() {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      console.log("5 second timeout reached, processing batch");
      this.processBatch();
    }, this.BATCH_TIMEOUT);
  }

  private async processBatch(): Promise<number> {
    // Prevent concurrent batch processing
    if (this.processingLock) {
      console.log("Another batch is processing, skipping");
      return 0;
    }

    if (this.queue.length === 0) {
      console.log("Queue is empty, nothing to process");
      return 0;
    }

    // Acquire lock
    this.processingLock = true;
    this.processing = true;

    // Clear timer
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    const batch = this.queue.splice(0, this.MAX_BATCH_SIZE);
    const processedCount = batch.length;
    console.log(`Processing batch of ${batch.length} files in single commit`);

    try {
      // Upload all files in a single commit with retry
      let retries = 0;
      const maxRetries = 3;
      let results = null;

      while (retries <= maxRetries && !results) {
        try {
          results = await this.uploadBatch(batch);
          break;
        } catch (error: any) {
          if (
            (error.status === 422 || error.status === 409) &&
            retries < maxRetries
          ) {
            retries++;
            console.log(
              `Batch upload failed (${error.message}), retry ${retries}/${maxRetries}`,
            );
            const waitTime = Math.pow(2, retries) * 500;
            await new Promise((resolve) => setTimeout(resolve, waitTime));
            continue;
          }
          throw error;
        }
      }

      if (!results) {
        throw new Error("Failed to upload batch after retries");
      }

      // Resolve all promises with their results
      batch.forEach((item, index) => {
        item.resolve(results[index]);
      });

      console.log(`Successfully uploaded batch of ${batch.length} files`);
    } catch (error) {
      console.error("Batch upload error:", error);
      // If batch fails, reject all
      batch.forEach((item) => {
        item.reject(error);
      });
    } finally {
      // Release lock
      this.processingLock = false;
      this.processing = false;

      // If there are more items, start a new batch
      if (this.queue.length > 0) {
        console.log(
          `${this.queue.length} files remaining in queue, starting new batch`,
        );
        this.startTimer();
      }
    }

    return processedCount;
  }

  private async uploadBatch(batch: QueueItem[]): Promise<any[]> {
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    const owner = process.env.GITHUB_OWNER!;
    const repo = process.env.GITHUB_REPO!;
    const branch = process.env.GITHUB_BRANCH || "main";

    // Get the current commit SHA (fresh every time to avoid stale data)
    const { data: refData } = await octokit.git.getRef({
      owner,
      repo,
      ref: `heads/${branch}`,
    });
    const currentCommitSha = refData.object.sha;

    // Get the current commit to get the tree SHA
    const { data: currentCommit } = await octokit.git.getCommit({
      owner,
      repo,
      commit_sha: currentCommitSha,
    });
    const currentTreeSha = currentCommit.tree.sha;

    // Create blobs for all files in parallel
    const blobs = await Promise.all(
      batch.map(async (item) => {
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

    // Create a new tree with all files
    const { data: newTree } = await octokit.git.createTree({
      owner,
      repo,
      base_tree: currentTreeSha,
      tree: blobs,
    });

    // Create a new commit
    const fileNames = batch.map((item) => item.file.name).join(", ");
    const commitMessage =
      batch.length === 1
        ? `Upload image: ${fileNames}`
        : `Batch upload ${batch.length} images: ${fileNames.substring(0, 100)}${fileNames.length > 100 ? "..." : ""}`;

    const { data: newCommit } = await octokit.git.createCommit({
      owner,
      repo,
      message: commitMessage,
      tree: newTree.sha,
      parents: [currentCommitSha],
    });

    // Update the reference (this is where conflicts can happen)
    await octokit.git.updateRef({
      owner,
      repo,
      ref: `heads/${branch}`,
      sha: newCommit.sha,
      force: false, // Ensure fast-forward only
    });

    // Generate results for all files
    return batch.map((item) => ({
      success: true,
      url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.filename}`,
      urls: {
        github: `https://github.com/${owner}/${repo}/blob/${branch}/${item.filename}`,
        raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${item.filename}`,
        jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${item.filename}`,
        github_commit: `https://github.com/${owner}/${repo}/blob/${newCommit.sha}/${item.filename}`,
        raw_commit: `https://raw.githubusercontent.com/${owner}/${repo}/${newCommit.sha}/${item.filename}`,
        jsdelivr_commit: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${newCommit.sha}/${item.filename}`,
      },
      filename: item.filename,
      size: item.file.size,
      type: item.file.type,
      commit_sha: newCommit.sha,
      batch_size: batch.length,
      github_url: `https://github.com/${owner}/${repo}/blob/${branch}/${item.filename}`,
    }));
  }
}

// Global queue instance
export const uploadQueue = new UploadQueue();
