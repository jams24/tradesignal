import { prisma } from "../db/prisma";
import { logger } from "../utils/logger";

export class SignalCache {
  private static COOLDOWN_HOURS = 4;
  private static RESEARCH_CACHE_HOURS = 24;
  private static MAX_DAILY_PER_SYMBOL = 3;

  // ─── Telegram alert cooldown ───────────────────────────

  static async shouldSendAlert(symbol: string): Promise<boolean> {
    const key = `alert_cooldown:${symbol}`;
    try {
      const existing = await prisma.setting.findUnique({ where: { key } });
      if (existing) {
        const lastSent = parseInt(existing.value);
        const hoursAgo = (Date.now() - lastSent) / 3600000;
        if (hoursAgo < this.COOLDOWN_HOURS) {
          logger.info({ symbol, hoursAgo: hoursAgo.toFixed(1) }, `Alert cooldown: skipping ${symbol}`);
          return false;
        }
      }
      // Mark as sent
      await prisma.setting.upsert({
        where: { key },
        update: { value: Date.now().toString() },
        create: { key, value: Date.now().toString() },
      });
      return true;
    } catch { return true; } // allow on DB error
  }

  // ─── DeepSeek research cache ───────────────────────────

  static async getCachedResearch(symbol: string): Promise<{ thesis: string; conviction: number } | null> {
    const key = `research:${symbol}`;
    try {
      const existing = await prisma.setting.findUnique({ where: { key } });
      if (existing) {
        const parts = existing.value.split("|");
        const timestamp = parseInt(parts[0]);
        const hoursAgo = (Date.now() - timestamp) / 3600000;
        if (hoursAgo < this.RESEARCH_CACHE_HOURS && parts.length >= 3) {
          return { thesis: parts[1], conviction: parseInt(parts[2]) };
        }
      }
    } catch { /* ignore */ }
    return null;
  }

  static async cacheResearch(symbol: string, thesis: string, conviction: number): Promise<void> {
    const key = `research:${symbol}`;
    try {
      const value = `${Date.now()}|${thesis}|${conviction}`;
      await prisma.setting.upsert({
        where: { key },
        update: { value },
        create: { key, value },
      });
    } catch { /* ignore */ }
  }

  // ─── Daily limit per symbol ────────────────────────────

  static async canAlertToday(symbol: string): Promise<boolean> {
    const today = new Date().toISOString().slice(0, 10);
    const key = `daily_count:${symbol}:${today}`;
    try {
      const existing = await prisma.setting.findUnique({ where: { key } });
      const count = existing ? parseInt(existing.value) : 0;
      if (count >= this.MAX_DAILY_PER_SYMBOL) {
        logger.info({ symbol, count }, `Daily limit reached for ${symbol}`);
        return false;
      }
      await prisma.setting.upsert({
        where: { key },
        update: { value: (count + 1).toString() },
        create: { key, value: "1" },
      });
      return true;
    } catch { return true; }
  }

  // ─── Signal dedup check ────────────────────────────────

  static async isDuplicateSignal(symbol: string): Promise<boolean> {
    const hoursAgo = new Date(Date.now() - this.COOLDOWN_HOURS * 3600000);
    try {
      const existing = await prisma.signal.findFirst({
        where: {
          symbol,
          status: "ACTIVE",
          createdAt: { gte: hoursAgo },
        },
      });
      return !!existing;
    } catch { return false; }
  }
}
