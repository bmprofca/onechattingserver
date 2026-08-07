import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { TIMESTAMP, RANDOM_STRING } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";

const router = express.Router();

// Get project auto-reply settings and context
router.post("/get-settings", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;

    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        const [rows] = await pool.query(
            "SELECT auto_reply, auto_reply_type, context FROM aisensy_projects WHERE project_id = ?",
            [project_id]
        );

        if (rows.length === 0) {
            return res.status(200).json({ error: 'Project not found' });
        }

        const isAutoReplyActive = rows[0].auto_reply === '1';
        return res.status(200).json({
            error: false,
            data: {
                auto_reply: isAutoReplyActive,
                auto_reply_type: isAutoReplyActive ? (rows[0].auto_reply_type || 'new') : null,
                context: rows[0].context || ''
            },
            msg: 'Settings fetched successfully'
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to fetch settings',
            e: error.message || error
        });
    }
});

// Get project auto-reply status and type via query
router.get("/status", auth, async (req, res) => {
    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = req.query.project_id || '';

    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        const [rows] = await pool.query(
            "SELECT auto_reply, auto_reply_type FROM aisensy_projects WHERE project_id = ?",
            [project_id]
        );

        if (rows.length === 0) {
            return res.status(200).json({ error: 'Project not found' });
        }

        const isAutoReplyActive = rows[0].auto_reply === '1';
        return res.status(200).json({
            error: false,
            auto_reply: isAutoReplyActive,
            auto_reply_type: isAutoReplyActive ? (rows[0].auto_reply_type || 'new') : null
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to fetch auto-reply status',
            e: error.message || error
        });
    }
});

// Update auto-reply toggle
router.post("/toggle-auto-reply", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const auto_reply = decrypt?.auto_reply === true || decrypt?.auto_reply === '1' ? '1' : '0';

    if (!project_id || decrypt?.auto_reply === undefined) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, auto_reply' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        if (auto_reply === '0') {
            await pool.query(
                "UPDATE aisensy_projects SET auto_reply = ?, auto_reply_type = NULL, modify_date = ?, modify_by = ? WHERE project_id = ?",
                [auto_reply, TIMESTAMP(), username, project_id]
            );
        } else {
            await pool.query(
                "UPDATE aisensy_projects SET auto_reply = ?, modify_date = ?, modify_by = ? WHERE project_id = ?",
                [auto_reply, TIMESTAMP(), username, project_id]
            );
        }

        return res.status(200).json({
            error: false,
            msg: `Auto-reply turned ${auto_reply === '1' ? 'ON' : 'OFF'}`
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to update auto-reply status',
            e: error.message || error
        });
    }
});

// Update context text
router.post("/update-context", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const context = decrypt?.context;

    if (!project_id || context === undefined) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, context' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        await pool.query(
            "UPDATE aisensy_projects SET context = ?, modify_date = ?, modify_by = ? WHERE project_id = ?",
            [context, TIMESTAMP(), username, project_id]
        );

        return res.status(200).json({
            error: false,
            msg: 'Company context updated successfully'
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to update company context',
            e: error.message || error
        });
    }
});

// Update auto-reply type (all conversations vs new conversations only)
router.post("/update-auto-reply-type", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const auto_reply_type = decrypt?.auto_reply_type;

    if (!project_id || !auto_reply_type) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, auto_reply_type' });
    }

    if (!['all', 'new'].includes(auto_reply_type)) {
        return res.status(200).json({ error: 'auto_reply_type must be either "all" or "new"' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        await pool.query(
            "UPDATE aisensy_projects SET auto_reply_type = ?, modify_date = ?, modify_by = ? WHERE project_id = ?",
            [auto_reply_type, TIMESTAMP(), username, project_id]
        );

        const label = auto_reply_type === 'all' ? 'All conversations' : 'New conversations only';
        return res.status(200).json({
            error: false,
            msg: `Auto-reply type set to: ${label}`
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to update auto-reply type',
            e: error.message || error
        });
    }
});

// ============================================================
// API Key Management CRUD Endpoints
// ============================================================

/**
 * Helper: Mask an API key for safe display (show last 4 chars only)
 * e.g. "AIzaSyB1234567890abcdef" → "••••••••cdef"
 */
function maskApiKey(apiKey) {
    if (!apiKey || apiKey.length <= 4) return '••••';
    return '••••••••' + apiKey.slice(-4);
}

// List all API keys for a project (non-deleted, masked)
router.post("/list-api-keys", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;

    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        // Get project unique_id to query the api keys table
        const [projectRows] = await pool.query(
            "SELECT unique_id, agent_use_personal_key FROM aisensy_projects WHERE project_id = ? LIMIT 1",
            [project_id]
        );

        if (projectRows.length === 0) {
            return res.status(200).json({ error: 'Project not found' });
        }

        const projectUniqueId = projectRows[0].unique_id;
        const agent_use_personal_key = projectRows[0].agent_use_personal_key === '1';

        const [keyRows] = await pool.query(
            "SELECT unique_id, api_provider, api_model, api_key, is_active, create_date, create_by FROM project_agent_api_keys WHERE aisensy_project = ? AND is_deleted = '0' ORDER BY create_date DESC",
            [projectUniqueId]
        );

        // Mask the api_key for safe display
        const keys = keyRows.map(row => ({
            unique_id: row.unique_id,
            api_provider: row.api_provider,
            api_model: row.api_model,
            api_key_masked: maskApiKey(row.api_key),
            is_active: row.is_active === '1',
            create_date: row.create_date,
            create_by: row.create_by
        }));

        return res.status(200).json({
            error: false,
            data: {
                agent_use_personal_key,
                keys
            },
            msg: 'API keys fetched successfully'
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to fetch API keys',
            e: error.message || error
        });
    }
});

// Save a new API key
router.post("/save-api-key", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const api_provider = decrypt?.api_provider || 'gemini';
    const api_model = decrypt?.api_model || null;
    const api_key = decrypt?.api_key;

    if (!project_id || !api_key) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, api_key' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        // Get project unique_id
        const [projectRows] = await pool.query(
            "SELECT unique_id FROM aisensy_projects WHERE project_id = ? LIMIT 1",
            [project_id]
        );

        if (projectRows.length === 0) {
            return res.status(200).json({ error: 'Project not found' });
        }

        const projectUniqueId = projectRows[0].unique_id;
        const keyUniqueId = RANDOM_STRING(30);

        await pool.query(
            "INSERT INTO project_agent_api_keys (unique_id, aisensy_project, api_provider, api_model, api_key, is_active, create_date, create_by) VALUES (?, ?, ?, ?, ?, '1', ?, ?)",
            [keyUniqueId, projectUniqueId, api_provider, api_model, api_key, TIMESTAMP(), username]
        );

        return res.status(200).json({
            error: false,
            data: {
                unique_id: keyUniqueId,
                api_provider,
                api_model,
                api_key_masked: maskApiKey(api_key),
                is_active: true
            },
            msg: 'API key saved successfully'
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to save API key',
            e: error.message || error
        });
    }
});

// Update an existing API key
router.post("/update-api-key", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const key_unique_id = decrypt?.key_unique_id;

    if (!project_id || !key_unique_id) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, key_unique_id' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        // Get project unique_id
        const [projectRows] = await pool.query(
            "SELECT unique_id FROM aisensy_projects WHERE project_id = ? LIMIT 1",
            [project_id]
        );

        if (projectRows.length === 0) {
            return res.status(200).json({ error: 'Project not found' });
        }

        const projectUniqueId = projectRows[0].unique_id;

        // Verify the key belongs to this project and is not deleted
        const [existingRows] = await pool.query(
            "SELECT id FROM project_agent_api_keys WHERE unique_id = ? AND aisensy_project = ? AND is_deleted = '0' LIMIT 1",
            [key_unique_id, projectUniqueId]
        );

        if (existingRows.length === 0) {
            return res.status(200).json({ error: 'API key not found or does not belong to this project' });
        }

        // Build dynamic update query based on provided fields
        const updates = [];
        const values = [];

        if (decrypt?.api_provider !== undefined) {
            updates.push("api_provider = ?");
            values.push(decrypt.api_provider);
        }
        if (decrypt?.api_model !== undefined) {
            updates.push("api_model = ?");
            values.push(decrypt.api_model);
        }
        if (decrypt?.api_key !== undefined) {
            updates.push("api_key = ?");
            values.push(decrypt.api_key);
        }
        if (decrypt?.is_active !== undefined) {
            const is_active = decrypt.is_active === true || decrypt.is_active === '1' ? '1' : '0';
            updates.push("is_active = ?");
            values.push(is_active);
        }

        if (updates.length === 0) {
            return res.status(200).json({ error: 'No fields to update. Provide at least one of: api_provider, api_model, api_key, is_active' });
        }

        updates.push("modify_by = ?");
        values.push(username);

        values.push(key_unique_id);
        values.push(projectUniqueId);

        await pool.query(
            `UPDATE project_agent_api_keys SET ${updates.join(", ")} WHERE unique_id = ? AND aisensy_project = ? AND is_deleted = '0'`,
            values
        );

        return res.status(200).json({
            error: false,
            msg: 'API key updated successfully'
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to update API key',
            e: error.message || error
        });
    }
});

// Soft-delete an API key
router.post("/delete-api-key", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const key_unique_id = decrypt?.key_unique_id;

    if (!project_id || !key_unique_id) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, key_unique_id' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        // Get project unique_id
        const [projectRows] = await pool.query(
            "SELECT unique_id FROM aisensy_projects WHERE project_id = ? LIMIT 1",
            [project_id]
        );

        if (projectRows.length === 0) {
            return res.status(200).json({ error: 'Project not found' });
        }

        const projectUniqueId = projectRows[0].unique_id;

        // Soft-delete: set is_deleted = '1'
        const [result] = await pool.query(
            "UPDATE project_agent_api_keys SET is_deleted = '1', modify_by = ? WHERE unique_id = ? AND aisensy_project = ? AND is_deleted = '0'",
            [username, key_unique_id, projectUniqueId]
        );

        if (result.affectedRows === 0) {
            return res.status(200).json({ error: 'API key not found or already deleted' });
        }

        return res.status(200).json({
            error: false,
            msg: 'API key deleted successfully'
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to delete API key',
            e: error.message || error
        });
    }
});

export default router;
