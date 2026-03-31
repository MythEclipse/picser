import { Redis } from "ioredis";
// Using globalThis.crypto for cross-runtime (Edge/Node) compatibility

// Autodetect Redis config
let redis: Redis | null = null;
try {
  if (typeof process !== "undefined" && process.env.REDIS_URL) {
    const parsedUrl = new URL(process.env.REDIS_URL);
    const dbMatch = parsedUrl.pathname ? parsedUrl.pathname.match(/\/(\d+)/) : null;
    
    redis = new Redis({
      host: parsedUrl.hostname,
      port: parseInt(parsedUrl.port || "6379", 10),
      username: parsedUrl.username || undefined,
      password: parsedUrl.password || undefined,
      db: dbMatch ? parseInt(dbMatch[1], 10) : 0,
      tls: parsedUrl.protocol === 'rediss:' ? {} : undefined,
    });
    console.log("Redis queue enabled");
  } else {
    console.log("Redis not configured, queue disabled");
  }
} catch (error) {
  console.warn("Failed to initialize Redis, queue disabled:", error);
  redis = null;
}

const QUEUE_KEY = "upload-queue";
const LOCK_KEY = "upload-queue-lock";
import { getAutoSubmitThreshold, getQueueMaxDepth, getStatusExpirySeconds } from "@/lib/config";
const AUTO_SUBMIT_THRESHOLD = getAutoSubmitThreshold(); // auto-submit when queue reaches this
const MAX_QUEUE_DEPTH = getQueueMaxDepth();
const LOCK_TIMEOUT = 60000; // 60 seconds
const STATUS_EXPIRY = getStatusExpirySeconds(); // dynamic from config

export interface QueueItem {
  filename: string;
  base64Content: string;
  originalName: string;
  size: number;
  type: string;
  timestamp: number;
  origin?: string;
  id?: string; // Optional unique ID for tracking
  attempts?: number; // Retry attempts for resilient processing
}

export interface ItemStatus {
  status: "pending" | "success" | "failed";
  filename: string;
  url?: string;
  urls?: {
    github: string;
    raw: string;
    jsdelivr: string;
    github_commit: string;
    raw_commit: string;
    jsdelivr_commit: string;
  };
  commit_sha?: string;
  error?: string;
  timestamp: number;
}

const STATUS_PREFIX = "upload-status:";

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

    const queueSize = await redis.llen(QUEUE_KEY);
    if (queueSize >= MAX_QUEUE_DEPTH) {
      throw new Error("Upload queue is full. Please retry shortly.");
    }

    await redis.lpush(QUEUE_KEY, JSON.stringify(item));
    const updatedQueueSize = await redis.llen(QUEUE_KEY);
    console.log(`Added to queue. Queue size: ${updatedQueueSize}`);

    // Trigger processing automatically when threshold reached
    if (updatedQueueSize >= AUTO_SUBMIT_THRESHOLD) {
      console.log(`Auto-submit threshold reached (${AUTO_SUBMIT_THRESHOLD}), waiting for next instrumentation tick`);
    }
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

  async getItems(
    maxItems: number = 100,
    maxBytes: number = 10 * 1024 * 1024,
  ): Promise<QueueItem[]> {
    if (!this.enabled || !redis) return [];

    const queueSize = await redis.llen(QUEUE_KEY);
    if (queueSize === 0) return [];

    // Fetch in small chunks to avoid request size limits
    const CHUNK_SIZE = 5;
    const items: QueueItem[] = [];
    let currentBytes = 0;

    // We need to read from the RIGHT (oldest items) because add() uses lpush and remove() uses rpop.
    // Index -1 is the oldest, -2 is second oldest, etc.
    // Wait, let's read from `queueSize - 1` downwards.
    let rightIndex = queueSize - 1;

    while (items.length < maxItems && rightIndex >= 0) {
      if (currentBytes >= maxBytes) break;

      const leftIndex = Math.max(0, rightIndex - CHUNK_SIZE + 1);
      // lrange is inclusive: lrange(0, 4) gets 5 items.
      const chunk = await redis.lrange(QUEUE_KEY, leftIndex, rightIndex);

      if (chunk.length === 0) break;

      // chunk is returned from left to right (newer to older).
      // To process oldest first, we should iterate it in reverse.
      for (let i = chunk.length - 1; i >= 0; i--) {
        const rawItem = chunk[i];
        const item = this.safeParse(rawItem);
        if (item) {
          const itemSize =
            typeof rawItem === "string"
              ? rawItem.length
              : JSON.stringify(item).length;

          if (currentBytes + itemSize > maxBytes && items.length > 0) {
            return items;
          }

          items.push(item);
          currentBytes += itemSize;

          if (items.length >= maxItems) break;
        }
      }

      rightIndex = leftIndex - 1;
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
   * @returns A unique lock token if successful, null otherwise
   */
  async acquireLock(): Promise<string | null> {
    if (!this.enabled || !redis) return null;
    const lockToken = globalThis.crypto.randomUUID();
    const result = await redis.set(
      LOCK_KEY,
      lockToken,
      "PX",
      LOCK_TIMEOUT,
      "NX",
    );
    return result === "OK" ? lockToken : null;
  }

  /**
   * Release lock safely using an atomic Lua script (Redlock pattern)
   * It only deletes the lock if the actual stored token matches the provided token
   * @param token The lock token returned by acquireLock
   */
  async releaseLock(token: string | null): Promise<void> {
    if (!this.enabled || !redis || !token) return;
    
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;
    
    await redis.eval(script, 1, LOCK_KEY, token);
  }

  async getLockToken(): Promise<string | null> {
    if (!this.enabled || !redis) return null;
    return await redis.get(LOCK_KEY);
  }

  async renewLock(token: string | null): Promise<boolean> {
    if (!this.enabled || !redis || !token) return false;
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("pexpire", KEYS[1], ARGV[2])
      else
        return 0
      end
    `;

    const result = await redis.eval(script, 1, LOCK_KEY, token, LOCK_TIMEOUT);
    return result === 1;
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

  /**
   * Status helper key by either id or filename
   */
  private statusKey(identifier: string): string {
    return `${STATUS_PREFIX}${identifier}`;
  }

  /**
   * Status Tracking (accepts filename or id)
   */
  async setItemStatus(identifier: string, status: ItemStatus): Promise<void> {
    if (!this.enabled || !redis) return;
    const key = this.statusKey(identifier);
    await redis.setex(key, STATUS_EXPIRY, JSON.stringify(status));
  }

  async getItemStatus(identifier: string): Promise<ItemStatus | null> {
    if (!this.enabled || !redis) return null;
    const key = this.statusKey(identifier);
    const data = await redis.get(key);
    if (!data) return null;
    try {
      return JSON.parse(data) as ItemStatus;
    } catch {
      return null;
    }
  }

  /**
   * Helper method, prefer explicit
   */
  async getStatusById(id: string): Promise<ItemStatus | null> {
    return this.getItemStatus(id);
  }

  async getStatusByFilename(filename: string): Promise<ItemStatus | null> {
    return this.getItemStatus(filename);
  }
}

export const redisQueue = new RedisUploadQueue();
