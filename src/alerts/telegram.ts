import TelegramBot from "node-telegram-bot-api";
import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { executionAgent } from "../agents/execution";
import { riskManagerAgent } from "../agents/riskManager";
import type { TradeSignal } from "../types/signals";
import { formatPrice, formatPercent, formatUSD, formatCompact } from "../utils/formatting";

export class TelegramAlertBot {
  private bot: TelegramBot;
  private chatId: string;
  private adminChatId: string;

  constructor() {
    this.bot = new TelegramBot(config.TELEGRAM_BOT_TOKEN, { polling: false });
    this.chatId = config.TELEGRAM_CHAT_ID;
    this.adminChatId = config.TELEGRAM_ADMIN_CHAT_ID || config.TELEGRAM_CHAT_ID;
    logger.info("Telegram bot initialized");
  }

  async sendSignalAlert(signal: TradeSignal): Promise<string | null> {
    if (!this.chatId) return null;

    const directionEmoji = signal.direction === "long" ? "🟢 LONG" : "🔴 SHORT";
    const typeEmoji = signal.type === "RESEARCH" ? "🧠" :
                      signal.type === "MEME" ? "🐸" :
                      signal.type === "SMART_MONEY" ? "🐋" :
                      signal.type === "ONCHAIN" ? "⛓️" :
                      signal.type === "SOCIAL" ? "📱" : "📊";

    const confluence = signal.sources.length >= 2
      ? `\n🤝 *Multi-Agent Confluence*: ${signal.sources.join(" + ")} (${signal.sources.length} agents)`
      : "";

    const message = [
      `${typeEmoji} *${signal.type} Signal* — ${directionEmoji}`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `💎 *${signal.symbol}* ${signal.chain !== "unknown" ? `(${signal.chain})` : ""}`,
      ``,
      `📈 *Confidence*: ${signal.confidence}/100`,
      `⭐ *Score*: ${signal.score}/100`,
      `📊 *Leverage*: ${signal.leverage}x`,
      `${signal.price ? `💰 *Price*: $${formatPrice(signal.price)}` : ""}`,
      ``,
      signal.entryLow && signal.entryHigh ? `🎯 *Entry*: ${formatPrice(signal.entryLow)} — ${formatPrice(signal.entryHigh)}` : "",
      signal.tp1 ? `✅ *TP1*: ${formatPrice(signal.tp1)} (${signal.tp1Pct}%)` : "",
      signal.tp2 ? `✅ *TP2*: ${formatPrice(signal.tp2)} (${signal.tp2Pct}%)` : "",
      signal.tp3 ? `✅ *TP3*: ${formatPrice(signal.tp3)} (${signal.tp3Pct}%)` : "",
      signal.stopLoss ? `🛑 *SL*: ${formatPrice(signal.stopLoss)} (${signal.slPct}%)` : "",
      ``,
      `📝 *Catalyst*: ${signal.catalyst}`,
      confluence,
      ``,
      signal.thesis ? `🧠 *Thesis*: ${signal.thesis}` : "",
      ``,
      signal.deployerRisk ? `⚠️ *Deployer Risk*: ${signal.deployerRisk}` : "",
      signal.redFlags && signal.redFlags.length > 0 ? `🚩 *Red Flags*: ${signal.redFlags.join(", ")}` : "",
      ``,
      `━━━━━━━━━━━━━━━━━━━━`,
    ]
      .filter(line => line !== "")
      .join("\n");

    try {
      // Create inline keyboard for semi-auto execution
      const hasExchange = !!signal.exchange;
      const keyboard: TelegramBot.InlineKeyboardButton[][] = [];

      if (hasExchange && signal.confidence >= config.MIN_CONVICTION_SCORE) {
        keyboard.push([
          { text: "✅ Execute Long", callback_data: `exec_${signal.symbol}_long_${signal.score}` },
          { text: "✅ Execute Short", callback_data: `exec_${signal.symbol}_short_${signal.score}` },
        ]);
        keyboard.push([
          { text: "🔍 Deep Research", callback_data: `research_${signal.symbol}` },
          { text: "❌ Dismiss", callback_data: `dismiss_${signal.symbol}` },
        ]);
      }

      const options: TelegramBot.SendMessageOptions = {
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      };

      if (keyboard.length > 0) {
        options.reply_markup = { inline_keyboard: keyboard };
      }

      const sent = await this.bot.sendMessage(this.chatId, message.trim(), options);
      return sent.message_id.toString();
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to send Telegram alert");
      return null;
    }
  }

  async sendRiskAssessment(signal: TradeSignal, riskResult: any): Promise<void> {
    if (!this.adminChatId) return;

    const approved = riskResult.approved;
    const emoji = approved ? "✅" : "❌";

    const message = [
      `${emoji} *Risk Assessment* — ${signal.symbol} ${signal.direction.toUpperCase()}`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `*Status*: ${approved ? "APPROVED" : "REJECTED"}`,
      `*Risk Score*: ${riskResult.riskScore}/100`,
      `*Max Position*: ${formatUSD(riskResult.maxPositionSize)}`,
      `*Leverage*: ${riskResult.suggestedLeverage}x`,
      ``,
      `*Reason*: ${riskResult.reason}`,
      riskResult.warnings?.length > 0
        ? `\n*Warnings*:\n${riskResult.warnings.map((w: string) => `  • ${w}`).join("\n")}`
        : "",
    ].filter(line => line !== "").join("\n");

    try {
      await this.bot.sendMessage(this.adminChatId, message, { parse_mode: "Markdown" });
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to send risk assessment");
    }
  }

  async sendExecutionConfirmation(order: any): Promise<void> {
    if (!this.chatId) return;

    const message = [
      `⚡ *Execution Order — ${order.direction.toUpperCase()}*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `💎 *${order.symbol}* on ${order.exchange.toUpperCase()}`,
      `💰 *Size*: ${formatUSD(order.size)}`,
      `📊 *Leverage*: ${order.leverage}x`,
      `🎯 *Entry*: ${formatPrice(order.entryPrice)}`,
      `🛑 *SL*: ${formatPrice(order.stopLoss)}`,
      `📝 *Type*: ${order.type}`,
      ``,
      `⏳ *Status*: ${order.status}`,
      ``,
      `[Approve](${this.buildCallbackUrl(order.approvalKey)}) or reply /exec ${order.approvalKey}`,
    ].join("\n");

    try {
      await this.bot.sendMessage(this.chatId, message, {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [[
            { text: "✅ Approve", callback_data: `approve_${order.approvalKey}` },
            { text: "❌ Reject", callback_data: `reject_${order.approvalKey}` },
          ]],
        },
      });
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to send execution confirmation");
    }
  }

  async sendPortfolioUpdate(stats: any): Promise<void> {
    if (!this.chatId) return;

    const message = [
      `📊 *Portfolio Update*`,
      `━━━━━━━━━━━━━━━━━━━━`,
      ``,
      `💰 *P&L*: ${formatUSD(stats.totalPnl)} (${formatPercent(stats.totalPnlPct)})`,
      `🔥 *Heat*: ${(stats.heat * 100).toFixed(0)}%`,
      `📉 *Max DD*: ${(stats.maxDrawdown).toFixed(1)}%`,
      `📊 *Open Positions*: ${stats.positions.length}`,
      ``,
      ...(stats.positions || []).map((p: any) =>
        `${p.direction === "long" ? "🟢" : "🔴"} ${p.symbol} | Entry: ${formatPrice(p.entryPrice)} | PnL: ${formatUSD(p.pnl || 0)}`
      ),
    ].join("\n");

    try {
      await this.bot.sendMessage(this.chatId, message, { parse_mode: "Markdown" });
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to send portfolio update");
    }
  }

  async sendAlert(message: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.chatId || this.adminChatId, message);
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to send alert");
    }
  }

  async handleCallback(query: TelegramBot.CallbackQuery): Promise<void> {
    const data = query.data || "";
    const msg = query.message;

    try {
      if (data.startsWith("approve_")) {
        const key = data.replace("approve_", "");
        executionAgent.approveOrder(key);
        await this.bot.answerCallbackQuery(query.id, { text: "Order approved! Executing..." });
      } else if (data.startsWith("reject_")) {
        const key = data.replace("reject_", "");
        executionAgent.rejectOrder(key, "User rejected");
        await this.bot.answerCallbackQuery(query.id, { text: "Order rejected" });
      } else if (data.startsWith("dismiss_")) {
        await this.bot.answerCallbackQuery(query.id, { text: "Signal dismissed" });
        if (msg) {
          await this.bot.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: msg.chat.id, message_id: msg.message_id },
          );
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, "Callback handling failed");
    }
  }

  private buildCallbackUrl(key: string): string {
    return `https://t.me/your_bot?start=${key}`;
  }

  getBot(): TelegramBot {
    return this.bot;
  }
}

export const telegramBot = new TelegramAlertBot();
