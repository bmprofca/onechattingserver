import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { GetAiSensyProjectToken, RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";
import axios from "axios";
import { Decrypt } from "../helpers/Decrypt.js";
import {
    expandTemplateMediaUrls,
    parseTemplateJsonFromRow,
    processTemplateMediaForStorage,
    serializeTemplateJson,
} from "../helpers/templateStorage.js";
import {
    validateAuthenticationTemplate,
} from "../helpers/authenticationTemplate.js";

const router = express.Router();

// CHAT LIST

router.post("/create-template", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    const template = decrypt.template;


    if (!project_id || !template) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }

    const template_id = RANDOM_STRING(30);

    const is_json = template => { try { JSON.parse(template); return true; } catch { return false; } };

    if (!is_json) {
        return res.status(200).json({ error: 'Template format is not JSON' });
    }

    const template_name = template.name;
    if (!template_name) {
        return res.status(200).json({ error: 'Template name not provided' });
    }
    const language_code = template.language;
    if (!language_code) {
        return res.status(200).json({ error: 'Language code not provided' });
    }

    const authValidation = validateAuthenticationTemplate(template);
    if (!authValidation.valid) {
        return res.status(200).json({ error: authValidation.error });
    }

    const templatePayload = authValidation.template;

    let storageTemplate;
    let metaTemplate;
    try {
        storageTemplate = await processTemplateMediaForStorage(project_id, template_id, templatePayload);
        metaTemplate = await expandTemplateMediaUrls(project_id, template_id, storageTemplate);
    } catch (mediaError) {
        return res.status(200).json({ error: mediaError?.message || "Failed to store template media" });
    }

    const options = {
        method: 'POST',
        url: 'https://backend.aisensy.com/direct-apis/t1/wa_template',
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, application/xml',
            Authorization: `Bearer ${project_token}`
        },
        data: metaTemplate
    };

    try {
        const { data } = await axios.request(options);
        var status = data?.status;
        var waba_template_id = data?.id;

        if (data.category) {
            var category = data?.category;
        } else {
            var category = template?.category;
        }

        storageTemplate.category = category;
        const templateJson = serializeTemplateJson(storageTemplate);

        if (status == 'APPROVED') {
            await pool.query("INSERT INTO `templates`(`template_id`, `waba_template_id`, `category`, `create_date`, `create_by`, `modify_date`, `modify_by`, `template_name`, `project_id`, `status`,`language_code`, `template_json`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [template_id, waba_template_id, category, TIMESTAMP(), username, TIMESTAMP(), username, template_name, project_id, 'APPROVED', language_code, templateJson]);

        } else if (status == 'REJECTED') {
            var rejected_reason = data?.rejected_reason;
            await pool.query("INSERT INTO `templates`(`template_id`, `waba_template_id`, `category`, `create_date`, `create_by`, `modify_date`, `modify_by`, `template_name`, `project_id`, `status`, `reject_reason`,`language_code`, `template_json`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [template_id, waba_template_id, category, TIMESTAMP(), username, TIMESTAMP(), username, template_name, project_id, 'REJECTED', rejected_reason, language_code, templateJson]);
        } else {
            await pool.query("INSERT INTO `templates`(`template_id`, `waba_template_id`, `category`, `create_date`, `create_by`, `modify_date`, `modify_by`, `template_name`, `project_id`, `status`,`language_code`, `template_json`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [template_id, waba_template_id, category, TIMESTAMP(), username, TIMESTAMP(), username, template_name, project_id, 'PENDING', language_code, templateJson]);
        }

    } catch (error) {
        if (error.response) {
            return res.status(200).json({
                error: `${error.response.data?.message} ${error?.response?.data?.error_user_msg ? '- ' + error?.response?.data?.error_user_msg : ''}`,
                error_from: 'meta'
            });
        } else {
            return res.status(200).json({
                error: 'Failed to create template',
                e: error
            });
        }
    }

    var [latest_data] = await pool.query("SELECT * FROM templates WHERE template_id = ? AND project_id = ?", [template_id, project_id]);
    var status = latest_data[0]?.status;

    const responseTemplate = await expandTemplateMediaUrls(project_id, template_id, storageTemplate);

    return res.status(200).json({
        template_name,
        language_code,
        status,
        template_id,
        template: responseTemplate
    });
});

router.post("/template-list", auth, async (req, res) => {
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
    const status_filter = decrypt?.status;
    const category_filter = decrypt?.category;
    const page_no = Number(decrypt?.page_no) || 1;
    let limit = Number(decrypt?.limit) || 20;

    const hasCategoryFilter = category_filter != null && String(category_filter).trim() !== '';
    const categoryClause = hasCategoryFilter ? ' AND category = ?' : '';

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    // Ensure limit doesn't exceed 100
    if (limit > 100) {
        limit = 100;
    }

    const offset = (page_no - 1) * limit;

    const listParams = [project_id, `%${status_filter}%`, '0'];
    if (hasCategoryFilter) {
        listParams.push(String(category_filter).trim());
    }

    // Get total count for meta
    const [total_count_result] = await pool.query(
        `SELECT COUNT(*) as total FROM templates WHERE project_id = ? AND status LIKE ? AND is_deleted = ?${categoryClause}`,
        listParams
    );
    const total_records = total_count_result[0]?.total || 0;
    const total_pages = Math.ceil(total_records / limit);

    const pageParams = [...listParams, limit, offset];
    var [rows] = await pool.query(
        `SELECT * FROM templates WHERE project_id = ? AND status LIKE ? AND is_deleted = ?${categoryClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
        pageParams
    );

    const res_data = [];

    if (rows.length > 0) {
        for (const element of rows) {
            var template_id = element.template_id;
            var waba_template_id = element.waba_template_id;
            var category = element.category;
            var create_date = element.create_date;
            var template_name = element.template_name;
            var status = element.status;
            var reject_reason = element.reject_reason;

            const storedTemplate = parseTemplateJsonFromRow(element, template_id);
            var template = await expandTemplateMediaUrls(project_id, template_id, storedTemplate);

            var object = {
                template_id,
                waba_template_id,
                category,
                create_date,
                template_name,
                status,
                reject_reason,
                template
            };

            res_data.push(object);

        }

    }


    return res.status(200).json({
        data: res_data,
        count: res_data.length,
        meta: {
            page_no,
            limit,
            total_records,
            total_pages,
            has_more: page_no < total_pages
        }
    });
});

router.post("/template-details", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    var template_id = decrypt.template_id;

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    var [rows] = await pool.query(
        "SELECT * FROM templates WHERE project_id = ? AND template_id = ?",
        [project_id, template_id]
    );

    if (rows.length == 0) {
        return res.status(200).json({ error: 'Template not found' });
    }

    var data = rows[0];

    var template_id = data?.template_id;
    var template_name = data?.template_name;
    var status = data?.status;
    var waba_template_id = data?.waba_template_id;
    var category = data?.category;
    var create_date = data?.create_date;
    var reject_reason = data?.reject_reason;

    var storedTemplate = parseTemplateJsonFromRow(data, template_id);
    var template = await expandTemplateMediaUrls(project_id, template_id, storedTemplate);


    return res.status(200).json({
        data: {
            template_id,
            waba_template_id,
            template_name,
            status,
            category,
            create_date,
            project_id,
            reject_reason,
        },
        template
    });
});

router.post("/template-delete", auth, async (req, res) => {
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
    const template_id = decrypt?.template_id;

    if (!project_id || !template_id) {
        return res.status(200).json({ error: 'project_id and template_id are required' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        // Check if template exists and is not already deleted
        const [check_rows] = await pool.query(
            "SELECT * FROM `templates` WHERE `project_id` = ? AND `template_id` = ? AND `is_deleted` = ?",
            [project_id, template_id, '0']
        );

        if (check_rows.length === 0) {
            return res.status(200).json({
                error: 'Template not found or already deleted'
            });
        }

        // Update template: set is_deleted = '1', deleted_by = username, modify_date, modify_by
        await pool.query(
            "UPDATE `templates` SET `is_deleted` = ?, `deleted_by` = ?, `modify_date` = ?, `modify_by` = ? WHERE `project_id` = ? AND `template_id` = ? AND `is_deleted` = ?",
            ['1', username, TIMESTAMP(), username, project_id, template_id, '0']
        );

        return res.status(200).json({
            error: false,
            msg: 'Template deleted successfully',
        });

    } catch (error) {
        return res.status(200).json({
            error: 'Failed to delete template',
            e: error.message || error
        });
    }
});

router.post("/template-edit", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const template_id = decrypt?.template_id;
    const template = decrypt?.template;
    const category = decrypt?.category;

    if (!template_id || !template) {
        return res.status(200).json({ error: 'template_id and template are required' });
    }

    // Get template details from database
    const [template_rows] = await pool.query(
        "SELECT * FROM templates WHERE template_id = ? AND is_deleted = ?",
        [template_id, '0']
    );

    if (template_rows.length === 0) {
        return res.status(200).json({ error: 'Template not found or already deleted' });
    }

    const template_data = template_rows[0];
    const project_id = template_data.project_id;
    const waba_template_id = template_data.waba_template_id;
    const language_code = template_data.language_code;

    if (!waba_template_id) {
        return res.status(200).json({ error: 'Template waba_template_id not found' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(200).json({ error: 'Failed to get project token' });
    }



    const template_name = template?.name || template_data?.template_name;
    const editCategory = category || template?.category || template_data?.category;

    let templatePayload = template;
    if (editCategory === 'AUTHENTICATION') {
        const authValidation = validateAuthenticationTemplate({
            ...template,
            name: template_name,
            language: language_code,
            category: 'AUTHENTICATION',
        });
        if (!authValidation.valid) {
            return res.status(200).json({ error: authValidation.error });
        }
        templatePayload = authValidation.template;
    }

    let storageTemplate;
    let metaTemplate;
    try {
        storageTemplate = await processTemplateMediaForStorage(project_id, template_id, templatePayload);
        metaTemplate = await expandTemplateMediaUrls(project_id, template_id, storageTemplate);
    } catch (mediaError) {
        return res.status(200).json({ error: mediaError?.message || "Failed to store template media" });
    }

    const options = {
        method: 'POST',
        url: `https://backend.aisensy.com/direct-apis/t1/edit-template/${waba_template_id}`,
        headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, application/xml',
            Authorization: `Bearer ${project_token}`
        },
        data: metaTemplate
    };

    try {
        const { data } = await axios.request(options);
        var status = data?.status;

        const final_category = category || template?.category || '';

        storageTemplate.category = final_category;
        const templateJson = serializeTemplateJson(storageTemplate);

        await pool.query(
            "UPDATE `templates` SET `status` = ?, `template_name` = ?, `template_json` = ?, `modify_date` = ?, `modify_by` = ?, `category` = ? WHERE `template_id` = ? AND `project_id` = ?",
            ["PENDING", template_name, templateJson, TIMESTAMP(), username, final_category, template_id, project_id]
        );

        var [latest_data] = await pool.query("SELECT * FROM templates WHERE template_id = ? AND project_id = ?", [template_id, project_id]);
        var updated_status = latest_data[0]?.status;

        const responseTemplate = await expandTemplateMediaUrls(project_id, template_id, storageTemplate);

        return res.status(200).json({
            template_name,
            language_code,
            status: updated_status,
            template_id,
            template: responseTemplate
        });

    } catch (error) {
        if (error.response) {
            return res.status(200).json({
                error: `${error.response.data?.message} ${error?.response?.data?.error_user_msg ? '- ' + error?.response?.data?.error_user_msg : ''}`,
                error_from: 'meta'
            });
        } else {
            return res.status(200).json({
                error: 'Failed to edit template',
                e: error
            });
        }
    }
});

export default router;
