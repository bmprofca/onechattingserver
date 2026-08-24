import cron from "node-cron";
import { startCampaignScheduler } from "../helpers/campaign/scheduler.js";
import { stopExpiredProjectBilling } from "../helpers/aisensyBilling.js";
import { generateAiBills } from "../cron/aiBilling.js";
import { processDailyWishes } from "../cron/birthdayAnniversaryWish.js";

const DEFAULT_TIMEZONE = "Asia/Kolkata";

// Billing activation is event-driven (purchase/create). Cron only stops expired packages.
const BILLING_EXPIRY_CRON_ENABLED = process.env.BILLING_CRON_ENABLED !== "false";
const BILLING_EXPIRY_CRON_SCHEDULE =
    process.env.BILLING_CRON_SCHEDULE || "5 0 * * *"; // 00:05 IST daily

const schedule = (expression, fn, options = {}) => {
    return cron.schedule(expression, fn, {
        ...options,
        timezone: options.timezone ?? DEFAULT_TIMEZONE,
    });
};

export function startCronJobs() {
    startCampaignScheduler();

    // Daily 12:01 AM (Asia/Kolkata): Send birthday & anniversary wishes to qr_scanned_users
    schedule("1 0 * * *", async () => {
        try {
            console.log("[cron] Running daily birthday & anniversary wish job at 12:01 AM IST");
            await processDailyWishes();
        } catch (error) {
            console.error("[cron] processDailyWishes error:", error?.message || error);
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
}
