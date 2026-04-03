import { NextRequest, NextResponse } from "next/server";
import { redisQueue } from "@/lib/redis-queue";
import { verifyFileAccessible } from "@/lib/file-verification";
import crypto from "crypto";
import { Octokit } from "@octokit/rest";
import { validateImage } from "@/lib/image-validation";
import { isServerlessEnvironment } from "@/lib/environment";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

/**
 * Direct upload to GitHub (used when queueing is disabled)
 */
async function directUpload(
  filename: string,
  base64Content: string,
  originalName: string,
) {
  const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
  });

  const owner = process.env.GITHUB_OWNER!;
  const repo = process.env.GITHUB_REPO!;
  const branch = process.env.GITHUB_BRANCH || "main";

  let retries = 0;
  const maxRetries = 10;
  type OctokitResponse = Awaited<ReturnType<typeof octokit.repos.createOrUpdateFileContents>>;
  let response: OctokitResponse | undefined;

  while (retries <= maxRetries) {
    try {
      response = await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: filename,
        message: `Upload image: ${originalName}`,
        content: base64Content,
        branch,
      });
      break;
    } catch (error: unknown) {
      const octokitError = error as { status?: number };
      if (octokitError.status === 409 && retries < maxRetries) {
        retries++;
        // Exponential backoff with significant jitter to avoid thundering herd on Github API
        const baseWait = Math.pow(2, retries) * 150;
        const jitter = Math.random() * 500;
        await new Promise((resolve) => setTimeout(resolve, baseWait + jitter));
        continue;
      }
      throw error;
    }
  }

  if (!response) throw new Error("Failed to upload after retries");

  // Use commit SHA (not content SHA)
  const commitSha = response.data.commit.sha;

  return {
    success: true,
    filename,
    urls: {
      // Branch-based URLs (recommended - immediate access)
      github: `https://github.com/${owner}/${repo}/blob/${branch}/${filename}`,
      raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`,
      jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filename}`,
      // Commit-based URLs (permanent - fixed reference)
      github_commit: `https://github.com/${owner}/${repo}/blob/${commitSha}/${filename}`,
      raw_commit: `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${filename}`,
      jsdelivr_commit: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${commitSha}/${filename}`,
    },
    commit_sha: commitSha,
  };
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    // Validate file type
    if (!file.type.startsWith("image/")) {
      return NextResponse.json(
        { error: "Only image files are allowed" },
        { status: 400 },
      );
    }

    // Validate file size (max 100MB)
    if (file.size > 100 * 1024 * 1024) {
      return NextResponse.json(
        { error: "File size must be less than 100MB" },
        { status: 400 },
      );
    }

    // Convert file to base64
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Audit / Validate the image buffer to ensure it is not corrupted
    try {
      await validateImage(buffer);
    } catch {
      return NextResponse.json(
        { error: "Image validation failed: File is corrupted or invalid" },
        { status: 400 },
      );
    }

    const base64Content = buffer.toString("base64");

    // Generate unique filename based on SHA-256 hash + random suffix to avoid collisions
    const hashSum = crypto.createHash("sha256");
    hashSum.update(buffer);
    const hash = hashSum.digest("hex").slice(0, 16); // Use first 16 chars for shortness
    const extension = file.name.split(".").pop() || "jpg";
    const suffix = crypto.randomUUID().slice(0, 8);
    const filename = `uploads/${hash}-${suffix}.${extension}`;

    // Determine if we should queue or do direct upload
    const isServerless = isServerlessEnvironment();
    const queued = redisQueue.isEnabled() && !isServerless;

    if (queued) {
      // Queue-based: Return instant CDN URL optimistically, process in background
      const id = crypto.randomUUID();
      const owner = process.env.GITHUB_OWNER!;
      const repo = process.env.GITHUB_REPO!;
      const branch = process.env.GITHUB_BRANCH || "main";
      
      // Generate optimistic CDN URLs (will be available once batch processor completes)
      const optimisticUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filename}`;
      const optimisticUrls = {
        github: `https://github.com/${owner}/${repo}/blob/${branch}/${filename}`,
        raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`,
        jsdelivr: optimisticUrl,
      };

      const pendingStatus = {
        status: 'pending' as const,
        filename,
        url: optimisticUrl,
        timestamp: Date.now(),
      };

      // Store pending status for polling
      await redisQueue.setItemStatus(id, pendingStatus);
      await redisQueue.setItemStatus(filename, pendingStatus);

      try {
        // Queue the upload for batch processing
        await redisQueue.add({
          id,
          filename,
          base64Content,
          originalName: file.name,
          size: file.size,
          type: file.type,
          timestamp: Date.now(),
          origin: new URL(request.url).origin,
          attempts: 0,
        });
        
        logger.info(`[Upload API] File ${filename} queued (id=${id}). Returning optimistic CDN URL.`);
        
        // Return 200 OK with instant CDN URL (optimistic response)
        // Actual confirmation happens in background queue processor
        return NextResponse.json({
          success: true,
          id,
          filename,
          urls: optimisticUrls,
          url: optimisticUrl,
          size: file.size,
          type: file.type,
          mode: "queued-batch",
          note: "Upload queued for batch processing. CDN URL available optimistically; check status endpoint if issues.",
          statusUrl: `${new URL(request.url).origin}/api/upload/status?id=${encodeURIComponent(id)}`,
        }, { status: 200 }); // 200 OK - user gets instant URL
      } catch (queueError) {
        if (queueError instanceof Error && queueError.message.includes("queue is full")) {
          return NextResponse.json({ error: queueError.message }, { status: 429 });
        }
        // Fall through to direct upload on queue error
        logger.warn(`[Upload API] Queue add failed for ${filename}, falling back to direct upload`, queueError);
      }
    }

    // Fallback: Direct upload (serverless or queue unavailable)
    logger.info(`[Upload API] Using direct upload for file ${filename} (serverless=${isServerless}, queued=${queued})`);
    const result = await directUpload(filename, base64Content, file.name);

    // Verify file is accessible before returning URL
    logger.info(`[Upload API] Verifying direct uploaded file ${filename} is accessible`);
    const isAccessible = await verifyFileAccessible(result.urls.jsdelivr, 7, 300);
    
    if (!isAccessible) {
      logger.warn(`[Upload API] File ${filename} uploaded but not immediately accessible, returning anyway`);
    } else {
      logger.info(`[Upload API] File ${filename} verified accessible, returning URLs`);
    }

    return NextResponse.json({
      ...result,
      size: file.size,
      type: file.type,
      mode: "direct",
      note: "Uploaded directly (no batch queue)",
      url: result.urls.jsdelivr,
    }, { status: 200 });
  } catch (error) {
    logger.error("Upload error:", error);

    if (error instanceof Error) {
      return NextResponse.json(
        { error: `Upload failed: ${error.message}` },
        { status: 500 },
      );
    }

    return NextResponse.json(
      { error: "Upload failed: Unknown error" },
      { status: 500 },
    );
  }
}

export async function GET() {
  const redisEnabled = redisQueue.isEnabled();
  const isServerless = isServerlessEnvironment();

  return NextResponse.json({
    message: "Image upload API endpoint",
    methods: ["POST", "DELETE"],
    maxFileSize: "100MB",
    allowedTypes: ["image/*"],
    mode: redisEnabled && !isServerless ? "queued-batch" : "direct",
    redis: {
      enabled: redisEnabled,
      status: redisEnabled && !isServerless ? "Batch processing enabled" : "Queue disabled or serverless",
    },
    note: redisEnabled && !isServerless
      ? "Uploads return instant CDN URL (200 OK) and are batch-processed. Multiple uploads are queued to prevent Git conflicts."
      : "Direct upload mode - no batch processing",
  });
}

export async function DELETE(request: NextRequest) {
  try {
    const data = await request.json();
    const filenameOrUrl = data.filename || data.url;

    if (!filenameOrUrl) {
      return NextResponse.json(
        { error: "No filename or url provided" },
        { status: 400 },
      );
    }

    // Extract filename if a URL was provided
    let filename = filenameOrUrl;
    if (filename.includes("/")) {
      filename = filename.split("/").pop();
      if (!filename.startsWith("uploads/")) {
        filename = `uploads/${filename}`;
      }
    }

    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
    });

    const owner = process.env.GITHUB_OWNER!;
    const repo = process.env.GITHUB_REPO!;
    const branch = process.env.GITHUB_BRANCH || "main";

    // 1. Get the file's current SHA (Required by GitHub API for deletion)
    let sha: string;
    try {
      const { data: fileData } = await octokit.repos.getContent({
        owner,
        repo,
        path: filename,
        ref: branch,
      });

      if (Array.isArray(fileData)) {
        return NextResponse.json(
          { error: "Path is a directory, not a file" },
          { status: 400 },
        );
      }

      sha = fileData.sha;
    } catch (error: unknown) {
      const octokitError = error as { status?: number };
      if (octokitError.status === 404) {
        return NextResponse.json(
          { error: "File not found in repository", success: true }, // Treat as success if already gone
          { status: 200 },
        );
      }
      throw error;
    }

    // 2. Delete the file using the SHA
    await octokit.repos.deleteFile({
      owner,
      repo,
      path: filename,
      message: `Delete corrupted/audited image: ${filename}`,
      sha,
      branch,
    });

    return NextResponse.json({
      success: true,
      message: `File ${filename} successfully deleted from GitHub`,
    });
  } catch (error) {
    logger.error("Delete error:", error);
    if (error instanceof Error) {
      return NextResponse.json(
        { error: `Delete failed: ${error.message}` },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: "Delete failed: Unknown error" },
      { status: 500 },
    );
  }
}
