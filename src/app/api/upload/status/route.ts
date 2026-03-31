import { NextRequest, NextResponse } from "next/server";
import { redisQueue } from "@/lib/redis-queue";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Missing id query parameter" }, { status: 400 });
  }

  if (!redisQueue.isEnabled()) {
    return NextResponse.json({ error: "Redis queue not enabled" }, { status: 503 });
  }

  const status = await redisQueue.getStatusById(id);

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
