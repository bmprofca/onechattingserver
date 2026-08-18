import pool from "../db.js";
import axios from "axios";
import { BASE_DOMAIN } from "./Config.js";

let cachedProvider = null;
let cacheExpiry = 0;

/**
 * Get current active tech provider settings from database.
 * Caches in memory for 30s to avoid repeated DB hits.
 */
export async function getActiveTechProvider(forceFresh = false) {
    const now = Date.now();
    if (!forceFresh && cachedProvider && now < cacheExpiry) {
        return cachedProvider;
    }

    try {
        const [rows] = await pool.query(
            "SELECT * FROM system_tech_providers WHERE is_active = '1' ORDER BY id DESC LIMIT 1"
        );

        if (rows && rows.length > 0) {
            const provider = rows[0];
            cachedProvider = provider;
            cacheExpiry = now + 30000;
            return provider;
        }
    } catch (err) {
        console.error("[TECH PROVIDER] Failed to fetch from DB:", err.message);
    }

    // Default Fallback (Empty)
    const fallback = {
        id: 0,
        provider_type: "aisensy",
        aisensy_partner_id: "",
        aisensy_api_key: "",
        meta_app_id: "",
        meta_app_secret: "",
        meta_config_id: "",
        meta_system_user_token: "",
        meta_webhook_verify_token: "",
        meta_graph_version: "v21.0",
        is_active: "1"
    };
    cachedProvider = fallback;
    cacheExpiry = now + 30000;
    return fallback;
}

/**
 * Invalidate cache
 */
export function invalidateTechProviderCache() {
    cachedProvider = null;
    cacheExpiry = 0;
}

/**
 * Mask sensitive credentials for UI/API response
 */
export function maskSensitive(str) {
    if (!str || typeof str !== "string") return "";
    if (str.length <= 8) return "••••••••";
    return str.slice(0, 4) + "••••••••" + str.slice(-4);
}

/**
 * Get sanitized settings for Admin UI
 */
export async function getSanitizedTechProviderSettings() {
    const raw = await getActiveTechProvider(true);
    return {
        id: raw.id,
        provider_type: raw.provider_type || "aisensy",
        aisensy: {
            partner_id: raw.aisensy_partner_id || "",
            api_key_masked: maskSensitive(raw.aisensy_api_key),
            has_api_key: Boolean(raw.aisensy_api_key)
        },
        own_meta: {
            app_id: raw.meta_app_id || "",
            app_secret_masked: maskSensitive(raw.meta_app_secret),
            has_app_secret: Boolean(raw.meta_app_secret),
            config_id: raw.meta_config_id || "",
            system_user_token_masked: maskSensitive(raw.meta_system_user_token),
            has_system_user_token: Boolean(raw.meta_system_user_token),
            webhook_verify_token_masked: maskSensitive(raw.meta_webhook_verify_token),
            has_webhook_verify_token: Boolean(raw.meta_webhook_verify_token),
            graph_version: raw.meta_graph_version || "v21.0"
        },
        is_active: raw.is_active || "1",
        modify_date: raw.modify_date,
        modify_by: raw.modify_by
    };
}

/**
 * Update Tech Provider Settings
 */
export async function saveTechProviderSettings(payload, username = "admin") {
    const current = await getActiveTechProvider(true);

    const provider_type = payload.provider_type === "own" ? "own" : "aisensy";

    // AiSensy fields
    const aisensy_partner_id = payload.aisensy_partner_id !== undefined ? String(payload.aisensy_partner_id).trim() : current.aisensy_partner_id;
    let aisensy_api_key = current.aisensy_api_key;
    if (payload.aisensy_api_key && !payload.aisensy_api_key.includes("••••")) {
        aisensy_api_key = String(payload.aisensy_api_key).trim();
    }

    // Meta Tech Provider fields
    const meta_app_id = payload.meta_app_id !== undefined ? String(payload.meta_app_id).trim() : current.meta_app_id;
    const meta_config_id = payload.meta_config_id !== undefined ? String(payload.meta_config_id).trim() : current.meta_config_id;
    const meta_graph_version = payload.meta_graph_version ? String(payload.meta_graph_version).trim() : (current.meta_graph_version || "v21.0");

    let meta_app_secret = current.meta_app_secret;
    if (payload.meta_app_secret && !payload.meta_app_secret.includes("••••")) {
        meta_app_secret = String(payload.meta_app_secret).trim();
    }

    let meta_system_user_token = current.meta_system_user_token;
    if (payload.meta_system_user_token && !payload.meta_system_user_token.includes("••••")) {
        meta_system_user_token = String(payload.meta_system_user_token).trim();
    }

    let meta_webhook_verify_token = current.meta_webhook_verify_token;
    if (payload.meta_webhook_verify_token && !payload.meta_webhook_verify_token.includes("••••")) {
        meta_webhook_verify_token = String(payload.meta_webhook_verify_token).trim();
    }

    const [existing] = await pool.query("SELECT id FROM system_tech_providers LIMIT 1");
    if (existing.length > 0) {
        await pool.query(`
            UPDATE system_tech_providers SET
                provider_type = ?,
                aisensy_partner_id = ?,
                aisensy_api_key = ?,
                meta_app_id = ?,
                meta_app_secret = ?,
                meta_config_id = ?,
                meta_system_user_token = ?,
                meta_webhook_verify_token = ?,
                meta_graph_version = ?,
                is_active = '1',
                modify_by = ?
            WHERE id = ?
        `, [
            provider_type,
            aisensy_partner_id,
            aisensy_api_key,
            meta_app_id,
            meta_app_secret,
            meta_config_id,
            meta_system_user_token,
            meta_webhook_verify_token,
            meta_graph_version,
            username,
            existing[0].id
        ]);
    } else {
        await pool.query(`
            INSERT INTO system_tech_providers (
                provider_type,
                aisensy_partner_id,
                aisensy_api_key,
                meta_app_id,
                meta_app_secret,
                meta_config_id,
                meta_system_user_token,
                meta_webhook_verify_token,
                meta_graph_version,
                is_active,
                create_by,
                modify_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '1', ?, ?)
        `, [
            provider_type,
            aisensy_partner_id,
            aisensy_api_key,
            meta_app_id,
            meta_app_secret,
            meta_config_id,
            meta_system_user_token,
            meta_webhook_verify_token,
            meta_graph_version,
            username,
            username
        ]);
    }

    invalidateTechProviderCache();
    return getSanitizedTechProviderSettings();
}

/**
 * Test AiSensy Partner Credentials
 */
export async function testAiSensyConnection(partnerId, apiKey) {
    if (!partnerId || !apiKey) {
        return { success: false, message: "Partner ID and Partner API Key are required." };
    }

    try {
        // Attempt a basic call to AiSensy partner endpoint
        const response = await axios.post(
            `https://apis.aisensy.com/partner-apis/v1/partner/${partnerId}/generate-waba-link`,
            { businessId: "test_health_check", assistantId: "test_health_check" },
            {
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "X-AiSensy-Partner-API-Key": apiKey
                },
                timeout: 8000
            }
        );

        return {
            success: true,
            message: "AiSensy Partner connection verified successfully!",
            data: response.data
        };
    } catch (err) {
        // Even if businessId does not exist, a 400 or specific partner error confirms authentication
        const status = err?.response?.status;
        const msg = err?.response?.data?.message || err?.message;

        if (status === 401 || status === 403) {
            return {
                success: false,
                message: `Authentication Failed (${status}): Invalid AiSensy Partner ID or API Key.`
            };
        }

        if (status === 400 || status === 404 || (msg && !msg.toLowerCase().includes("unauthorized"))) {
            return {
                success: true,
                message: "AiSensy Partner API credentials verified (API responded).",
                details: msg
            };
        }

        return {
            success: false,
            message: `Connection test failed: ${msg}`
        };
    }
}

/**
 * Test Meta Graph API / Own Tech Provider Credentials
 */
export async function testMetaConnection(appId, appSecret, systemUserToken, graphVersion = "v21.0") {
    if (!appId) {
        return { success: false, message: "Meta App ID is required." };
    }

    const tokenToUse = systemUserToken || (appId && appSecret ? `${appId}|${appSecret}` : null);
    if (!tokenToUse) {
        return { success: false, message: "System User Token or App Secret is required to test Meta connection." };
    }

    try {
        const url = `https://graph.facebook.com/${graphVersion}/${appId}?fields=id,name,category,link&access_token=${encodeURIComponent(tokenToUse)}`;
        const response = await axios.get(url, { timeout: 8000 });

        return {
            success: true,
            message: `Meta App verified: "${response.data?.name || appId}" (ID: ${response.data?.id})`,
            data: response.data
        };
    } catch (err) {
        const errorData = err?.response?.data?.error;
        const msg = errorData?.message || err?.message;
        return {
            success: false,
            message: `Meta API Test Failed: ${msg}`,
            code: errorData?.code
        };
    }
}

/**
 * Helper to subscribe WABA to Meta App Webhook
 */
export async function subscribeMetaWabaWebhook(wabaId, systemUserToken, graphVersion = "v21.0") {
    try {
        const url = `https://graph.facebook.com/${graphVersion}/${wabaId}/subscribed_apps`;
        const res = await axios.post(
            url,
            {},
            {
                headers: {
                    Authorization: `Bearer ${systemUserToken}`
                },
                timeout: 10000
            }
        );
        return { success: true, data: res.data };
    } catch (err) {
        console.error("[META WEBHOOK SUB ERROR]", err?.response?.data || err.message);
        return { success: false, error: err?.response?.data?.error?.message || err.message };
    }
}

/**
 * Exchange Meta Embedded Signup Code for System User / WABA Token
 */
export async function exchangeMetaEmbeddedSignupCode(code, appId, appSecret, graphVersion = "v21.0") {
    try {
        const url = `https://graph.facebook.com/${graphVersion}/oauth/access_token`;
        const res = await axios.get(url, {
            params: {
                client_id: appId,
                client_secret: appSecret,
                code: code
            },
            timeout: 10000
        });
        return { success: true, accessToken: res.data?.access_token, data: res.data };
    } catch (err) {
        console.error("[META CODE EXCHANGE ERROR]", err?.response?.data || err.message);
        return { success: false, error: err?.response?.data?.error?.message || err.message };
    }
}
