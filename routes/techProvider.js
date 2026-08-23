import express from "express";
import { 
    getSanitizedTechProviderSettings, 
    saveTechProviderSettings, 
    testAiSensyConnection, 
    testMetaConnection,
    getActiveTechProvider
} from "../helpers/techProvider.js";
import { getAdminByToken } from "../helpers/adminDb.js";
import { auth } from "../middleware/auth.js";

const router = express.Router();

// Admin Authentication Middleware
const authAdmin = async (req, res, next) => {
    try {
        let token = req.headers["x-auth-token"] || req.headers["x-token"] || req.headers["authorization"];
        if (!token) {
            return res.status(401).json({ error: "Auth token required." });
        }
        if (typeof token === "string" && token.startsWith("Bearer ")) {
            token = token.slice(7).trim();
        }

        const admin = await getAdminByToken(token);
        if (!admin) {
            return res.status(401).json({ error: "Invalid or expired admin token." });
        }

        req.admin = admin;
        next();
    } catch (err) {
        return res.status(500).json({ error: "Server error during admin authentication." });
    }
};

/**
 * GET /admin/tech-provider/config
 * Returns current provider settings with masked secrets
 */
router.get("/config", authAdmin, async (req, res) => {
    try {
        const settings = await getSanitizedTechProviderSettings();
        return res.status(200).json({
            error: false,
            data: settings
        });
    } catch (err) {
        console.error("[ADMIN TECH PROVIDER GET ERROR]", err);
        return res.status(500).json({ error: "Failed to fetch tech provider settings." });
    }
});

/**
 * POST /admin/tech-provider/config
 * Updates active tech provider and credentials
 */
router.post("/config", authAdmin, async (req, res) => {
    try {
        const payload = req.body || {};
        const adminUsername = req.admin?.username || "admin";

        if (payload.provider_type && !["aisensy", "own"].includes(payload.provider_type)) {
            return res.status(400).json({ error: "Invalid provider_type. Allowed: 'aisensy' or 'own'." });
        }

        const updatedSettings = await saveTechProviderSettings(payload, adminUsername);
        return res.status(200).json({
            error: false,
            message: `Tech Provider configuration updated successfully (${updatedSettings.provider_type === 'own' ? 'Own Meta Tech Provider' : 'AiSensy Partner'}).`,
            data: updatedSettings
        });
    } catch (err) {
        console.error("[ADMIN TECH PROVIDER POST ERROR]", err);
        return res.status(500).json({ error: "Failed to update tech provider settings." });
    }
});

/**
 * POST /admin/tech-provider/test-connection
 * Tests credentials for either AiSensy or Meta
 */
router.post("/test-connection", authAdmin, async (req, res) => {
    try {
        const { provider_type, aisensy, own_meta } = req.body || {};
        const active = await getActiveTechProvider(true);

        const targetProvider = provider_type || active.provider_type;

        if (targetProvider === "aisensy") {
            const partnerId = aisensy?.partner_id || active.aisensy_partner_id;
            const apiKey = (aisensy?.api_key && !aisensy.api_key.includes("••••")) 
                ? aisensy.api_key 
                : active.aisensy_api_key;
            const solutionId = aisensy?.solution_id || active.aisensy_solution_id;

            const testRes = await testAiSensyConnection(partnerId, apiKey, solutionId);
            return res.status(200).json({
                error: !testRes.success,
                provider: "aisensy",
                ...testRes
            });
        } else if (targetProvider === "own") {
            const appId = own_meta?.app_id || active.meta_app_id;
            const appSecret = (own_meta?.app_secret && !own_meta.app_secret.includes("••••"))
                ? own_meta.app_secret
                : active.meta_app_secret;
            const systemUserToken = (own_meta?.system_user_token && !own_meta.system_user_token.includes("••••"))
                ? own_meta.system_user_token
                : active.meta_system_user_token;
            const graphVersion = own_meta?.graph_version || active.meta_graph_version || "v21.0";

            const testRes = await testMetaConnection(appId, appSecret, systemUserToken, graphVersion);
            return res.status(200).json({
                error: !testRes.success,
                provider: "own",
                ...testRes
            });
        } else {
            return res.status(400).json({ error: "Unsupported provider_type for testing." });
        }
    } catch (err) {
        console.error("[ADMIN TECH PROVIDER TEST ERROR]", err);
        return res.status(500).json({ error: "Connection test encountered an error." });
    }
});

/**
 * GET /tech-provider/client-config
 * Public/Client-facing configuration for embedded login
 */
router.get("/client-config", auth, async (req, res) => {
    try {
        const active = await getActiveTechProvider();

        if (active.provider_type === "own") {
            return res.status(200).json({
                error: false,
                provider: "own",
                meta_app_id: active.meta_app_id || "",
                meta_config_id: active.meta_config_id || "",
                meta_graph_version: active.meta_graph_version || "v21.0"
            });
        }

        return res.status(200).json({
            error: false,
            provider: "aisensy"
        });
    } catch (err) {
        console.error("[TECH PROVIDER CLIENT CONFIG ERROR]", err);
        return res.status(500).json({ error: "Failed to fetch embedded signup config." });
    }
});

export default router;
