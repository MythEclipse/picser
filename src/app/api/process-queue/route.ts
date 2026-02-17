import { NextRequest, NextResponse } from "next/server";
import { redisQueue } from "@/lib/redis-queue";
import {
  processQueue,
  MAX_BATCH_SIZE,
  BATCH_TIMEOUT,
} from "@/lib/queue-processor";

export const runtime = "edge";
export const maxDuration = 60; // 60 seconds max

export async function POST(request: NextRequest) {
  const result = await processQueue();

  if (result.error) {
    return NextResponse.json(result, { status: 500 });
  }

  return NextResponse.json(result);
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
