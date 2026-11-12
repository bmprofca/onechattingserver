import express from "express";
import pool from "../db.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { TIMESTAMP } from "../helpers/function.js";
import { getActiveTechProvider } from "../helpers/techProvider.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import {
    ensureOnboardingSettingsTable,
    getOnboardingCapabilities,
    normalizeOnboardingSettings,
    OnboardingSettingsValidationError,
    parseOnboardingSettings,
} from "../helpers/onboardingSettings.js";

const router = express.Router();

async function projectAccess(req, res, projectId, requireSettingsAccess = false) {
    if (!projectId || projectId.length > 191) {
        res.status(400).json({ error: "A valid project_id is required" });
        return false;
    }
    const username = String(req.headers.username || "");
    if (!(await CheckUserProjectMaping(username, projectId))) {
        res.status(403).json({ error: "User is not assigned to this project" });
        return false;
    }
    if (requireSettingsAccess) {
        const [rows] = await pool.query(
            `SELECT pm.type, po.status AS setting_access
             FROM project_mapping pm
             LEFT JOIN permission_options po
               ON po.permission_id = pm.permission_id AND po.permission = 'setting access'
             WHERE pm.username = ? AND pm.project_id = ? AND pm.is_deleted = '0'
             LIMIT 1`,
            [username, projectId]
        );
        if (!rows.length || (rows[0].type !== "admin" && rows[0].setting_access !== "1" && rows[0].setting_access !== 1)) {
            res.status(403).json({ error: "Project setting access is required" });
            return false;
        }
    }
    return true;
}

function sendFailure(res, error, operation) {
    if (error instanceof OnboardingSettingsValidationError) {
        return res.status(400).json({ error: error.message });
    }
    console.error(`[onboarding] ${operation} failed:`, error?.message || error);
    return res.status(500).json({ error: "Onboarding settings request failed" });
}

router.get("/settings", auth, async (req, res) => {
    const projectId = String(req.query.project_id || "");
    try {
        if (!(await projectAccess(req, res, projectId))) return undefined;
        await ensureOnboardingSettingsTable();
        const [[row], provider] = await Promise.all([
            pool.query(
                "SELECT ice_breakers, slash_commands FROM onboarding_prompt_settings WHERE project_id = ? LIMIT 1",
                [projectId]
            ).then(([rows]) => rows),
            getActiveTechProvider(),
        ]);
        return res.json({
            settings: parseOnboardingSettings(row),
            provider: provider.provider_type || "unknown",
            capabilities: getOnboardingCapabilities(provider.provider_type),
        });
    } catch (error) {
        return sendFailure(res, error, "read settings");
    }
});

router.put("/settings", auth, async (req, res) => {
    try {
        const payload = Decrypt(req.body?.data, req.body?.key);
        const projectId = String(payload?.project_id || "");
        if (!(await projectAccess(req, res, projectId, true))) return undefined;

        const provider = await getActiveTechProvider();
        const capabilities = getOnboardingCapabilities(provider.provider_type);
        if (!capabilities.ice_breakers || !capabilities.slash_commands) {
            return res.status(409).json({
                error: "The active WhatsApp provider does not support onboarding prompts",
                provider: provider.provider_type || "unknown",
                capabilities,
            });
        }

        const settings = normalizeOnboardingSettings(payload);
        await ensureOnboardingSettingsTable();
        await pool.query(
            `INSERT INTO onboarding_prompt_settings
                (project_id, ice_breakers, slash_commands, modify_date, modify_by)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                ice_breakers = VALUES(ice_breakers),
                slash_commands = VALUES(slash_commands),
                modify_date = VALUES(modify_date),
                modify_by = VALUES(modify_by)`,
            [
                projectId,
                JSON.stringify(settings.ice_breakers),
                JSON.stringify(settings.slash_commands),
                TIMESTAMP(),
                String(req.headers.username || ""),
            ]
        );
        return res.json({ settings, capabilities });
    } catch (error) {
        return sendFailure(res, error, "save settings");
    }
});

export default router;
