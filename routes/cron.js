import cron from "node-cron";
import axios from "axios";
import pool from "../db.js";
import { startCampaignScheduler } from "../helpers/campaign/scheduler.js";
import { AISENSY_API_KEY, AISENSY_PARTNER_ID } from "../helpers/Config.js";
import { GET_PROJECT_BILLING_STATUS } from "../helpers/function.js";
import SetWebhookSubscription from "../helpers/SetWebhookSubscription.js";

const DEFAULT_TIMEZONE = "Asia/Kolkata";

const schedule = (expression, fn, options = {}) => {
    return cron.schedule(expression, fn, { ...options, timezone: options.timezone ?? DEFAULT_TIMEZONE });
};


export function startCronJobs() {
    startCampaignScheduler();

    schedule("*/5 * * * *", async () => {
        try {
            await SetWebhookSubscription();
        } catch (error) {
            console.error("[cron] SetWebhookSubscription error:", error?.message || error);
        }
    });

    schedule("* * * * *", async () => {
        //   Cron to start or stop project billing

        const [rows] = await pool.query("SELECT * FROM aisensy_projects WHERE status = '1' ORDER BY RAND()");

        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];

            const project_id = element.project_id;

            const billing_status = await GET_PROJECT_BILLING_STATUS(project_id);


            if (billing_status == true) {
                const options = {
                    method: 'PATCH',
                    url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/project/${project_id}/billing/reactivate-project`,
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
                    },
                    data: { familyId: '63af277494189fa5bd45e1b9', defaultPlan: 'BASIC_MONTHLY' }
                };

                try {
                    const { data } = await axios.request(options);
                    console.log(data);

                } catch (error) {
                    console.log(`Error in reactivating project billing: ${project_id}`);
                }
            } else {
                const options = {
                    method: 'PATCH',
                    url: `https://apis.aisensy.com/partner-apis/v1/partner/${AISENSY_PARTNER_ID}/stop-project-billing/${project_id}`,
                    headers: {
                        'Content-Type': 'application/json',
                        Accept: 'application/json',
                        'X-AiSensy-Partner-API-Key': AISENSY_API_KEY
                    }
                };

                try {
                    await axios.request(options);
                } catch (error) {
                    console.log(`Error in stopping project billing: ${project_id}`);
                }
            }

        }



    });
}
