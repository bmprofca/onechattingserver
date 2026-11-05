import express from "express";
import axios from "axios";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { AISENSY_PROJECT_DATA, GetAiSensyProjectToken } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { sendError, sendSuccess } from "../helpers/apiResponse.js";
import { getActiveTechProvider } from "../helpers/techProvider.js";
import pool from "../db.js";

const router = express.Router();

function decryptPayload(req) {
    const payload = Decrypt(req.body?.data || "", req.body?.key || "");
    return payload && typeof payload === "object" && !Array.isArray(payload) ? payload : null;
}

async function validateProjectAccess(req, res, payload) {
    const username = req.headers["username"] || "";
    const project_id = String(payload.project_id || "").trim();
    if (!project_id) {
        sendError(res, { status: 400, message: "project_id is required" });
        return null;
    }

    if (!await CheckUserProjectMaping(username, project_id)) {
        sendError(res, { status: 403, message: "User is not assigned on the project" });
        return null;
    }

    return project_id;
}

router.post("/connect-link", auth, async (req, res) => {
    const payload = decryptPayload(req);
    if (!payload) {
        return sendError(res, { status: 400, message: "Invalid request payload" });
    }

    const project_id = await validateProjectAccess(req, res, payload);
    if (!project_id) return;

    const provider = await getActiveTechProvider();
    if (provider.provider_type !== "aisensy" || !provider.aisensy_partner_id || !provider.aisensy_api_key) {
        return sendError(res, {
            status: 503,
            message: "AiSensy partner credentials are unavailable. Contact your administrator.",
        });
    }

    const projectData = await AISENSY_PROJECT_DATA(project_id);
    if (!projectData?.business_id) {
        return sendError(res, {
            status: 409,
            message: "Project business information is unavailable for catalog connection.",
        });
    }

    try {
        const { data } = await axios.post(
            `https://apis.aisensy.com/partner-apis/v1/partner/${encodeURIComponent(provider.aisensy_partner_id)}/generate-catalog-connect-link`,
            {
                businessId: projectData.business_id,
                assistantId: project_id,
            },
            {
                headers: {
                    "Content-Type": "application/json",
                    Accept: "application/json",
                    "X-AiSensy-Partner-API-Key": provider.aisensy_api_key,
                },
                timeout: 15000,
            },
        );

        const link = data?.embeddedSignupURL;
        let connect_url;
        try {
            const parsedUrl = new URL(link);
            if (parsedUrl.protocol === "https:") connect_url = parsedUrl.toString();
        } catch {
            // A missing or invalid upstream link is reported below.
        }

        if (!connect_url) {
            console.error("[catalog-connect] AiSensy returned no valid connect URL", {
                request_id: req.requestId,
                project_id,
            });
            return sendError(res, {
                status: 502,
                message: "AiSensy did not return a valid catalog connection link. Please try again.",
            });
        }

        return sendSuccess(res, {
            data: { url: connect_url },
            message: "Catalog connection link generated successfully",
        });
    } catch (error) {
        console.error("[catalog-connect] AiSensy request failed:", {
            request_id: req.requestId,
            project_id,
            status: error?.response?.status,
            message: error?.response?.data?.message || error?.message,
        });
        return sendError(res, {
            status: 502,
            message: error?.response?.data?.message || "Failed to generate a catalog connection link from AiSensy.",
        });
    }
});

router.post("/product-catalogs", auth, async (req, res) => {
    const payload = decryptPayload(req);
    if (!payload) {
        return sendError(res, { status: 400, message: "Invalid request payload" });
    }

    const project_id = await validateProjectAccess(req, res, payload);
    if (!project_id) return;

    const [projectRows] = await pool.query(
        "SELECT is_catalog_connected FROM aisensy_projects WHERE project_id = ? LIMIT 1",
        [project_id],
    );
    if (projectRows[0]?.is_catalog_connected !== "1" && payload.verify_connection !== true) {
        return sendError(res, {
            status: 409,
            code: "CATALOG_NOT_CONNECTED",
            message: "Connect a Meta catalog to this WhatsApp project to view product catalogs.",
        });
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return sendError(res, { status: 503, message: "AiSensy project token is unavailable" });
    }

    const params = {};
    for (const field of ['after', 'before', 'fields']) {
        const value = payload[field];
        if (value === undefined || value === null || value === '') continue;
        if (typeof value !== 'string' || value.length > 4096) {
            return sendError(res, {
                status: 400,
                message: `${field} must be a string of at most 4096 characters`,
            });
        }
        params[field] = value;
    }

    try {
        const { data } = await axios.get('https://backend.aisensy.com/direct-apis/t1/catalog', {
            headers: {
                Accept: 'application/json',
                Authorization: 'Bearer ' + project_token,
            },
            params,
            timeout: 30000,
        });

        if (!payload.after && !payload.before) {
            await pool.query(
                "UPDATE aisensy_projects SET is_catalog_connected = '1' WHERE project_id = ?",
                [project_id],
            );
        }

        return sendSuccess(res, {
            data: { ...data, catalog_connected: true },
            message: "Product catalogs retrieved successfully",
        });
    } catch (error) {
        const upstreamData = error?.response?.data;
        const upstreamCode = upstreamData?.code ?? upstreamData?.error?.code;
        const upstreamType = typeof upstreamData?.type === "string"
            ? upstreamData.type.slice(0, 100)
            : undefined;
        const upstreamErrorMessage = upstreamData?.message || upstreamData?.error?.message;
        const upstreamMessage = typeof upstreamErrorMessage === "string"
            ? upstreamErrorMessage.slice(0, 500)
            : undefined;

        console.error('Product catalogs request failed:', {
            request_id: req.requestId,
            project_id,
            status: error?.response?.status,
            upstream_code: upstreamCode,
            upstream_type: upstreamType,
            upstream_message: upstreamMessage,
            message: error?.message,
        });

        if (Number(upstreamCode) === 190) {
            await pool.query(
                "UPDATE aisensy_projects SET is_catalog_connected = '0' WHERE project_id = ?",
                [project_id],
            );
            return sendError(res, {
                status: 409,
                code: "CATALOG_NOT_CONNECTED",
                message: "Catalog connection could not be verified. Connect the catalog and try again.",
            });
        }

        return sendError(res, {
            status: 502,
            message: upstreamMessage
                ? `AiSensy catalog request failed: ${upstreamMessage}`
                : 'Failed to load product catalogs from AiSensy',
        });
    }
});

export default router;
