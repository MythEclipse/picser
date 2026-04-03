import { NextRequest, NextResponse } from "next/server";
import { redisQueue } from "@/lib/redis-queue";
import { Octokit } from "@octokit/rest";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  const filename = request.nextUrl.searchParams.get("filename");

  if (!id && !filename) {
    return NextResponse.json({ error: "Missing id or filename query parameter" }, { status: 400 });
  }

  if (!redisQueue.isEnabled()) {
    return NextResponse.json({ error: "Redis queue not enabled" }, { status: 503 });
  }

  let status = id
    ? await redisQueue.getStatusById(id)
    : await redisQueue.getStatusByFilename(filename as string);

  if (!status && filename) {
    // Fallback: verify file existence in GitHub if status expired/evicted
    try {
      const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
      const owner = process.env.GITHUB_OWNER!;
      const repo = process.env.GITHUB_REPO!;
      const branch = process.env.GITHUB_BRANCH || "main";

      const { data } = await octokit.repos.getContent({ owner, repo, path: filename, ref: branch });

      if (!Array.isArray(data) && 'sha' in data) {
        const commitSha = data.sha;

        const urls = {
          github: `https://github.com/${owner}/${repo}/blob/${branch}/${filename}`,
          raw: `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`,
          jsdelivr: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${filename}`,
          github_commit: `https://github.com/${owner}/${repo}/blob/${commitSha}/${filename}`,
          raw_commit: `https://raw.githubusercontent.com/${owner}/${repo}/${commitSha}/${filename}`,
          jsdelivr_commit: `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${commitSha}/${filename}`,
        };

        status = {
          status: "success",
          filename,
          urls,
          url: urls.jsdelivr,
          commit_sha: commitSha,
          timestamp: Date.now(),
        };
      }
    } catch {
      // ignore - nothing found
    }
  }

  if (!status) {
    return NextResponse.json({
      status: "unknown",
      message: "No status found. It may not have been queued yet or key expired.",
      id,
    }, { status: 404 });
  }

  if (status.status === "success") {
    return NextResponse.json({ ...status, id }, { status: 200 });
  }

  if (status.status === "failed") {
    return NextResponse.json({ ...status, id }, { status: 500 });
  }

  return NextResponse.json({ ...status, id }, { status: 202 });
}
