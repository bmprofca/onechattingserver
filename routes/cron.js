import cron from "node-cron";
import { startCampaignScheduler } from "../helpers/campaign/scheduler.js";
import { ensureAllProjectWebhooks } from "../helpers/SetWebhookSubscription.js";
import { stopExpiredProjectBilling } from "../helpers/aisensyBilling.js";
import { generateAiBills } from "../cron/aiBilling.js";

const DEFAULT_TIMEZONE = "Asia/Kolkata";

// Billing activation is event-driven (purchase/create). Cron only stops expired packages.
const BILLING_EXPIRY_CRON_ENABLED = process.env.BILLING_CRON_ENABLED !== "false";
const BILLING_EXPIRY_CRON_SCHEDULE =
    process.env.BILLING_CRON_SCHEDULE || "5 0 * * *"; // 00:05 IST daily

const WEBHOOK_SUBSCRIPTION_CRON =
    process.env.WEBHOOK_SUBSCRIPTION_CRON || "*/30 * * * *";

const schedule = (expression, fn, options = {}) => {
    return cron.schedule(expression, fn, {
        ...options,
        timezone: options.timezone ?? DEFAULT_TIMEZONE,
    });
};

export function startCronJobs() {
    startCampaignScheduler();

    // Re-subscribe AiSensy webhook for EVERY active project (even if DB already has URL)
    schedule(WEBHOOK_SUBSCRIPTION_CRON, async () => {
        try {
            const result = await ensureAllProjectWebhooks();
            console.log(
                `[cron] webhook subscribe checked=${result.checked} ok=${result.ok} failed=${result.failed}`
            );
        } catch (error) {
            console.error(
                "[cron] ensureAllProjectWebhooks error:",
                error?.message || error
            );
        }
    });

    // Daily: stop AiSensy billing for expired packages only
    if (BILLING_EXPIRY_CRON_ENABLED) {
        schedule(BILLING_EXPIRY_CRON_SCHEDULE, async () => {
            try {
                const result = await stopExpiredProjectBilling();
                console.log(
                    `[cron] billing expiry stopped=${result.stopped} failed=${result.failed} checked=${result.checked}`
                );
            } catch (error) {
                console.error(
                    "[cron] stopExpiredProjectBilling error:",
                    error?.message || error
                );
            }
        });
    }

    // Run AI billing every day at 12:00 PM (Asia/Kolkata)
    schedule("0 12 * * *", async () => {
        try {
            await generateAiBills();
        } catch (error) {
            console.error("[cron] generateAiBills error:", error?.message || error);
        }
    });

    // On boot: subscribe webhooks for all active projects
    setTimeout(() => {
        ensureAllProjectWebhooks()
            .then((result) => {
                console.log(
                    `[startup] webhook subscribe checked=${result.checked} ok=${result.ok} failed=${result.failed}`
                );
            })
            .catch((error) => {
                console.error(
                    "[startup] ensureAllProjectWebhooks error:",
                    error?.message || error
                );
            });
    }, 5000);
}
