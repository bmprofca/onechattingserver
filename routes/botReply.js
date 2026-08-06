import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { TIMESTAMP } from "../helpers/function.js";
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

export default router;
