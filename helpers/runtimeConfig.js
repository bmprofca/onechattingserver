import pool from "../db.js";
import { ensureSettingsTable } from "./settings.js";

function timestamp() {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

const MANAGED_SETTINGS = [
    { group: "integrations", key: "google_client_id", env: "GOOGLE_CLIENT_ID", label: "Google client ID", type: "text", sort: 10 },
    { group: "integrations", key: "turnstile_site_key", env: "TURNSTILE_SITE_KEY", label: "Turnstile site key", type: "text", sort: 20 },
    { group: "integrations", key: "turnstile_secret_key", env: "TURNSTILE_SECRET_KEY", label: "Turnstile secret key", type: "secret", sort: 30 },

    { group: "email", key: "smtp_host", env: "SMTP_HOST", label: "SMTP host", type: "text", sort: 10 },
    { group: "email", key: "smtp_port", env: "SMTP_PORT", label: "SMTP port", type: "number", sort: 20, fallback: "465" },
    { group: "email", key: "smtp_secure", env: "SMTP_SECURE", label: "SMTP secure", type: "boolean", sort: 30, fallback: "true" },
    { group: "email", key: "smtp_user", env: "SMTP_USER", label: "SMTP user", type: "text", sort: 40 },
    { group: "email", key: "smtp_pass", env: "SMTP_PASS", label: "SMTP password", type: "secret", sort: 50 },
    { group: "email", key: "smtp_from", env: "SMTP_FROM", label: "SMTP from address", type: "text", sort: 60 },

    { group: "payments", key: "razorpay_key_id", env: "RAZORPAY_KEY_ID", label: "Razorpay key ID", type: "text", sort: 10 },
    { group: "payments", key: "razorpay_key_secret", env: "RAZORPAY_KEY_SECRET", label: "Razorpay key secret", type: "secret", sort: 20 },
    { group: "payments", key: "razorpay_webhook_secret", env: "RAZORPAY_WEBHOOK_SECRET", label: "Razorpay webhook secret", type: "secret", sort: 30 },

    { group: "runtime", key: "db_connection_limit", env: "DB_CONNECTION_LIMIT", label: "DB connection limit (restart required)", type: "number", sort: 10, fallback: "5" },
    { group: "runtime", key: "auth_cache_ttl_ms", env: "AUTH_CACHE_TTL_MS", label: "Auth cache TTL (ms)", type: "number", sort: 20, fallback: "300000" },
    { group: "runtime", key: "project_mapping_cache_ttl_ms", env: "PROJECT_MAPPING_CACHE_TTL_MS", label: "Project mapping cache TTL (ms)", type: "number", sort: 30, fallback: "120000" },
    { group: "runtime", key: "billing_cron_enabled", env: "BILLING_CRON_ENABLED", label: "Billing cron enabled (restart required)", type: "boolean", sort: 40, fallback: "true" },
    { group: "runtime", key: "billing_cron_schedule", env: "BILLING_CRON_SCHEDULE", label: "Billing cron schedule (restart required)", type: "text", sort: 50, fallback: "5 0 * * *" },
    { group: "runtime", key: "webhook_queue_interval_ms", env: "WEBHOOK_QUEUE_INTERVAL_MS", label: "Webhook queue interval ms (restart required)", type: "number", sort: 60, fallback: "3000" },
    { group: "runtime", key: "generate_db_summary", env: "GENERATE_DB_SUMMARY", label: "Generate DB summary on startup", type: "boolean", sort: 70, fallback: "false" },

    { group: "storage", key: "b2_endpoint", env: "B2_ENDPOINT", label: "B2 endpoint", type: "text", sort: 10 },
    { group: "storage", key: "b2_region", env: "B2_REGION", label: "B2 region", type: "text", sort: 20 },
    { group: "storage", key: "b2_bucket", env: "B2_BUCKET", label: "B2 bucket", type: "text", sort: 30 },
    { group: "storage", key: "b2_access_key", env: "B2_ACCESS_KEY", label: "B2 access key", type: "secret", sort: 40 },
    { group: "storage", key: "b2_secret_key", env: "B2_SECRET_KEY", label: "B2 secret key", type: "secret", sort: 50 },
    { group: "storage", key: "b2_download_auth_ttl_seconds", env: "B2_DOWNLOAD_AUTH_TTL_SECONDS", label: "B2 download auth TTL (seconds)", type: "number", sort: 60, fallback: "86400" },
    { group: "storage", key: "b2_public_url", env: "B2_PUBLIC_URL", label: "B2 public URL", type: "text", sort: 70 },

    { group: "communications", key: "fast2sms_api_key", env: "FAST2SMS_API_KEY", label: "Fast2SMS API key", type: "secret", sort: 10 },
    { group: "communications", key: "fast2sms_sender_id", env: "FAST2SMS_SENDER_ID", label: "Fast2SMS sender ID", type: "text", sort: 20 },
    { group: "communications", key: "fast2sms_url", env: "FAST2SMS_URL", label: "Fast2SMS URL", type: "text", sort: 30 },
    { group: "communications", key: "fast2sms_otp_template", env: "FAST2SMS_OTP_TEMPLATE", label: "Fast2SMS OTP template", type: "text", sort: 40 },
    { group: "communications", key: "onechatting_template_token", env: "ONECHATTING_TEMPLATE_TOKEN", label: "OneChatting template token", type: "secret", sort: 50 },
    { group: "communications", key: "onechatting_send_token", env: "ONECHATTING_SEND_TOKEN", label: "OneChatting send token", type: "secret", sort: 60 },
    { group: "communications", key: "onechatting_send_url", env: "ONECHATTING_SEND_URL", label: "OneChatting send URL", type: "text", sort: 70 },
];

const managedKeys = new Set(MANAGED_SETTINGS.map((item) => item.key));
let cache = null;

function seedValue(definition) {
    const fromEnv = process.env[definition.env];
    if (fromEnv != null && String(fromEnv) !== "") return String(fromEnv);
    return definition.fallback ?? "";
}

export function isManagedSetting(key) {
    return managedKeys.has(String(key || "").trim().toLowerCase());
}

export async function loadRuntimeConfig() {
    await ensureSettingsTable();

    for (const definition of MANAGED_SETTINGS) {
        await pool.query(
            `INSERT INTO settings
                (setting_group, setting_key, setting_value, label, value_type, is_public, sort_order, updated_at)
             SELECT ?, ?, ?, ?, ?, 0, ?, ?
             FROM DUAL
             WHERE NOT EXISTS (
                SELECT 1 FROM settings WHERE setting_group = ? AND setting_key = ?
             )`,
            [
                definition.group,
                definition.key,
                seedValue(definition),
                definition.label,
                definition.type,
                definition.sort,
                timestamp(),
                definition.group,
                definition.key,
            ]
        );
    }

    await refreshRuntimeConfig();
}

export async function refreshRuntimeConfig() {
    const groups = [...new Set(MANAGED_SETTINGS.map((item) => item.group))];
    const [rows] = await pool.query(
        `SELECT setting_key, setting_value FROM settings WHERE setting_group IN (${groups.map(() => "?").join(",")})`,
        groups
    );
    const next = new Map();
    for (const row of rows) {
        next.set(String(row.setting_key || "").toLowerCase(), row.setting_value ?? "");
    }
    cache = next;
}

export function getConfig(key, fallback = "") {
    const normalized = String(key || "").trim().toLowerCase();
    if (cache && cache.has(normalized)) {
        return cache.get(normalized) ?? "";
    }
    const definition = MANAGED_SETTINGS.find((item) => item.key === normalized);
    if (definition) {
        const fromEnv = process.env[definition.env];
        if (fromEnv != null && String(fromEnv) !== "") return String(fromEnv);
        return definition.fallback ?? fallback;
    }
    return fallback;
}

export function getConfigNumber(key, fallback) {
    const parsed = Number(getConfig(key, ""));
    return Number.isFinite(parsed) && String(getConfig(key, "")) !== "" ? parsed : fallback;
}

export function getConfigBool(key, fallback = false) {
    const raw = String(getConfig(key, "")).trim().toLowerCase();
    if (!raw) return fallback;
    return raw === "1" || raw === "true" || raw === "yes" || raw === "on";
}
