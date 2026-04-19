import { NextRequest, NextResponse } from "next/server";
import { verifyFileAccessible } from "@/lib/file-verification";
import { Octokit } from "@octokit/rest";
import { validateImage } from "@/lib/image-validation";
import { logger } from "@/lib/logger";
import { buildDeterministicUploadFilename } from "@/lib/upload-filename";

export const runtime = "nodejs";

function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    logger.error(`[Upload API] Missing required environment variable: ${name}`);
  }
  return value;
}

/**
 * Direct upload to GitHub (used when queueing is disabled)
 */
async function directUpload(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  filename: string,
  base64Content: string,
  originalName: string,
) {
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

    const githubToken = getRequiredEnv("GITHUB_TOKEN");
    const owner = getRequiredEnv("GITHUB_OWNER");
    const repo = getRequiredEnv("GITHUB_REPO");
    const branch = process.env.GITHUB_BRANCH || "main";

    if (!githubToken || !owner || !repo) {
      return NextResponse.json(
        {
          error: "Missing required GitHub environment configuration: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO",
          note: "Set these variables in Docker / container environment before running the upload API",
        },
        { status: 500 },
      );
    }

    const octokit = new Octokit({
      auth: githubToken,
    });

    const { filename, contentHash } = buildDeterministicUploadFilename(buffer, file.name);

    try {
      const { data: existingFile } = await octokit.repos.getContent({
        owner,
        repo,
        path: filename,
        ref: branch,
      });

      if (!Array.isArray(existingFile) && "sha" in existingFile) {
        const urls = {
          github: `https://github.com/${owner}/${repo}/blob/${branch}/${filename}`,
          raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`,
          jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filename}`,
          github_commit: `https://github.com/${owner}/${repo}/blob/${existingFile.sha}/${filename}`,
          raw_commit: `https://raw.githubusercontent.com/${owner}/${repo}/${existingFile.sha}/${filename}`,
          jsdelivr_commit: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${existingFile.sha}/${filename}`,
        };

        logger.info(`[Upload API] Deduplicated upload for ${filename} (hash=${contentHash})`);

        return NextResponse.json({
          success: true,
          filename,
          content_hash: contentHash,
          urls,
          github_url: `https://github.com/${owner}/${repo}/blob/${branch}/${filename}`,
          url: urls.jsdelivr,
          mode: "direct",
          note: "Duplicate content detected; existing file reused",
          deduplicated: true,
        }, { status: 200 });
      }
    } catch (error) {
      const octokitError = error as { status?: number };
      if (octokitError.status !== 404) {
        throw error;
      }
    }

    logger.info(`[Upload API] Using direct upload for file ${filename}`);
    const result = await directUpload(octokit, owner, repo, branch, filename, base64Content, file.name);

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
      note: "Uploaded directly to GitHub",
      url: result.urls.jsdelivr,
      github_url: result.urls.github,
      content_hash: contentHash,
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
  return NextResponse.json({
    message: "Image upload API endpoint",
    methods: ["POST", "DELETE"],
    maxFileSize: "100MB",
    allowedTypes: ["image/*"],
    mode: "direct",
    note: "Uploads are sent directly to GitHub and return CDN URLs immediately",
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

    const githubToken = getRequiredEnv("GITHUB_TOKEN");
    const owner = getRequiredEnv("GITHUB_OWNER");
    const repo = getRequiredEnv("GITHUB_REPO");
    const branch = process.env.GITHUB_BRANCH || "main";

    if (!githubToken || !owner || !repo) {
      return NextResponse.json(
        {
          error: "Missing required GitHub environment configuration: GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO",
          note: "Set these variables in Docker / container environment before running the delete API",
        },
        { status: 500 },
      );
    }

    const octokit = new Octokit({
      auth: githubToken,
    });

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
