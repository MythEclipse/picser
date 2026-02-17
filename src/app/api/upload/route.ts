import { NextRequest, NextResponse } from "next/server";
import { redisQueue } from "@/lib/redis-queue";
import { Octokit } from "@octokit/rest";
import { processQueue } from "@/lib/queue-processor";

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
  const maxRetries = 3;
  let response: any;

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
    } catch (error: any) {
      if (error.status === 409 && retries < maxRetries) {
        retries++;
        const waitTime = Math.pow(2, retries) * 100;
        await new Promise((resolve) => setTimeout(resolve, waitTime));
        continue;
      }
      throw error;
    }
  }

  if (!response) throw new Error("Failed to upload after retries");

  const commitSha = response?.data?.content?.sha ?? response?.data?.commit?.sha;

  return {
    success: true,
    filename,
    urls: {
      github: `https://github.com/${owner}/${repo}/blob/${branch}/${filename}`,
      raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`,
      jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filename}`,
    },
    commit_sha: commitSha,
  };
}

export async function POST(request: NextRequest) {
  // Auto-detect serverless/edge environment
  const isServerless = (
    await import("@/lib/environment")
  ).isServerlessEnvironment();

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
    const base64Content = buffer.toString("base64");

    // Generate unique filename
    const timestamp = new Date()
      .toISOString()
      .replaceAll(":", "-")
      .replaceAll(".", "-");
    const extension = file.name.split(".").pop() || "jpg";
    const filename = `uploads/${timestamp}-${Math.random().toString(36).slice(2, 11)}.${extension}`;

    // If Redis is available and not serverless, queue for batch processing
    if (redisQueue.isEnabled() && !isServerless) {
      const origin = new URL(request.url).origin;
      await redisQueue.add({
        filename,
        base64Content,
        originalName: file.name,
        size: file.size,
        type: file.type,
        timestamp: Date.now(),
        origin,
      });

      const queueSize = await redisQueue.size();

      // Trigger queue processor safely
      try {
        const baseUrl = new URL(request.url).origin;
        const processorUrl = `${baseUrl}/api/process-queue`;

        // Fire and forget
        processQueue().catch((err) => {
          console.error("Background queue processing failed:", err);
        });
      } catch (e) {
        // Ignore
      }

      // Generate predicted URLs (optimistic)
      const owner = process.env.GITHUB_OWNER!;
      const repo = process.env.GITHUB_REPO!;
      const branch = process.env.GITHUB_BRANCH || "main";

      const predictedUrls = {
        github: `https://github.com/${owner}/${repo}/blob/${branch}/${filename}`,
        raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`,
        jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filename}`,
      };

      return NextResponse.json({
        success: true,
        message: "File queued for batch upload",
        filename,
        url: predictedUrls.raw,
        urls: predictedUrls,
        size: file.size,
        type: file.type,
        queueSize,
        mode: "queued",
        note: "File will be uploaded in batch (up to 100 files or after 5 seconds)",
      });
    }

    // If Redis is not available (or we're in serverless), queue mode is disabled.
    // Perform direct upload immediately (one commit per upload).
    console.log(
      `Direct upload mode (Redis: ${redisQueue.isEnabled()}, Serverless: ${isServerless})`,
    );
    const result = await directUpload(filename, base64Content, file.name);

    return NextResponse.json({
      ...result,
      size: file.size,
      type: file.type,
      mode: "direct",
      note: isServerless
        ? "Uploaded directly (Queue disabled on Serverless)"
        : "Uploaded directly (Redis queue not configured)",
    });
  } catch (error) {
    console.error("Upload error:", error);

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

  return NextResponse.json({
    message: "Image upload API endpoint",
    methods: ["POST"],
    maxFileSize: "100MB",
    allowedTypes: ["image/*"],
    redis: {
      enabled: redisEnabled,
      status: redisEnabled ? "Queue batching active" : "Direct upload mode",
    },
    batching: redisEnabled
      ? {
          enabled: true,
          maxBatchSize: 100,
          batchTimeout: "5 seconds",
          description:
            "Files are queued in Redis and uploaded in a single commit",
          persistent: true,
          serverlessSafe: true,
        }
      : {
          enabled: false,
          description: "Direct upload with retry logic (Redis not configured)",
        },
  });
}
