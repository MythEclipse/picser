export function getAutoSubmitThreshold(): number {
  const raw = typeof process !== 'undefined' && process.env && process.env.AUTO_SUBMIT_THRESHOLD;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 20; // default
}

export function getQueueMaxDepth(): number {
  const raw = typeof process !== 'undefined' && process.env && process.env.MAX_QUEUE_DEPTH;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 1000;
}

export function getStatusExpirySeconds(): number {
  const raw = typeof process !== 'undefined' && process.env && process.env.STATUS_EXPIRY_SECONDS;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 3600; // 1 hour
}
