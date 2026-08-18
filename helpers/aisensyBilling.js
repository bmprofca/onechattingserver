import axios from "axios";
import pool from "../db.js";
import { getActiveTechProvider } from "./techProvider.js";
import { GET_ACTIVE_BILLING_PROJECT_IDS, TODAY_DATE } from "./function.js";
import { ensureProjectWebhook } from "./SetWebhookSubscription.js";

const AISENSY_BILLING_FAMILY_ID = "63af277494189fa5bd45e1b9";
const AISENSY_DEFAULT_PLAN = "BASIC_MONTHLY";

const recentlyStopped = new Map(); // project_id -> timestamp
const STOP_DEDUP_MS = 60 * 60 * 1000; // 1 hour

function partnerHeaders(apiKey) {
    return {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-AiSensy-Partner-API-Key": apiKey,
    };
}

/**
 * Reactivate AiSensy project billing (realtime).
 * @returns {{ ok: boolean, error?: string, skipped?: boolean }}
 */
export async function reactivateProjectBilling(project_id) {
    if (!project_id) {
        return { ok: false, error: "Missing project_id" };
    }

    const provider = await getActiveTechProvider();
    if (provider.provider_type !== "aisensy" || !provider.aisensy_partner_id || !provider.aisensy_api_key) {
        return { ok: true, skipped: true };
    }

    try {
        await axios.request({
            method: "PATCH",
            url: `https://apis.aisensy.com/partner-apis/v1/partner/${provider.aisensy_partner_id}/project/${project_id}/billing/reactivate-project`,
            headers: partnerHeaders(provider.aisensy_api_key),
            data: {
                familyId: AISENSY_BILLING_FAMILY_ID,
                defaultPlan: AISENSY_DEFAULT_PLAN,
            },
        });
        recentlyStopped.delete(project_id);
        return { ok: true };
    } catch (error) {
        console.error("[aisensy-billing] reactivate failed", {
            project_id,
            message: error?.message,
            response: error?.response?.data,
        });
        return {
            ok: false,
            error: error?.response?.data?.message || error?.message || "reactivate failed",
        };
    }
}

/**
 * Stop AiSensy project billing.
 * @returns {{ ok: boolean, error?: string, skipped?: boolean }}
 */
export async function stopProjectBilling(project_id, { force = false } = {}) {
    if (!project_id) {
        return { ok: false, error: "Missing project_id" };
    }

    const provider = await getActiveTechProvider();
    if (provider.provider_type !== "aisensy" || !provider.aisensy_partner_id || !provider.aisensy_api_key) {
        return { ok: true, skipped: true };
    }

    if (!force) {
        const last = recentlyStopped.get(project_id);
        if (last && Date.now() - last < STOP_DEDUP_MS) {
            return { ok: true, skipped: true };
        }
    }

    try {
        await axios.request({
            method: "PATCH",
            url: `https://apis.aisensy.com/partner-apis/v1/partner/${provider.aisensy_partner_id}/stop-project-billing/${project_id}`,
            headers: partnerHeaders(provider.aisensy_api_key),
        });
        recentlyStopped.set(project_id, Date.now());
        return { ok: true };
    } catch (error) {
        console.error("[aisensy-billing] stop failed", {
            project_id,
            message: error?.message,
            response: error?.response?.data,
        });
        return {
            ok: false,
            error: error?.response?.data?.message || error?.message || "stop failed",
        };
    }
}

/**
 * After package purchase / project create: activate billing then ensure webhook.
 */
export async function activateProjectServices(project_id) {
    const billing = await reactivateProjectBilling(project_id);
    // Webhook after billing — AiSensy often needs this again after stop/reactivate
    const webhook = await ensureProjectWebhook(project_id, { retries: 2 });
    return { billing, webhook };
}

/**
 * Daily safety: stop billing for projects without a valid package today.
 * Does not reactivate (activation is event-driven).
 */
export async function stopExpiredProjectBilling() {
    const today = TODAY_DATE();
    const active = await GET_ACTIVE_BILLING_PROJECT_IDS(today);

    const [rows] = await pool.query(
        "SELECT project_id FROM aisensy_projects WHERE status = '1'"
    );

    let stopped = 0;
    let failed = 0;

    for (const row of rows) {
        const project_id = row.project_id;
        if (active.has(project_id)) continue;

        const result = await stopProjectBilling(project_id, { force: true });
        if (result.ok) stopped += 1;
        else failed += 1;
    }

    return { stopped, failed, checked: rows.length };
}
