import axios from "axios";
import pool from "../db.js";
import { GetAiSensyProjectToken } from "./function.js";
import { BASE_DOMAIN } from "./Config.js";

function webhookUrlFor(project_id) {
    return `${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}`;
}

/**
 * Always PATCH AiSensy webhook for a project and persist URL in DB.
 * @param {string} project_id
 * @param {{ retries?: number, projectToken?: string }} [options]
 * @returns {{ ok: boolean, webhookUrl?: string, error?: string }}
 */
export async function ensureProjectWebhook(project_id, options = {}) {
    const retries = Math.max(1, Number(options.retries) || 1);
    if (!project_id) {
        return { ok: false, error: "Missing project_id" };
    }

    const project_token =
        options.projectToken || (await GetAiSensyProjectToken(project_id));

    if (!project_token) {
        return { ok: false, error: "Failed to get project token" };
    }

    const webhookUrl = webhookUrlFor(project_id);
    let lastError = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            await axios.request({
                method: "PATCH",
                url: "https://backend.aisensy.com/direct-apis/t1/settings/update-webhook",
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    Authorization: `Bearer ${project_token}`,
                },
                data: { webhooks: { url: webhookUrl } },
            });

            await pool.query(
                "UPDATE `aisensy_projects` SET `webhook_url`=? WHERE project_id = ?",
                [webhookUrl, project_id]
            );

            return { ok: true, webhookUrl };
        } catch (error) {
            lastError = error;
            console.error("[webhook] ensureProjectWebhook failed", {
                project_id,
                attempt,
                message: error?.message,
                response: error?.response?.data,
            });
            if (attempt < retries) {
                await new Promise((r) => setTimeout(r, 500 * attempt));
            }
        }
    }

    // Leave empty so backfill cron can retry later
    try {
        await pool.query(
            "UPDATE `aisensy_projects` SET `webhook_url`=? WHERE project_id = ?",
            ["", project_id]
        );
    } catch {
        // ignore
    }

    return {
        ok: false,
        error:
            lastError?.response?.data?.message ||
            lastError?.message ||
            "webhook update failed",
    };
}

/**
 * Backfill projects with missing webhook_url (and WABA connected when possible).
 */
export async function ensureMissingWebhooks() {
    const [rows] = await pool.query(
        `SELECT project_id FROM aisensy_projects
         WHERE (webhook_url = '' OR webhook_url IS NULL)
           AND (is_waba_connected = '1' OR is_waba_connected = 1 OR is_waba_connected IS NULL)`
    );

    let ok = 0;
    let failed = 0;

    for (const row of rows) {
        const result = await ensureProjectWebhook(row.project_id, { retries: 2 });
        if (result.ok) ok += 1;
        else failed += 1;
    }

    return { ok, failed, checked: rows.length };
}

/**
 * Re-subscribe webhook for all WABA-connected projects.
 * Fixes cases where DB has webhook_url but AiSensy lost the subscription.
 */
export async function ensureAllWabaWebhooks() {
    const [rows] = await pool.query(
        `SELECT project_id FROM aisensy_projects
         WHERE is_waba_connected = '1' OR is_waba_connected = 1`
    );

    let ok = 0;
    let failed = 0;

    for (const row of rows) {
        const result = await ensureProjectWebhook(row.project_id, { retries: 2 });
        if (result.ok) ok += 1;
        else failed += 1;
    }

    return { ok, failed, checked: rows.length };
}

/** @deprecated Prefer ensureMissingWebhooks / ensureProjectWebhook */
async function SetWebhookSubscription() {
    return ensureMissingWebhooks();
}

export default SetWebhookSubscription;
