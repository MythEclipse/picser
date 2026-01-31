import { Redis } from "@upstash/redis";

// Check if Redis is configured
const isRedisConfigured = () => {
  return !!(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
  );
};

// Initialize Redis client only if configured
let redis: Redis | null = null;
if (isRedisConfigured()) {
  try {
    redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    });
    console.log("Redis queue enabled");
  } catch (error) {
    console.warn("Failed to initialize Redis, queue disabled:", error);
    redis = null;
  }
} else {
  console.log("Redis not configured, queue disabled");
}

const QUEUE_KEY = "upload-queue";
const LOCK_KEY = "upload-queue-lock";
const LOCK_TIMEOUT = 30000; // 30 seconds

export interface QueueItem {
  filename: string;
  base64Content: string;
  originalName: string;
  size: number;
  type: string;
  timestamp: number;
}

export class RedisUploadQueue {
  private enabled: boolean;

  constructor() {
    this.enabled = redis !== null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Add item to queue
   */
  async add(item: QueueItem): Promise<void> {
    if (!this.enabled || !redis) {
      throw new Error("Redis queue not available");
    }
    await redis.lpush(QUEUE_KEY, JSON.stringify(item));
    const queueSize = await redis.llen(QUEUE_KEY);
    console.log(`Added to queue. Queue size: ${queueSize}`);
  }

  /**
   * Get queue size
   */
  async size(): Promise<number> {
    if (!this.enabled || !redis) return 0;
    return await redis.llen(QUEUE_KEY);
  }

  /**
   * Helper to safely parse JSON from Redis
   */
  private safeParse(item: unknown): QueueItem | null {
    try {
      if (typeof item === "string") {
        return JSON.parse(item);
      }
      if (typeof item === "object" && item !== null) {
        return item as QueueItem;
      }
      return null;
    } catch (e) {
      console.warn("Failed to parse queue item:", e);
      return null;
    }
  }

  /**
   * Get items from queue respecting limits
   * Fetches in small chunks to avoid max request size errors
   */
  async getItems(
    maxItems: number = 100,
    maxBytes: number = 10 * 1024 * 1024,
  ): Promise<QueueItem[]> {
    if (!this.enabled || !redis) return [];

    // Fetch in small chunks to avoid request size limits
    const CHUNK_SIZE = 5;
    const items: QueueItem[] = [];
    let currentBytes = 0;

    // We'll peek at items chunk by chunk
    for (let i = 0; i < maxItems; i += CHUNK_SIZE) {
      // Stop if we've reached byte limit
      if (currentBytes >= maxBytes) break;

      const rangeEnd = Math.min(i + CHUNK_SIZE, maxItems) - 1;
      const chunk = await redis.lrange(QUEUE_KEY, i, rangeEnd);

      if (chunk.length === 0) break;

      for (const rawItem of chunk) {
        const item = this.safeParse(rawItem);
        if (item) {
          // Check if adding this item would exceed limits
          // Estimate size: raw JSON string length
          const itemSize =
            typeof rawItem === "string"
              ? rawItem.length
              : JSON.stringify(item).length;

          if (currentBytes + itemSize > maxBytes && items.length > 0) {
            // Stop adding, we're full
            return items;
          }

          items.push(item);
          currentBytes += itemSize;
        }
      }

      // If chunk was smaller than requested, we reached end of queue
      if (chunk.length < CHUNK_SIZE) break;
    }

    return items;
  }

  /**
   * Remove items from queue
   */
  async removeItems(count: number): Promise<void> {
    if (!this.enabled || !redis) return;
    // Remove from the right (oldest items)
    for (let i = 0; i < count; i++) {
      await redis.rpop(QUEUE_KEY);
    }
  }

  /**
   * Try to acquire lock for processing
   */
  async acquireLock(): Promise<boolean> {
    if (!this.enabled || !redis) return false;
    const lockValue = Date.now().toString();
    const result = await redis.set(LOCK_KEY, lockValue, {
      nx: true, // Only set if not exists
      px: LOCK_TIMEOUT, // Expire after 30 seconds
    });
    return result === "OK";
  }

  /**
   * Release lock
   */
  async releaseLock(): Promise<void> {
    if (!this.enabled || !redis) return;
    await redis.del(LOCK_KEY);
  }

  /**
   * Check if should process queue
   * Returns true if queue has items and no lock
   */
  async shouldProcess(): Promise<boolean> {
    if (!this.enabled || !redis) return false;
    const size = await this.size();
    if (size === 0) return false;

    // Check if lock exists
    const lockExists = await redis.exists(LOCK_KEY);
    return lockExists === 0;
  }

  /**
   * Get oldest item timestamp
   */
  async getOldestTimestamp(): Promise<number | null> {
    if (!this.enabled || !redis) return null;
    const items = await redis.lrange(QUEUE_KEY, -1, -1);
    if (items.length === 0) return null;

    const item = this.safeParse(items[0]);
    return item ? item.timestamp : null;
  }
}

export const redisQueue = new RedisUploadQueue();
