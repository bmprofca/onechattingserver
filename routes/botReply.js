import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP, USER_DATA } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";

const router = express.Router();

// Create bot reply context
router.post("/create", auth, async (req, res) => {
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
    const context_name = decrypt?.context_name;
    const keywords = decrypt?.keywords; // Array of keywords
    const response_message = decrypt?.response_message;
    const response_type = decrypt?.response_type || 'text'; // text, template, media
    const template_id = decrypt?.template_id || null;
    const conditions = decrypt?.conditions || null; // JSON object for conditions
    const is_active = decrypt?.is_active !== undefined ? (decrypt?.is_active === true || decrypt?.is_active === '1' || decrypt?.is_active === 1 ? '1' : '0') : '1';
    const priority = decrypt?.priority || 0; // Higher number = higher priority

    if (!project_id || !context_name || !keywords || !response_message) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, context_name, keywords, response_message' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    if (!Array.isArray(keywords) || keywords.length === 0) {
        return res.status(200).json({ error: 'keywords must be a non-empty array' });
    }

    try {
        const context_id = RANDOM_STRING(30);
        const keywords_json = JSON.stringify(keywords);
        const conditions_json = conditions ? JSON.stringify(conditions) : null;

        await pool.query(
            "INSERT INTO `bot_reply_context`(`context_id`, `project_id`, `context_name`, `keywords`, `response_message`, `response_type`, `template_id`, `conditions`, `is_active`, `priority`, `create_date`, `create_by`, `modify_date`, `modify_by`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [context_id, project_id, context_name, keywords_json, response_message, response_type, template_id, conditions_json, is_active, priority, TIMESTAMP(), username, TIMESTAMP(), username]
        );

        const creator_data = await USER_DATA(username);

        return res.status(200).json({
            error: false,
            msg: 'Bot reply context created successfully',
            data: {
                context_id,
                context_name,
                keywords,
                response_message,
                response_type,
                template_id,
                conditions: conditions || null,
                is_active: is_active === '1',
                priority,
                create_by: {
                    username: creator_data?.username,
                    name: creator_data?.name,
                    mobile: creator_data?.mobile,
                    email: creator_data?.email,
                    status: creator_data?.status == '1' ? true : false,
                }
            }
        });

    } catch (error) {
        return res.status(200).json({
            error: 'Failed to create bot reply context',
            e: error.message || error
        });
    }
});

// Update bot reply context
router.post("/update", auth, async (req, res) => {
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
    const context_id = decrypt?.context_id;
    const context_name = decrypt?.context_name;
    const keywords = decrypt?.keywords;
    const response_message = decrypt?.response_message;
    const response_type = decrypt?.response_type;
    const template_id = decrypt?.template_id;
    const conditions = decrypt?.conditions;
    const is_active = decrypt?.is_active !== undefined ? (decrypt?.is_active === true || decrypt?.is_active === '1' || decrypt?.is_active === 1 ? '1' : '0') : null;
    const priority = decrypt?.priority;

    if (!project_id || !context_id) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, context_id' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    // Check if context exists
    const [check_row] = await pool.query(
        "SELECT * FROM `bot_reply_context` WHERE project_id = ? AND context_id = ? AND is_deleted = '0'",
        [project_id, context_id]
    );

    if (check_row.length === 0) {
        return res.status(200).json({ error: 'Invalid context id' });
    }

    try {
        // Build update query dynamically
        const updateFields = [];
        const updateValues = [];

        if (context_name !== undefined) {
            updateFields.push("`context_name` = ?");
            updateValues.push(context_name);
        }
        if (keywords !== undefined) {
            if (!Array.isArray(keywords)) {
                return res.status(200).json({ error: 'keywords must be an array' });
            }
            updateFields.push("`keywords` = ?");
            updateValues.push(JSON.stringify(keywords));
        }
        if (response_message !== undefined) {
            updateFields.push("`response_message` = ?");
            updateValues.push(response_message);
        }
        if (response_type !== undefined) {
            updateFields.push("`response_type` = ?");
            updateValues.push(response_type);
        }
        if (template_id !== undefined) {
            updateFields.push("`template_id` = ?");
            updateValues.push(template_id);
        }
        if (conditions !== undefined) {
            updateFields.push("`conditions` = ?");
            updateValues.push(conditions ? JSON.stringify(conditions) : null);
        }
        if (is_active !== null) {
            updateFields.push("`is_active` = ?");
            updateValues.push(is_active);
        }
        if (priority !== undefined) {
            updateFields.push("`priority` = ?");
            updateValues.push(priority);
        }

        if (updateFields.length === 0) {
            return res.status(200).json({ error: 'No fields to update' });
        }

        updateFields.push("`modify_date` = ?");
        updateFields.push("`modify_by` = ?");
        updateValues.push(TIMESTAMP());
        updateValues.push(username);
        updateValues.push(project_id);
        updateValues.push(context_id);

        await pool.query(
            `UPDATE \`bot_reply_context\` SET ${updateFields.join(', ')} WHERE project_id = ? AND context_id = ?`,
            updateValues
        );

        return res.status(200).json({
            error: false,
            msg: 'Bot reply context updated successfully'
        });

    } catch (error) {
        return res.status(200).json({
            error: 'Failed to update bot reply context',
            e: error.message || error
        });
    }
});

// Delete bot reply context (soft delete)
router.post("/delete", auth, async (req, res) => {
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
    const context_id = decrypt?.context_id;

    if (!project_id || !context_id) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, context_id' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    const [check_row] = await pool.query(
        "SELECT * FROM `bot_reply_context` WHERE project_id = ? AND context_id = ? AND is_deleted = '0'",
        [project_id, context_id]
    );

    if (check_row.length === 0) {
        return res.status(200).json({ error: 'Invalid context id' });
    }

    try {
        await pool.query(
            "UPDATE `bot_reply_context` SET `is_deleted`=?,`delete_by`=?,`modify_date`=?,`modify_by`=? WHERE project_id = ? AND context_id = ?",
            ['1', username, TIMESTAMP(), username, project_id, context_id]
        );

        return res.status(200).json({
            error: false,
            msg: 'Bot reply context deleted successfully'
        });

    } catch (error) {
        return res.status(200).json({
            error: 'Failed to delete bot reply context',
            e: error.message || error
        });
    }
});

// Get bot reply context list
router.post("/list", auth, async (req, res) => {
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
    const is_active_filter = decrypt?.is_active; // 'all', '1', '0'
    var last_id = Number(decrypt?.last_id || 0);

    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        let query = "SELECT * FROM `bot_reply_context` WHERE project_id = ? AND is_deleted = '0'";
        const params = [project_id];

        if (is_active_filter && is_active_filter !== 'all') {
            query += " AND is_active = ?";
            params.push(is_active_filter);
        }

        if (last_id == 0) {
            query += " ORDER BY priority DESC, id DESC LIMIT 20";
        } else {
            query += " AND id < ? ORDER BY priority DESC, id DESC LIMIT 20";
            params.push(last_id);
        }

        const [rows] = await pool.query(query, params);

        const return_data = [];

        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];
            last_id = element?.id;

            const creator_data = await USER_DATA(element?.create_by);
            const modifier_data = await USER_DATA(element?.modify_by);

            var object = {
                context_id: element?.context_id,
                context_name: element?.context_name,
                keywords: JSON.parse(element?.keywords || '[]'),
                response_message: element?.response_message,
                response_type: element?.response_type,
                template_id: element?.template_id,
                conditions: element?.conditions ? JSON.parse(element?.conditions) : null,
                is_active: element?.is_active == '1' ? true : false,
                priority: element?.priority,
                create_date: element?.create_date,
                modify_date: element?.modify_date,
                create_by: {
                    username: creator_data?.username,
                    name: creator_data?.name,
                    mobile: creator_data?.mobile,
                    email: creator_data?.email,
                    status: creator_data?.status == '1' ? true : false,
                },
                modify_by: {
                    username: modifier_data?.username,
                    name: modifier_data?.name,
                    mobile: modifier_data?.mobile,
                    email: modifier_data?.email,
                    status: modifier_data?.status == '1' ? true : false,
                }
            };

            return_data.push(object);
        }

        return res.status(200).json({
            data: return_data,
            last_id,
            count: return_data.length,
            has_more: return_data.length >= 20
        });

    } catch (error) {
        return res.status(200).json({
            error: 'Failed to fetch bot reply context list',
            e: error.message || error
        });
    }
});

// Get single bot reply context details
router.post("/details", auth, async (req, res) => {
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
    const context_id = decrypt?.context_id;

    if (!project_id || !context_id) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, context_id' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        const [rows] = await pool.query(
            "SELECT * FROM `bot_reply_context` WHERE project_id = ? AND context_id = ? AND is_deleted = '0'",
            [project_id, context_id]
        );

        if (rows.length === 0) {
            return res.status(200).json({ error: 'Invalid context id' });
        }

        const element = rows[0];
        const creator_data = await USER_DATA(element?.create_by);
        const modifier_data = await USER_DATA(element?.modify_by);

        const object = {
            context_id: element?.context_id,
            context_name: element?.context_name,
            keywords: JSON.parse(element?.keywords || '[]'),
            response_message: element?.response_message,
            response_type: element?.response_type,
            template_id: element?.template_id,
            conditions: element?.conditions ? JSON.parse(element?.conditions) : null,
            is_active: element?.is_active == '1' ? true : false,
            priority: element?.priority,
            create_date: element?.create_date,
            modify_date: element?.modify_date,
            create_by: {
                username: creator_data?.username,
                name: creator_data?.name,
                mobile: creator_data?.mobile,
                email: creator_data?.email,
                status: creator_data?.status == '1' ? true : false,
            },
            modify_by: {
                username: modifier_data?.username,
                name: modifier_data?.name,
                mobile: modifier_data?.mobile,
                email: modifier_data?.email,
                status: modifier_data?.status == '1' ? true : false,
            }
        };

        return res.status(200).json({
            error: false,
            data: object,
            msg: 'Bot reply context fetched successfully'
        });

    } catch (error) {
        return res.status(200).json({
            error: 'Failed to fetch bot reply context',
            e: error.message || error
        });
    }
});

export default router;
