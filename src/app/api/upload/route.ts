import { NextRequest, NextResponse } from "next/server";
import { redisQueue } from "@/lib/redis-queue";
import { Octokit } from "@octokit/rest";

export const runtime = "edge";

/**
 * Direct upload to GitHub (fallback when Redis not available)
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
  let response;

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

  if (!response) {
    throw new Error("Failed to upload after retries");
  }

  const commitSha = response.data.commit.sha;

  return {
    success: true,
    url: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`,
    urls: {
      github: `https://github.com/${owner}/${repo}/blob/${branch}/${filename}`,
      raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`,
      jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filename}`,
      github_commit: `https://github.com/${owner}/${repo}/blob/${commitSha}/${filename}`,
      raw_commit: `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${filename}`,
      jsdelivr_commit: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${commitSha}/${filename}`,
    },
    filename,
    commit_sha: commitSha,
    github_url: response.data.content?.html_url,
    mode: "direct",
  };
}

export async function POST(request: NextRequest) {
  // Check environment (Disable queue on Vercel due to background trigger limitations)
  const isServerless = process.env.VERCEL === "1";

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
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const extension = file.name.split(".").pop() || "jpg";
    const filename = `uploads/${timestamp}-${Math.random().toString(36).substr(2, 9)}.${extension}`;

    // Check if Redis queue is enabled AND NOT in serverless mode
    if (redisQueue.isEnabled() && !isServerless) {
      // Use Redis queue for batch processing
      await redisQueue.add({
        filename,
        base64Content,
        originalName: file.name,
        size: file.size,
        type: file.type,
        timestamp: Date.now(),
      });

      const queueSize = await redisQueue.size();

      // Trigger queue processor safely
      try {
        // Use absolute URL based on the request origin to avoid Edge fetch issues
        const baseUrl = new URL(request.url).origin;
        const processorUrl = `${baseUrl}/api/process-queue`;

        // Fire and forget
        fetch(processorUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        }).catch(() => {
          // Silent fail. In serverless, background fetch often fails.
          // We rely on Client-Side Smart Polling or Cron.
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
        url: predictedUrls.raw, // For backward compatibility
        urls: predictedUrls, // Start using predicted URLs immediately
        size: file.size,
        type: file.type,
        queueSize,
        mode: "queued",
        note: "File will be uploaded in batch (up to 100 files or after 5 seconds)",
      });
    } else {
      // Fallback to direct upload
      console.log(
        `Using direct upload (Redis: ${redisQueue.isEnabled()}, Serverless: ${isServerless})`,
      );
      const result = await directUpload(filename, base64Content, file.name);

      return NextResponse.json({
        ...result,
        size: file.size,
        type: file.type,
        note: isServerless
          ? "Uploaded directly (Queue disabled on Serverless)"
          : "Uploaded directly (Redis queue not configured)",
      });
    }
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
