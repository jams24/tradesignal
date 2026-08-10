import { logger } from "../utils/logger";
import { config } from "../utils/config";
import { connectDB } from "../db/prisma";
import { cexProvider } from "../data/providers/cex";
import { onchainProvider } from "../data/providers/onchain";

import { memeScoutAgent } from "../agents/memeScout";
import { smartMoneyAgent } from "../agents/smartMoney";
import { onchainIntelAgent } from "../agents/onchainIntel";
import { technicalAlphaAgent } from "../agents/technicalAlpha";
import { socialNarrativeAgent } from "../agents/socialNarrative";
import { listingMonitorAgent } from "../agents/listingMonitor";
import { riskManagerAgent } from "../agents/riskManager";
import { executionAgent } from "../agents/execution";

import { researchAgent } from "../core/researchAgent";
import { signalEngine } from "../core/signalEngine";
import { telegramBot } from "../alerts/telegram";

import type { AgentResult } from "../types/signals";

class Orchestrator {
  private intervals: NodeJS.Timeout[] = [];
  private running = false;

  async start(): Promise<void> {
    logger.info("═══════════════════════════════════════");
    logger.info("  CryptoSignalDeep — Multi-Agent Alpha");
    logger.info("═══════════════════════════════════════");
    logger.info("Agents: ListingMonitor | MemeScout | SmartMoney | OnchainIntel | TechnicalAlpha | SocialNarrative | Research | Risk | Execution");
    logger.info("Mode: Semi-Auto with one-click execution");
    logger.info("═══════════════════════════════════════");

    this.running = true;

    // 1. Connect to database
    await connectDB();

    // 2. Initialize data providers
    await cexProvider.init();

    // 3. Start all agent loops
    this.scheduleAgentRuns();

    // 4. Start stop-loss monitor
    this.scheduleStopLossCheck();

    // 5. Start portfolio reporting
    this.schedulePortfolioReport();

    // 6. Register graceful shutdown
    this.registerShutdown();

    logger.info("Orchestrator started — all agents running");

    await telegramBot.sendAlert(
      "CryptoSignalDeep is online.\n\n" +
      "Agents: ListingMonitor | MemeScout | SmartMoney | OnchainIntel | TechnicalAlpha | SocialNarrative\n" +
      "Pipeline runs every 10 min. First scan starting in 5s..."
    );
  }

  private scheduleAgentRuns(): void {
    // Listing Monitor — every 1 minute (new listings are time-critical)
    this.intervals.push(setInterval(async () => {
      await this.runAgent("LISTING_MONITOR", listingMonitorAgent);
    }, 60 * 1000));

    // Meme Scout — every MEME_SCOUT_INTERVAL minutes
    this.intervals.push(setInterval(async () => {
      await this.runAgent("MEME_SCOUT", memeScoutAgent);
    }, config.MEME_SCOUT_INTERVAL * 60 * 1000));

    // Smart Money — every SMART_MONEY_INTERVAL minutes
    this.intervals.push(setInterval(async () => {
      await this.runAgent("SMART_MONEY", smartMoneyAgent);
    }, config.SMART_MONEY_INTERVAL * 60 * 1000));

    // On-chain Intel — every ONCHAIN_INTEL_INTERVAL minutes
    this.intervals.push(setInterval(async () => {
      await this.runAgent("ONCHAIN_INTEL", onchainIntelAgent);
    }, config.ONCHAIN_INTEL_INTERVAL * 60 * 1000));

    // Technical Alpha — every TECHNICAL_ALPHA_INTERVAL minutes
    this.intervals.push(setInterval(async () => {
      await this.runAgent("TECHNICAL_ALPHA", technicalAlphaAgent);
    }, config.TECHNICAL_ALPHA_INTERVAL * 60 * 1000));

    // Social Narrative — every SOCIAL_NARRATIVE_INTERVAL minutes
    this.intervals.push(setInterval(async () => {
      await this.runAgent("SOCIAL_NARRATIVE", socialNarrativeAgent);
    }, config.SOCIAL_NARRATIVE_INTERVAL * 60 * 1000));

    // Full pipeline: run all agents, process through engine, research, risk, alert
    // Runs every 10 minutes (balanced between frequency and cost)
    this.intervals.push(setInterval(async () => {
      await this.runFullPipeline();
    }, 10 * 60 * 1000));

    // Initial runs
    setTimeout(() => this.runFullPipeline(), 5000);
  }

  private async runAgent(name: string, agent: { analyze: () => Promise<AgentResult> }): Promise<void> {
    try {
      const result = await agent.analyze();
      if (result.signals.length > 0) {
        logger.info({ agent: name, signals: result.signals.length }, "Agent found signals");
      }
    } catch (err: any) {
      logger.error({ agent: name, err: err.message }, "Agent run failed");
    }
  }

  private async runFullPipeline(): Promise<void> {
    logger.info("Starting full pipeline run...");
    const pipelineStart = Date.now();

    try {
      // Step 1: Run all agents in parallel
      const agentResults = await Promise.all([
        listingMonitorAgent.analyze(),
        memeScoutAgent.analyze(),
        smartMoneyAgent.analyze(),
        onchainIntelAgent.analyze(),
        technicalAlphaAgent.analyze(),
        socialNarrativeAgent.analyze(),
      ]);

      const totalSignals = agentResults.reduce((s, r) => s + r.signals.length, 0);
      logger.info(`Agents generated ${totalSignals} raw signals`);

      if (totalSignals === 0) {
        logger.info("No signals generated in this cycle");
        return;
      }

      // Step 2: Process through signal engine (confluence + scoring)
      const processedSignals = await signalEngine.processAgentResults(agentResults);
      logger.info(`Signal engine produced ${processedSignals.length} processed signals`);

      if (processedSignals.length === 0) return;

      // Step 3: DeepSeek research for top signals
      const researchedSignals = await researchAgent.deepResearch(processedSignals);
      logger.info(`Research agent enriched ${researchedSignals.signals.length} signals`);

      // Step 4: Risk assessment
      const riskResult = await riskManagerAgent.assessSignals(researchedSignals.signals);
      const riskAssessments = riskResult.signals as any[];

      // Step 5: Send alerts for high-confidence signals
      let alertsSent = 0;
      let ordersCreated = 0;

      for (let i = 0; i < researchedSignals.signals.length; i++) {
        const signal = researchedSignals.signals[i];
        const risk = riskAssessments[i];

        if (!risk) continue;

        // Skip signals below minimum confidence
        if (signal.confidence < config.MIN_CONVICTION_SCORE) continue;

        // Send to Telegram
        await telegramBot.sendSignalAlert(signal);
        alertsSent++;

        // Send risk assessment
        await telegramBot.sendRiskAssessment(signal, risk);

        // Create execution order if approved
        if (risk.approved && signal.exchange) {
          const order = executionAgent.createOrder(
            signal,
            risk.maxPositionSize,
            risk.suggestedLeverage,
          );

          if (order) {
            await telegramBot.sendExecutionConfirmation(order);
            ordersCreated++;
          }
        }
      }

      const pipelineDuration = Date.now() - pipelineStart;
      logger.info({
        pipelineDurationMs: pipelineDuration,
        rawSignals: totalSignals,
        processedSignals: processedSignals.length,
        alertsSent,
        ordersCreated,
      }, `Pipeline complete in ${pipelineDuration}ms`);

    } catch (err: any) {
      logger.error({ err: err.message }, "Pipeline run failed");
    }
  }

  private scheduleStopLossCheck(): void {
    this.intervals.push(setInterval(async () => {
      try {
        await executionAgent.checkStopLosses();
      } catch (err: any) {
        logger.error({ err: err.message }, "Stop loss check failed");
      }
    }, 30 * 1000)); // every 30 seconds
  }

  private schedulePortfolioReport(): void {
    this.intervals.push(setInterval(async () => {
      try {
        // In production, compute from DB + exchange balances
        await telegramBot.sendPortfolioUpdate({
          totalPnl: 0,
          totalPnlPct: 0,
          heat: 0,
          maxDrawdown: 0,
          positions: [],
        });
      } catch (err: any) {
        logger.error({ err: err.message }, "Portfolio report failed");
      }
    }, 60 * 60 * 1000)); // every hour
  }

  private registerShutdown(): void {
    const shutdown = async () => {
      logger.info("Shutting down...");
      this.running = false;
      this.intervals.forEach(clearInterval);
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  }

  stop(): void {
    this.running = false;
    this.intervals.forEach(clearInterval);
    this.intervals = [];
  }
}

export const orchestrator = new Orchestrator();
