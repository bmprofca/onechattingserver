import axios from "axios";
import pool from "../db.js";
import { GetAiSensyProjectToken } from "./function.js";
import { BASE_DOMAIN } from "./Config.js";

function webhookUrlFor(project_id) {
    return `${BASE_DOMAIN}/webhook/aisensy-webhook/${project_id}`;
}

let webhookColumnReady = false;

/**
 * Ensure aisensy_projects.webhook_subscribed exists (0/1 flag).
 */
async function ensureWebhookSubscribedColumn() {
    if (webhookColumnReady) return;

    try {
        await pool.query(
            `ALTER TABLE aisensy_projects
             ADD COLUMN webhook_subscribed ENUM('0','1') NOT NULL DEFAULT '0'
             COMMENT '1 = AiSensy webhook subscription succeeded'`
        );
        console.log("[webhook] Added column aisensy_projects.webhook_subscribed");
    } catch (error) {
        // ER_DUP_FIELDNAME = 1060 — column already exists
        if (error?.errno !== 1060 && error?.code !== "ER_DUP_FIELDNAME") {
            console.error("[webhook] Failed to ensure webhook_subscribed column:", error?.message || error);
            throw error;
        }
    }

    webhookColumnReady = true;
}

/**
 * Always PATCH AiSensy webhook for a project (even if DB already has a URL).
 * On success: save webhook_url + webhook_subscribed='1'
 * On failure: webhook_subscribed='0'
 *
 * @param {string} project_id
 * @param {{ retries?: number, projectToken?: string }} [options]
 * @returns {{ ok: boolean, webhookUrl?: string, error?: string }}
 */
export async function ensureProjectWebhook(project_id, options = {}) {
    const retries = Math.max(1, Number(options.retries) || 1);
    if (!project_id) {
        return { ok: false, error: "Missing project_id" };
    }

    await ensureWebhookSubscribedColumn();

    const project_token =
        options.projectToken || (await GetAiSensyProjectToken(project_id));

    if (!project_token) {
        try {
            await pool.query(
                "UPDATE `aisensy_projects` SET `webhook_subscribed`='0' WHERE project_id = ?",
                [project_id]
            );
        } catch {
            // ignore
        }
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
                "UPDATE `aisensy_projects` SET `webhook_url`=?, `webhook_subscribed`='1' WHERE project_id = ?",
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

    try {
        await pool.query(
            "UPDATE `aisensy_projects` SET `webhook_subscribed`='0' WHERE project_id = ?",
            [project_id]
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
 * Subscribe AiSensy webhook for every active project
 * (even if webhook_url / webhook_subscribed is already set).
 */
export async function ensureAllProjectWebhooks() {
    await ensureWebhookSubscribedColumn();

    const [rows] = await pool.query(
        "SELECT project_id FROM aisensy_projects WHERE status = '1'"
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

/** @deprecated Use ensureAllProjectWebhooks — still re-subscribes all active projects */
export async function ensureMissingWebhooks() {
    return ensureAllProjectWebhooks();
}

/** @deprecated Use ensureAllProjectWebhooks */
export async function ensureAllWabaWebhooks() {
    return ensureAllProjectWebhooks();
}

/** @deprecated Prefer ensureAllProjectWebhooks / ensureProjectWebhook */
async function SetWebhookSubscription() {
    return ensureAllProjectWebhooks();
}

export default SetWebhookSubscription;
