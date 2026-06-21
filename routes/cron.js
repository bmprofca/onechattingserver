import cron from "node-cron";
import axios from "axios";
import pool from "../db.js";
import { startCampaignScheduler } from "../helpers/campaign/scheduler.js";
import { AISENSY_API_KEY, AISENSY_PARTNER_ID } from "../helpers/Config.js";
import { GET_ACTIVE_BILLING_PROJECT_IDS, TODAY_DATE } from "../helpers/function.js";
import SetWebhookSubscription from "../helpers/SetWebhookSubscription.js";

const DEFAULT_TIMEZONE = "Asia/Kolkata";
const BILLING_CRON_ENABLED = process.env.BILLING_CRON_ENABLED !== "false";
const BILLING_CRON_SCHEDULE = process.env.BILLING_CRON_SCHEDULE || "*/15 * * * *";
const WEBHOOK_SUBSCRIPTION_CRON = process.env.WEBHOOK_SUBSCRIPTION_CRON || "*/30 * * * *";

const schedule = (expression, fn, options = {}) => {
    return cron.schedule(expression, fn, { ...options, timezone: options.timezone ?? DEFAULT_TIMEZONE });
};

async function syncProjectBilling() {
    const today = TODAY_DATE();
    const activeBillingProjects = await GET_ACTIVE_BILLING_PROJECT_IDS(today);

    const [rows] = await pool.query(
        "SELECT project_id FROM aisensy_projects WHERE status = '1'"
    );

    for (const element of rows) {
        const project_id = element.project_id;
        const billing_status = activeBillingProjects.has(project_id);

        if (billing_status) {
            const options = {
                method: "PATCH",
                url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/project/${project_id}/billing/reactivate-project`,
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "X-AiSensy-Partner-API-Key": AISENSY_API_KEY,
                },
                data: { familyId: "63af277494189fa5bd45e1b9", defaultPlan: "BASIC_MONTHLY" },
            };

            try {
                await axios.request(options);
            } catch (error) {
                console.log(`Error in reactivating project billing: ${project_id}`);
            }
        } else {
            const options = {
                method: "PATCH",
                url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/stop-project-billing/${project_id}`,
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "X-AiSensy-Partner-API-Key": AISENSY_API_KEY,
                },
            };

            try {
                await axios.request(options);
            } catch (error) {
                console.log(`Error in stopping project billing: ${project_id}`);
            }
        }
    }
}

export function startCronJobs() {
    startCampaignScheduler();

    schedule(WEBHOOK_SUBSCRIPTION_CRON, async () => {
        try {
            await SetWebhookSubscription();
        } catch (error) {
            console.error("[cron] SetWebhookSubscription error:", error?.message || error);
        }
    });

    if (BILLING_CRON_ENABLED) {
        schedule(BILLING_CRON_SCHEDULE, async () => {
            try {
                await syncProjectBilling();
            } catch (error) {
                console.error("[cron] syncProjectBilling error:", error?.message || error);
            }
        });
    }
}
