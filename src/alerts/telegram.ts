import axios from "axios";
import TelegramBot from "node-telegram-bot-api";
import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { prisma } from "../db/prisma";
import { executionAgent } from "../agents/execution";
import { technicalAlphaAgent } from "../agents/technicalAlpha";
import type { TradeSignal } from "../types/signals";
import { formatPrice, formatPercent, formatUSD, formatCompact, truncateAddress } from "../utils/formatting";

const SIGNAL_COOLDOWNS = new Map<string, number>();

const TYPE_EMOJI: Record<string, string> = {
  LISTING: "\u{1F4E1}", MEME: "\u{1F438}", TECHNICAL: "\u{1F4CA}", SMART_MONEY: "\u{1F40B}",
  ONCHAIN: "\u{26D3}", SOCIAL: "\u{1F4F1}", RESEARCH: "\u{1F9E0}",
};

export class TelegramAlertBot {
  private bot: TelegramBot;
  private chatId: string;
  private adminChatId: string;
  private scanCooldown = new Map<string, number>();

  constructor() {
    this.bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: true });
    this.chatId = config.TELEGRAM_CHAT_ID;
    this.adminChatId = config.TELEGRAM_ADMIN_CHAT_ID || config.TELEGRAM_CHAT_ID;
    this.registerCommands();
    this.registerCallbacks();
    logger.info("Telegram bot initialized with polling");
  }

  // ─────────────────── COMMAND REGISTRY ───────────────────

  private registerCommands(): void {
    this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
    this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));
    this.bot.onText(/\/signals/, (msg) => this.handleSignals(msg));
    this.bot.onText(/\/listings/, (msg) => this.handleListings(msg));
    this.bot.onText(/\/scan/, (msg) => this.handleScan(msg));
    this.bot.onText(/\/whales/, (msg) => this.handleWhales(msg));
    this.bot.onText(/\/pnl/, (msg) => this.handlePnl(msg));
    this.bot.onText(/\/status/, (msg) => this.handleStatus(msg));
    this.bot.onText(/\/positions/, (msg) => this.handlePositions(msg));
    this.bot.onText(/\/exec (.+)/, (msg, match) => this.handleExecApprove(msg, match));
    this.bot.onText(/\/reject (.+)/, (msg, match) => this.handleExecReject(msg, match));
    this.bot.onText(/\/trending/, (msg) => this.handleTrending(msg));
    this.bot.onText(/\/funding/, (msg) => this.handleFunding(msg));
  }

  private registerCallbacks(): void {
    this.bot.on("callback_query", async (query) => {
      const data = query.data || "";

      try {
        if (data === "menu") {
          await this.sendMainMenu(query.message?.chat.id?.toString() || this.chatId);
          await this.bot.answerCallbackQuery(query.id);
        } else if (data === "cmd_signals") {
          await this.handleSignals(query.message!);
          await this.bot.answerCallbackQuery(query.id);
        } else if (data === "cmd_listings") {
          await this.handleListings(query.message!);
          await this.bot.answerCallbackQuery(query.id);
        } else if (data === "cmd_scan") {
          await this.handleScan(query.message!);
          await this.bot.answerCallbackQuery(query.id);
        } else if (data === "cmd_pnl") {
          await this.handlePnl(query.message!);
          await this.bot.answerCallbackQuery(query.id);
        } else if (data === "cmd_status") {
          await this.handleStatus(query.message!);
          await this.bot.answerCallbackQuery(query.id);
        } else if (data === "cmd_help") {
          await this.handleHelp(query.message!);
          await this.bot.answerCallbackQuery(query.id);
        } else if (data.startsWith("exec_")) {
          await this.handleExecCallback(query);
        } else if (data.startsWith("approve_")) {
          const key = data.replace("approve_", "");
          executionAgent.approveOrder(key);
          await this.bot.answerCallbackQuery(query.id, { text: "Approved! Executing..." });
        } else if (data.startsWith("reject_")) {
          const key = data.replace("reject_", "");
          executionAgent.rejectOrder(key, "User rejected");
          await this.bot.answerCallbackQuery(query.id, { text: "Rejected" });
        } else if (data.startsWith("dismiss_")) {
          await this.bot.answerCallbackQuery(query.id, { text: "Dismissed" });
          if (query.message) {
            await this.bot.editMessageReplyMarkup(
              { inline_keyboard: [] },
              { chat_id: query.message.chat.id, message_id: query.message.message_id },
            );
          }
        }
      } catch (err: any) {
        logger.error({ err: err.message }, "Callback handling failed");
      }
    });
  }

  // ─────────────────── COMMAND HANDLERS ───────────────────

  private async handleStart(msg: TelegramBot.Message): Promise<void> {
    const text =
      "\u{1F680} *TradeSignal* — Multi-Agent Alpha Bot\n\n" +
      "7 AI agents scan markets 24/7:\n" +
      "\u{1F438} Meme Scout | \u{1F40B} Smart Money | \u{26D3} On-Chain Intel\n" +
      "\u{1F4CA} Technical Alpha | \u{1F4F1} Social Narrative | \u{1F9E0} Research\n" +
      "\u{1F6E1} Risk Manager | \u2699 Execution\n\n" +
      "_High-confidence signals auto-posted. Use commands below._";

    await this.bot.sendMessage(msg.chat.id, text, {
      parse_mode: "Markdown",
      reply_markup: this.mainMenuKeyboard(),
    });
  }

  private async handleHelp(msg: TelegramBot.Message): Promise<void> {
    const text =
      "\u{1F4CB} *Command List*\n\n" +
      "/start — Main menu\n" +
      "/signals — Active + recent signals\n" +
      "/listings — New exchange listings (24h)\n" +
      "/scan — Run technical breakout scan\n" +
      "/whales \\<symbol\\> — On-chain whale activity\n" +
      "/pnl — Portfolio performance\n" +
      "/positions — Open positions\n" +
      "/trending — Trending coins (CoinGecko)\n" +
      "/funding — Extreme funding rates\n" +
      "/status — System health\n" +
      "/exec \\<key\\> — Approve pending order\n" +
      "/reject \\<key\\> — Reject pending order\n";

    await this.bot.sendMessage(msg.chat.id, text, {
      parse_mode: "Markdown",
      reply_markup: this.mainMenuKeyboard(),
    });
  }

  private async handleSignals(msg: TelegramBot.Message): Promise<void> {
    try {
      const signals = await prisma.signal.findMany({
        where: { status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
        take: 15,
      });

      if (signals.length === 0) {
        await this.bot.sendMessage(msg.chat.id,
          "\u{1F4AD} No active signals. New high-confidence signals appear here automatically when detected.\n\nUse /scan to run a manual scan, or /trending to see what's hot.",
          { reply_markup: this.mainMenuKeyboard() });
        return;
      }

      const lines = signals.map((s, i) => {
        const scores = JSON.parse(s.sources as string || "[]") as string[];
        const confluence = scores.length >= 2 ? ` \u{1F91D}${scores.length} agents` : "";
        return `${i + 1}. ${TYPE_EMOJI[s.type] || "\u{1F4CC}"} *${s.symbol}* ${s.direction.toUpperCase()} ${confluence}\n   Score: ${s.score}/100 | Conf: ${s.confidence}/100 | Leverage: ${s.leverage}x\n   ${s.catalyst || ""}\n   ${s.price ? "Price: $" + formatPrice(s.price) : ""} ${s.tp1 ? "| TP1: $" + formatPrice(s.tp1) : ""} ${s.stopLoss ? "| SL: $" + formatPrice(s.stopLoss) : ""}`;
      });

      await this.bot.sendMessage(msg.chat.id,
        `\u{1F4CA} *Active Signals* (${signals.length})\n\n${lines.join("\n\n")}`,
        { parse_mode: "Markdown", reply_markup: this.mainMenuKeyboard() });
    } catch (err: any) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  }

  private async handleListings(msg: TelegramBot.Message): Promise<void> {
    try {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const listings = await prisma.signal.findMany({
        where: { type: "MEME", createdAt: { gte: oneDayAgo } },
        orderBy: { createdAt: "desc" },
        take: 10,
      });

      if (listings.length === 0) {
        await this.bot.sendMessage(msg.chat.id,
          "\u{1F4E1} No new exchange listings detected in the last 24h.\n\nNew CEX listings are the #1 edge — tokens listed on MEXC/Binance/Bybit with low float typically see immediate volatility. The listing monitor checks every minute.",
          { reply_markup: this.mainMenuKeyboard() });
        return;
      }

      const lines = listings.map(s =>
        `\u{1F4E1} *${s.symbol}* — ${s.catalyst || "New listing"}\n   Score: ${s.score}/100 | ${s.chain}`
      );

      await this.bot.sendMessage(msg.chat.id,
        `\u{1F4E1} *New Listings (24h)*\n\n${lines.join("\n\n")}`,
        { parse_mode: "Markdown", reply_markup: this.mainMenuKeyboard() });
    } catch (err: any) {
      await this.bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
  }

  private async handleScan(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id.toString();
    const lastScan = this.scanCooldown.get(chatId) || 0;
    if (Date.now() - lastScan < 60000) {
      await this.bot.sendMessage(chatId, "\u23F3 Scan cooldown — wait 1 minute between scans.");
      return;
    }

    this.scanCooldown.set(chatId, Date.now());
    await this.bot.sendMessage(chatId, "\u{1F50D} Running technical breakout scan across 6 exchanges...");

    try {
      const result = await technicalAlphaAgent.analyze();

      if (result.signals.length === 0) {
        await this.bot.sendMessage(chatId,
          "\u2705 Scan complete — no breakout candidates found right now.\n\nMarket conditions are quiet. Higher volatility periods produce more signals.",
          { reply_markup: this.mainMenuKeyboard() });
        return;
      }

      const top = result.signals.slice(0, 10);
      const lines = top.map((s, i) => {
        const sigs = (s.catalyst || "").split("|").slice(0, 3).join(" | ");
        return `${i + 1}. *${s.symbol}* ${s.direction.toUpperCase()}\n   Score: ${s.score}/100 | ${sigs}\n   Price: $${formatPrice(s.price || 0)} | TP1: $${formatPrice(s.tp1 || 0)} | SL: $${formatPrice(s.stopLoss || 0)}`;
      });

      await this.bot.sendMessage(chatId,
        `\u{1F4CA} *Breakout Scan Results* (${result.signals.length} candidates, top ${Math.min(top.length, 10)} shown)\n\n${lines.join("\n\n")}`,
        { parse_mode: "Markdown", reply_markup: this.mainMenuKeyboard() });
    } catch (err: any) {
      await this.bot.sendMessage(chatId, `Scan failed: ${err.message}`);
    }
  }

  private async handleWhales(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id.toString();
    const symbol = (msg.text || "").replace("/whales", "").trim().toUpperCase();

    if (!symbol) {
      await this.bot.sendMessage(chatId,
        "Usage: `/whales BTC`\n\nShows recent large on-chain transfers for the token.",
        { parse_mode: "Markdown" });
      return;
    }

    try {
      const events = await prisma.onchainEvent.findMany({
        where: { symbol },
        orderBy: { timestamp: "desc" },
        take: 10,
      });

      if (events.length === 0) {
        await this.bot.sendMessage(chatId,
          `\u{1F40B} No recent whale activity for *${symbol}*.\n\nConfigure Etherscan/BscScan API keys for full on-chain tracking.`,
          { parse_mode: "Markdown" });
        return;
      }

      const lines = events.map(e =>
        `\u{1F4B0} ${e.eventType.replace("_", " ").toUpperCase()} — $${formatCompact(e.valueUsd || 0)}\n   ${truncateAddress(e.fromAddress || "")} \u2192 ${truncateAddress(e.toAddress || "")}\n   [TX](${e.chain === "ethereum" ? "https://etherscan.io/tx/" + e.txHash : e.txHash})`
      );

      await this.bot.sendMessage(chatId,
        `\u{1F40B} *Whale Activity — ${symbol}*\n\n${lines.join("\n\n")}`,
        { parse_mode: "Markdown", disable_web_page_preview: true });
    } catch (err: any) {
      await this.bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  }

  private async handlePnl(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id.toString();

    try {
      const positions = await prisma.position.findMany({
        where: { status: "OPEN" },
      });

      const closedPositions = await prisma.position.findMany({
        where: { status: { in: ["CLOSED", "STOPPED_OUT"] } },
        orderBy: { closedAt: "desc" },
        take: 20,
      });

      const totalPnl = positions.reduce((s, p) => s + (p.pnl || 0), 0);
      const allocated = positions.reduce((s, p) => s + p.size, 0);
      const totalCapital = 10000;
      const pnlPct = positions.length > 0 ? (totalPnl / totalCapital) * 100 : 0;

      const line =
        `\u{1F4B0} *Portfolio P&L*\n\n` +
        `Total P&L: ${totalPnl >= 0 ? "+" : ""}${formatUSD(totalPnl)} (${formatPercent(pnlPct)})\n` +
        `Allocated: ${formatUSD(allocated)} (${((allocated / totalCapital) * 100).toFixed(0)}%)\n` +
        `Open Positions: ${positions.length}\n\n` +
        (positions.length > 0
          ? positions.map(p =>
            `${p.direction === "long" ? "\u{1F7E2}" : "\u{1F534}"} ${p.symbol} ${p.leverage}x | Entry: $${formatPrice(p.entryPrice)} | PnL: ${formatPercent(p.pnlPct || 0)}`
          ).join("\n")
          : "_No open positions_");

      await this.bot.sendMessage(chatId, line,
        { parse_mode: "Markdown", reply_markup: this.mainMenuKeyboard() });
    } catch (err: any) {
      await this.bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  }

  private async handleStatus(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id.toString();
    const uptime = process.uptime();
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const seconds = Math.floor(uptime % 60);

    try {
      const [signalCount, positionCount, walletCount] = await Promise.all([
        prisma.signal.count(),
        prisma.position.count(),
        prisma.wallet.count(),
      ]);

      const text =
        `\u{1F4CA} *System Status*\n\n` +
        `Uptime: ${hours}h ${minutes}m ${seconds}s\n` +
        `Database: Connected\n` +
        `Signals generated: ${signalCount}\n` +
        `Positions tracked: ${positionCount}\n` +
        `Wallets tracked: ${walletCount}\n` +
        `Exchanges: binance, bybit, mexc, bitget, okx, gate\n` +
        `DeepSeek: ${config.DEEPSEEK_API_KEY ? "Enabled" : "Disabled"}\n` +
        `Mode: Semi-Auto`;

      await this.bot.sendMessage(chatId, text,
        { parse_mode: "Markdown", reply_markup: this.mainMenuKeyboard() });
    } catch (err: any) {
      await this.bot.sendMessage(chatId,
        `\u{1F4CA} *System Status*\n\nUptime: ${hours}h ${minutes}m ${seconds}s\nDatabase: Connected\nDeepSeek: ${config.DEEPSEEK_API_KEY ? "Enabled" : "Disabled"}\nMode: Semi-Auto`,
        { parse_mode: "Markdown", reply_markup: this.mainMenuKeyboard() });
    }
  }

  private async handlePositions(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id.toString();

    try {
      const positions = await prisma.position.findMany({
        where: { status: "OPEN" },
        orderBy: { openedAt: "desc" },
      });

      if (positions.length === 0) {
        await this.bot.sendMessage(chatId,
          "_No open positions._\n\nSignals with execution orders will appear here when approved.",
          { parse_mode: "Markdown", reply_markup: this.mainMenuKeyboard() });
        return;
      }

      const lines = positions.map(p =>
        `${p.direction === "long" ? "\u{1F7E2}" : "\u{1F534}"} *${p.symbol}* ${p.leverage}x\n` +
        `Entry: $${formatPrice(p.entryPrice)} | Current: $${formatPrice(p.currentPrice || 0)}\n` +
        `Size: ${formatUSD(p.size)} | PnL: ${formatPercent(p.pnlPct || 0)}\n` +
        `SL: $${formatPrice(p.stopLoss)}${p.tp1 ? " | TP1: $" + formatPrice(p.tp1) : ""}`
      );

      await this.bot.sendMessage(chatId,
        `\u{1F4CA} *Open Positions* (${positions.length})\n\n${lines.join("\n\n")}`,
        { parse_mode: "Markdown", reply_markup: this.mainMenuKeyboard() });
    } catch (err: any) {
      await this.bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  }

  private async handleExecApprove(msg: TelegramBot.Message, match: RegExpMatchArray | null): Promise<void> {
    const chatId = msg.chat.id.toString();
    if (!match?.[1]) { await this.bot.sendMessage(chatId, "Usage: /exec <approval_key>"); return; }
    const key = match[1].trim();
    const ok = executionAgent.approveOrder(key);
    await this.bot.sendMessage(chatId, ok ? "Approved. Executing..." : "Order not found or already processed.");
  }

  private async handleExecReject(msg: TelegramBot.Message, match: RegExpMatchArray | null): Promise<void> {
    const chatId = msg.chat.id.toString();
    if (!match?.[1]) { await this.bot.sendMessage(chatId, "Usage: /reject <approval_key>"); return; }
    const key = match[1].trim();
    executionAgent.rejectOrder(key, "Manual reject");
    await this.bot.sendMessage(chatId, "Rejected.");
  }

  private async handleTrending(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id.toString();
    try {
      const { data } = await axios.get("https://api.coingecko.com/api/v3/search/trending", { timeout: 10000 });
      const coins = (data?.coins || []).slice(0, 10);

      if (coins.length === 0) {
        await this.bot.sendMessage(chatId, "Unable to fetch trending data.");
        return;
      }

      const lines = coins.map((c: any, i: number) => {
        const item = c.item;
        return `${i + 1}. *${item.symbol?.toUpperCase()}* — ${item.name}\n   Rank: #${item.market_cap_rank || "?"} | Score: ${item.score || 0}`;
      });

      await this.bot.sendMessage(chatId,
        `\u{1F525} *Trending on CoinGecko*\n\n${lines.join("\n\n")}`,
        { parse_mode: "Markdown", reply_markup: this.mainMenuKeyboard() });
    } catch (err: any) {
      await this.bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  }

  private async handleFunding(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id.toString();
    try {
      const result = await technicalAlphaAgent.analyze();
      const fundingSignals = result.signals.filter(s =>
        s.catalyst?.toLowerCase().includes("funding"),
      );

      if (fundingSignals.length === 0) {
        await this.bot.sendMessage(chatId,
          "No extreme funding rates detected. Current market is balanced.",
          { reply_markup: this.mainMenuKeyboard() });
        return;
      }

      const lines = fundingSignals.slice(0, 10).map(s =>
        `${s.direction === "short" ? "\u{1F534}" : "\u{1F7E2}"} *${s.symbol}*\n${s.catalyst}`
      );

      await this.bot.sendMessage(chatId,
        `\u{1F4B8} *Extreme Funding Rates*\n\n${lines.join("\n\n")}\n\n_High positive funding = crowded longs (short opportunity)\nHigh negative funding = crowded shorts (long opportunity)_`,
        { parse_mode: "Markdown", reply_markup: this.mainMenuKeyboard() });
    } catch (err: any) {
      await this.bot.sendMessage(chatId, `Error: ${err.message}`);
    }
  }

  // ─────────────────── CALLBACK HANDLERS ───────────────────

  private async handleExecCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const data = query.data || "";
    const parts = data.replace("exec_", "").split("_");
    const symbol = parts[0];
    const direction = parts[1];
    const chatId = query.message?.chat.id.toString() || this.chatId;

    try {
      const dbSignal = await prisma.signal.findFirst({
        where: { symbol, status: "ACTIVE" },
        orderBy: { createdAt: "desc" },
      });

      if (!dbSignal) {
        await this.bot.answerCallbackQuery(query.id, { text: "Signal expired" });
        return;
      }

      const signal: TradeSignal = {
        type: dbSignal.type as any,
        symbol: dbSignal.symbol,
        chain: dbSignal.chain as any,
        direction: dbSignal.direction as any,
        confidence: dbSignal.confidence,
        score: dbSignal.score,
        price: dbSignal.price || undefined,
        leverage: dbSignal.leverage,
        exchange: "binance",
        catalyst: dbSignal.catalyst || "",
        sources: JSON.parse(dbSignal.sources as string || "[]"),
        agentScores: JSON.parse(dbSignal.agentScores as string || "{}"),
        tp1: dbSignal.tp1 || undefined,
        tp2: dbSignal.tp2 || undefined,
        tp3: dbSignal.tp3 || undefined,
        stopLoss: dbSignal.stopLoss || undefined,
      };

      const positionSize = Math.min(
        dbSignal.positionSize || config.MAX_POSITION_SIZE_USD,
        config.MAX_POSITION_SIZE_USD,
      );

      const order = executionAgent.createOrder(signal, positionSize, signal.leverage);
      if (order) {
        await this.bot.sendMessage(chatId,
          `\u2699 *Execution Order Created*\n\n` +
          `${direction.toUpperCase()} ${symbol} | ${order.leverage}x\n` +
          `Size: ${formatUSD(order.size)}\n` +
          `Entry: ${formatPrice(order.entryPrice)}\n` +
          `SL: ${formatPrice(order.stopLoss)}\n\n` +
          `Click to confirm:`,
          {
            parse_mode: "Markdown",
            reply_markup: {
              inline_keyboard: [[
                { text: "✅ Approve", callback_data: `approve_${order.approvalKey}` },
                { text: "❌ Reject", callback_data: `reject_${order.approvalKey}` },
              ]],
            },
          },
        );
        await this.bot.answerCallbackQuery(query.id, { text: "Order ready — confirm above" });
      } else {
        await this.bot.answerCallbackQuery(query.id, { text: "No exchange credentials configured" });
      }
    } catch (err: any) {
      await this.bot.answerCallbackQuery(query.id, { text: `Error: ${err.message}` });
    }
  }

  // ─────────────────── SIGNAL ALERT (pipeline output) ───────────────────

  async sendSignalAlert(signal: TradeSignal): Promise<string | null> {
    if (!this.chatId) return null;

    // Cooldown: 30 min per symbol
    const lastSent = SIGNAL_COOLDOWNS.get(signal.symbol);
    if (lastSent && Date.now() - lastSent < 30 * 60 * 1000) return null;
    SIGNAL_COOLDOWNS.set(signal.symbol, Date.now());

    const directionEmoji = signal.direction === "long" ? "\u{1F7E2} LONG" : "\u{1F534} SHORT";
    const typeEmoji = TYPE_EMOJI[signal.type] || "\u{1F4CC}";
    const confluence = signal.sources.length >= 2
      ? `\n\u{1F91D} *Confluence*: ${signal.sources.join(" + ")} (${signal.sources.length} agents)`
      : "";

    const parts: string[] = [
      `${typeEmoji} *${signal.type}* — ${directionEmoji}`,
      `\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`,
      `\u{1F48E} *${signal.symbol}*${signal.chain !== "unknown" ? ` (${signal.chain})` : ""}`,
    ];

    if (signal.price) parts.push(`\u{1F4B0} *Price*: $${formatPrice(signal.price)}`);
    parts.push(`\u{1F4C8} *Confidence*: ${signal.confidence}/100 | *Score*: ${signal.score}/100`);
    parts.push(`\u{1F4CA} *Leverage*: ${signal.leverage}x`);

    if (signal.entryLow && signal.entryHigh)
      parts.push(`\u{1F3AF} *Entry*: ${formatPrice(signal.entryLow)} \u2014 ${formatPrice(signal.entryHigh)}`);
    if (signal.tp1) parts.push(`\u2705 *TP1*: ${formatPrice(signal.tp1)} (${signal.tp1Pct}%)`);
    if (signal.tp2) parts.push(`\u2705 *TP2*: ${formatPrice(signal.tp2)} (${signal.tp2Pct}%)`);
    if (signal.tp3) parts.push(`\u2705 *TP3*: ${formatPrice(signal.tp3)} (${signal.tp3Pct}%)`);
    if (signal.stopLoss) parts.push(`\u{1F6D1} *SL*: ${formatPrice(signal.stopLoss)} (${signal.slPct}%)`);

    parts.push(`\u{1F4DD} *Catalyst*: ${signal.catalyst}`);
    parts.push(confluence);
    if (signal.thesis) parts.push(`\u{1F9E0} *Thesis*: ${signal.thesis}`);
    if (signal.deployerRisk) parts.push(`\u26A0 *Deployer*: ${signal.deployerRisk}`);
    if (signal.redFlags?.length)
      parts.push(`\u{1F6A9} *Red Flags*: ${signal.redFlags.join(", ")}`);
    parts.push(`\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501`);

    const message = parts.join("\n");

    try {
      const keyboard: TelegramBot.InlineKeyboardButton[][] = [[
        { text: "\u2705 Execute Long", callback_data: `exec_${signal.symbol}_long` },
        { text: "\u274C Dismiss", callback_data: `dismiss_${signal.symbol}` },
      ]];

      if (signal.direction === "short") {
        keyboard[0][0] = { text: "\u2705 Execute Short", callback_data: `exec_${signal.symbol}_short` };
      }

      const sent = await this.bot.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: { inline_keyboard: keyboard },
      });

      return sent.message_id.toString();
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to send signal alert");
      return null;
    }
  }

  async sendExecutionConfirmation(order: any): Promise<void> {
    await this.bot.sendMessage(this.chatId,
      `\u26A1 *Order Pending — ${order.direction.toUpperCase()}*\n\n` +
      `${order.symbol} on ${order.exchange.toUpperCase()}\n` +
      `Size: ${formatUSD(order.size)} | ${order.leverage}x\n` +
      `Entry: ${formatPrice(order.entryPrice)}\n` +
      `SL: ${formatPrice(order.stopLoss)}\n` +
      `Key: \`${order.approvalKey}\`\n\n` +
      `Approve with /exec ${order.approvalKey}`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "\u2705 Approve", callback_data: `approve_${order.approvalKey}` },
            { text: "\u274C Reject", callback_data: `reject_${order.approvalKey}` },
          ]],
        },
      },
    );
  }

  async sendAlert(text: string): Promise<void> {
    await this.bot.sendMessage(this.chatId || this.adminChatId, text);
  }

  async sendRiskAssessment(signal: TradeSignal, risk: any): Promise<void> {
    // Silently log, only alert on rejects for administrative channel
    if (!risk.approved && this.adminChatId) {
      await this.bot.sendMessage(this.adminChatId,
        `\u274C *Rejected* — ${signal.symbol}\n${risk.reason}`,
        { parse_mode: "Markdown" },
      );
    }
  }

  async sendPortfolioUpdate(stats: any): Promise<void> {
    // Only send if there are positions
    if (!stats.positions?.length) return;

    const lines = stats.positions.map((p: any) =>
      `${p.direction === "long" ? "\u{1F7E2}" : "\u{1F534}"} ${p.symbol} | Entry: ${formatPrice(p.entryPrice)} | PnL: ${formatUSD(p.pnl || 0)}`
    );

    await this.bot.sendMessage(this.chatId,
      `\u{1F4CA} *Portfolio*\n\n` +
      `P&L: ${formatUSD(stats.totalPnl)} | Heat: ${((stats.heat || 0) * 100).toFixed(0)}%\n\n` +
      lines.join("\n"),
      { parse_mode: "Markdown" },
    );
  }

  // ─────────────────── KEYBOARD ───────────────────

  private mainMenuKeyboard(): TelegramBot.InlineKeyboardMarkup {
    return {
      inline_keyboard: [
        [
          { text: "\u{1F4CA} Signals", callback_data: "cmd_signals" },
          { text: "\u{1F4E1} Listings", callback_data: "cmd_listings" },
        ],
        [
          { text: "\u{1F50D} Scan", callback_data: "cmd_scan" },
          { text: "\u{1F525} Trending", callback_data: "cmd_trending" },
        ],
        [
          { text: "\u{1F4B0} P&L", callback_data: "cmd_pnl" },
          { text: "\u{1F4CA} Status", callback_data: "cmd_status" },
        ],
        [
          { text: "\u{1F4CB} Help", callback_data: "cmd_help" },
        ],
      ],
    };
  }

  async sendMainMenu(chatId: string): Promise<void> {
    await this.bot.sendMessage(chatId, "\u{1F4CB} *Menu*\n\nSelect an option:", {
      parse_mode: "Markdown",
      reply_markup: this.mainMenuKeyboard(),
    });
  }

  getBot(): TelegramBot {
    return this.bot;
  }
}

export const telegramBot = new TelegramAlertBot();
