export function getAutoSubmitThreshold(): number {
  const raw = typeof process !== 'undefined' && process.env && process.env.AUTO_SUBMIT_THRESHOLD;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }
  return 20; // default
}
