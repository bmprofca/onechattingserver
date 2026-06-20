import cron from "node-cron";
import pool from "../../db.js";
import { processInBackgroundExcel, processInBackgroundContacts, processInBackgroundGroups } from "./excel.js";
import { InitiateCampaignMessages } from "./sendMessage.js";
import { spawnedCampaigns, SPAWN_COOLDOWN_MS, markCampaignSpawned } from "./spawnedCampaigns.js";

/**
 * Campaign Scheduler (production-ready)
 * Uses node-cron to run every minute - more reliable than setInterval for production:
 * - Survives clock skew and system sleep
 * - Clean start/stop lifecycle
 * - No drift from long-running jobs
 *
 * Missed campaigns (run on startup + every cron tick):
 * - Immediate campaigns (schedule_date IS NULL): run instantly if they were missed (e.g. server was down)
 * - Scheduled campaigns (schedule_date in past): run instantly when schedule date-time has passed
 *
 * A campaign is ready to start when:
 * - status = '0' (pending), is_deleted = '0', params IS NOT NULL
 * - AND either: schedule_date IS NULL (immediate) OR schedule_date <= now (scheduled due / past)
 */

let cronJob = null;
let isRunning = false;

/**
 * Get current time in IST as "YYYY-MM-DD HH:mm:ss" string
 */
function getCurrentISTString() {
    const now = new Date();
    const istOffset = 5.5 * 60 * 60 * 1000;
    const istTime = new Date(now.getTime() + istOffset);
    return istTime.toISOString().slice(0, 19).replace("T", " ");
}

async function checkScheduledCampaigns(isStartup = false) {
    if (isRunning) {
        return;
    }

    isRunning = true;

    try {
        const istNowStr = getCurrentISTString();

        const [dueCampaigns] = await pool.query(
            `SELECT c.*, t.template_name, t.language_code 
             FROM campaigns c 
             LEFT JOIN templates t ON c.template_id = t.template_id AND c.project_id = t.project_id
             WHERE c.status = '0' 
               AND c.is_deleted = '0'
               AND c.params IS NOT NULL
               AND (c.schedule_date IS NULL OR c.schedule_date <= ?)`,
            [istNowStr]
        );

        if (dueCampaigns.length === 0) {
            isRunning = false;
            return;
        }

        const immediateCount = dueCampaigns.filter(c => !c.schedule_date).length;
        const pastScheduledCount = dueCampaigns.length - immediateCount;
        const reason = isStartup ? "missed" : "ready";

        const now = Date.now();
        for (const [id, ts] of spawnedCampaigns.entries()) {
            if (now - ts > SPAWN_COOLDOWN_MS) spawnedCampaigns.delete(id);
        }

        for (const campaign of dueCampaigns) {
            try {
                if (!campaign.params) {
                    continue;
                }

                const entryComplete = campaign.entry_complete === "1";
                if (!entryComplete && spawnedCampaigns.has(campaign.campaign_id)) {
                    continue; // Recently spawned processInBackground for this campaign, skip
                }

                const params = JSON.parse(campaign.params);
                const source = campaign.source;

                let template_name = campaign.template_name;
                let language_code = campaign.language_code;

                if (!template_name || !language_code) {
                    const [templateRows] = await pool.query(
                        "SELECT template_name, language_code FROM templates WHERE template_id = ? AND project_id = ?",
                        [campaign.template_id, campaign.project_id]
                    );
                    if (templateRows.length > 0) {
                        template_name = template_name || templateRows[0].template_name;
                        language_code = language_code || templateRows[0].language_code;
                    } else {
                        continue;
                    }
                }

                if (!template_name || !language_code) {
                    continue;
                }

                if (entryComplete) {
                    InitiateCampaignMessages({ campaign_id: campaign.campaign_id });
                    continue;
                }

                if (source === "excel" || source === "sheet") {
                    if (!params.phone_index || params.start_row === undefined || params.end_row === undefined || !params.component) {
                        continue;
                    }
                    if (!campaign.url) {
                        continue;
                    }
                    markCampaignSpawned(campaign.campaign_id);
                    processInBackgroundExcel({
                        url: campaign.url,
                        phone_index: params.phone_index,
                        start_row: params.start_row,
                        end_row: params.end_row,
                        component: params.component,
                        campaign_id: campaign.campaign_id,
                        username: campaign.create_by,
                        template_id: campaign.template_id,
                        template_name,
                        language_code,
                        project_id: campaign.project_id,
                        isScheduled: false,
                    });
                } else if (source === "contact") {
                    if ((!params.contact_ids || !Array.isArray(params.contact_ids) || params.contact_ids.length === 0) &&
                        (!params.numbers || !Array.isArray(params.numbers) || params.numbers.length === 0)) {
                        continue;
                    }
                    if (!params.component) {
                        continue;
                    }
                    markCampaignSpawned(campaign.campaign_id);
                    processInBackgroundContacts({
                        contact_ids: params.contact_ids || [],
                        numbers: params.numbers || [],
                        component: params.component,
                        campaign_id: campaign.campaign_id,
                        username: campaign.create_by,
                        template_id: campaign.template_id,
                        template_name,
                        language_code,
                        project_id: campaign.project_id,
                        isScheduled: false,
                    });
                } else if (source === "group") {
                    if (!params.group_ids || !Array.isArray(params.group_ids) || params.group_ids.length === 0) {
                        continue;
                    }
                    if (!params.component) {
                        continue;
                    }
                    markCampaignSpawned(campaign.campaign_id);
                    processInBackgroundGroups({
                        group_ids: params.group_ids,
                        component: params.component,
                        campaign_id: campaign.campaign_id,
                        username: campaign.create_by,
                        template_id: campaign.template_id,
                        template_name,
                        language_code,
                        project_id: campaign.project_id,
                        isScheduled: false,
                    });
                }
            } catch (err) {

            }
        }
    } catch (error) {
    } finally {
        isRunning = false;
    }
}

const STARTUP_DELAY_MS = 3000;
export function startCampaignScheduler() {
    if (cronJob) {
        return () => cronJob.stop();
    }

    cronJob = cron.schedule("* * * * *", () => {
        checkScheduledCampaigns(false);
    }, {
        scheduled: true,
        timezone: "Asia/Kolkata"
    });

    // Run missed campaigns check on startup after a short delay (server/DB ready)
    setTimeout(() => {
        checkScheduledCampaigns(true);
    }, STARTUP_DELAY_MS);

    return () => {
        if (cronJob) {
            cronJob.stop();
            cronJob = null;
        }
    };
}

/**
 * Stop the scheduler (for graceful shutdown)
 */
export function stopCampaignScheduler() {
    if (cronJob) {
        cronJob.stop();
        cronJob = null;
    }
}
