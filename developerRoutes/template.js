import express from "express";
import axios from "axios";
import pool from "../db.js";
import { developerTemplateAuth } from "../middleware/developerAuth.js";
import { GetAiSensyProjectToken, RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";
import {
    expandTemplateMediaUrls,
    parseTemplateJsonFromRow,
    processTemplateMediaForStorage,
    serializeTemplateJson,
} from "../helpers/templateStorage.js";
import { validateAuthenticationTemplate } from "../helpers/authenticationTemplate.js";

const router = express.Router();

function resolveProjectContext(req, res) {
    const project_id = req.developerProject?.project_id;

    if (!project_id) {
        res.status(200).json({ error: "Invalid or missing token" });
        return null;
    }

    return { project_id };
}

async function resolveProjectAdminUsername(project_id) {
    const [rows] = await pool.query(
        "SELECT username FROM project_mapping WHERE project_id = ? AND type = ? AND is_deleted = ? LIMIT 1",
        [project_id, "admin", "0"]
    );
    return rows[0]?.username || "developer_api";
}

router.get("/template-list", developerTemplateAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id } = ctx;
    const status = (req.query?.status ?? "").toString();
    const category_filter = (req.query?.category ?? "").toString().trim();
    const page_no = Number(req.query?.page_no) || 1;
    let limit = Number(req.query?.limit) || 20;

    if (limit > 100) {
        limit = 100;
    }

    const hasCategoryFilter = category_filter.length > 0;
    const categoryClause = hasCategoryFilter ? " AND category = ?" : "";
    const offset = (page_no - 1) * limit;

    const listParams = [project_id, `%${status}%`, "0"];
    if (hasCategoryFilter) {
        listParams.push(category_filter);
    }

    const [total_count_result] = await pool.query(
        `SELECT COUNT(*) as total FROM templates WHERE project_id = ? AND status LIKE ? AND is_deleted = ?${categoryClause}`,
        listParams
    );
    const total_records = total_count_result[0]?.total || 0;
    const total_pages = Math.ceil(total_records / limit);

    const pageParams = [...listParams, limit, offset];
    const [rows] = await pool.query(
        `SELECT * FROM templates WHERE project_id = ? AND status LIKE ? AND is_deleted = ?${categoryClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
        pageParams
    );

    const res_data = [];
    for (const element of rows) {
        const storedTemplate = parseTemplateJsonFromRow(element, element.template_id);
        const template = await expandTemplateMediaUrls(project_id, element.template_id, storedTemplate);

        res_data.push({
            template_id: element.template_id,
            waba_template_id: element.waba_template_id,
            category: element.category,
            language_code: element.language_code,
            create_date: element.create_date,
            template_name: element.template_name,
            status: element.status,
            reject_reason: element.reject_reason,
            template,
        });
    }

    return res.status(200).json({
        data: res_data,
        count: res_data.length,
        meta: {
            page_no,
            limit,
            total_records,
            total_pages,
            has_more: page_no < total_pages,
        },
    });
});

router.get("/template-details", developerTemplateAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id } = ctx;
    const template_id = req.query?.template_id;

    if (!template_id) {
        return res.status(400).json({ error: "template_id is required" });
    }

    const [rows] = await pool.query(
        "SELECT * FROM templates WHERE project_id = ? AND template_id = ?",
        [project_id, template_id]
    );

    if (rows.length === 0) {
        return res.status(404).json({ error: "Template not found" });
    }

    const data = rows[0];
    const storedTemplate = parseTemplateJsonFromRow(data, template_id);
    const template = await expandTemplateMediaUrls(project_id, template_id, storedTemplate);

    return res.status(200).json({
        data: {
            template_id: data?.template_id,
            waba_template_id: data?.waba_template_id,
            template_name: data?.template_name,
            status: data?.status,
            category: data?.category,
            language_code: data?.language_code,
            create_date: data?.create_date,
            project_id,
            reject_reason: data?.reject_reason,
        },
        template,
    });
});

router.post("/create-template", developerTemplateAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id } = ctx;
    const template = req.body?.template;

    if (!template || typeof template !== "object") {
        return res.status(400).json({ error: "template is required" });
    }

    const template_name = template.name;
    if (!template_name) {
        return res.status(400).json({ error: "Template name not provided" });
    }

    const language_code = template.language;
    if (!language_code) {
        return res.status(400).json({ error: "Language code not provided" });
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(400).json({ error: "Failed to get project token" });
    }

    const authValidation = validateAuthenticationTemplate(template);
    if (!authValidation.valid) {
        return res.status(400).json({ error: authValidation.error });
    }

    const template_id = RANDOM_STRING(30);
    const templatePayload = authValidation.template;
    const username = await resolveProjectAdminUsername(project_id);

    let storageTemplate;
    let metaTemplate;
    try {
        storageTemplate = await processTemplateMediaForStorage(project_id, template_id, templatePayload);
        metaTemplate = await expandTemplateMediaUrls(project_id, template_id, storageTemplate);
    } catch (mediaError) {
        return res.status(400).json({ error: mediaError?.message || "Failed to store template media" });
    }

    try {
        const { data } = await axios.request({
            method: "POST",
            url: "https://backend.aisensy.com/direct-apis/t1/wa_template",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, application/xml",
                Authorization: `Bearer ${project_token}`,
            },
            data: metaTemplate,
        });

        const status = data?.status;
        const waba_template_id = data?.id;
        const category = data?.category || template?.category;

        storageTemplate.category = category;
        const templateJson = serializeTemplateJson(storageTemplate);

        if (status === "APPROVED") {
            await pool.query(
                "INSERT INTO `templates`(`template_id`, `waba_template_id`, `category`, `create_date`, `create_by`, `modify_date`, `modify_by`, `template_name`, `project_id`, `status`,`language_code`, `template_json`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                [template_id, waba_template_id, category, TIMESTAMP(), username, TIMESTAMP(), username, template_name, project_id, "APPROVED", language_code, templateJson]
            );
        } else if (status === "REJECTED") {
            const rejected_reason = data?.rejected_reason;
            await pool.query(
                "INSERT INTO `templates`(`template_id`, `waba_template_id`, `category`, `create_date`, `create_by`, `modify_date`, `modify_by`, `template_name`, `project_id`, `status`, `reject_reason`,`language_code`, `template_json`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                [template_id, waba_template_id, category, TIMESTAMP(), username, TIMESTAMP(), username, template_name, project_id, "REJECTED", rejected_reason, language_code, templateJson]
            );
        } else {
            await pool.query(
                "INSERT INTO `templates`(`template_id`, `waba_template_id`, `category`, `create_date`, `create_by`, `modify_date`, `modify_by`, `template_name`, `project_id`, `status`,`language_code`, `template_json`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                [template_id, waba_template_id, category, TIMESTAMP(), username, TIMESTAMP(), username, template_name, project_id, "PENDING", language_code, templateJson]
            );
        }
    } catch (error) {
        if (error.response) {
            return res.status(400).json({
                error: `${error.response.data?.message}${error?.response?.data?.error_user_msg ? " - " + error.response.data.error_user_msg : ""}`,
                error_from: "meta",
            });
        }
        return res.status(400).json({ error: "Failed to create template" });
    }

    const [latest_data] = await pool.query(
        "SELECT * FROM templates WHERE template_id = ? AND project_id = ?",
        [template_id, project_id]
    );
    const responseTemplate = await expandTemplateMediaUrls(project_id, template_id, storageTemplate);

    return res.status(200).json({
        template_name,
        language_code,
        status: latest_data[0]?.status,
        template_id,
        template: responseTemplate,
    });
});

router.post("/template-edit", developerTemplateAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id } = ctx;
    const template_id = req.body?.template_id;
    const template = req.body?.template;
    const category = req.body?.category;

    if (!template_id || !template) {
        return res.status(400).json({ error: "template_id and template are required" });
    }

    const [template_rows] = await pool.query(
        "SELECT * FROM templates WHERE template_id = ? AND project_id = ? AND is_deleted = ?",
        [template_id, project_id, "0"]
    );

    if (template_rows.length === 0) {
        return res.status(404).json({ error: "Template not found or already deleted" });
    }

    const template_data = template_rows[0];
    const waba_template_id = template_data.waba_template_id;
    const language_code = template_data.language_code;

    if (!waba_template_id) {
        return res.status(400).json({ error: "Template waba_template_id not found" });
    }

    const project_token = await GetAiSensyProjectToken(project_id);
    if (!project_token) {
        return res.status(400).json({ error: "Failed to get project token" });
    }

    const template_name = template?.name || template_data?.template_name;
    const editCategory = category || template?.category || template_data?.category;
    const username = await resolveProjectAdminUsername(project_id);

    let templatePayload = template;
    if (editCategory === "AUTHENTICATION") {
        const authValidation = validateAuthenticationTemplate({
            ...template,
            name: template_name,
            language: language_code,
            category: "AUTHENTICATION",
        });
        if (!authValidation.valid) {
            return res.status(400).json({ error: authValidation.error });
        }
        templatePayload = authValidation.template;
    }

    let storageTemplate;
    let metaTemplate;
    try {
        storageTemplate = await processTemplateMediaForStorage(project_id, template_id, templatePayload);
        metaTemplate = await expandTemplateMediaUrls(project_id, template_id, storageTemplate);
    } catch (mediaError) {
        return res.status(400).json({ error: mediaError?.message || "Failed to store template media" });
    }

    try {
        await axios.request({
            method: "POST",
            url: `https://backend.aisensy.com/direct-apis/t1/edit-template/${waba_template_id}`,
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, application/xml",
                Authorization: `Bearer ${project_token}`,
            },
            data: metaTemplate,
        });

        const final_category = category || template?.category || template_data?.category || "";
        storageTemplate.category = final_category;
        const templateJson = serializeTemplateJson(storageTemplate);

        await pool.query(
            "UPDATE `templates` SET `status` = ?, `template_name` = ?, `template_json` = ?, `modify_date` = ?, `modify_by` = ?, `category` = ? WHERE `template_id` = ? AND `project_id` = ?",
            ["PENDING", template_name, templateJson, TIMESTAMP(), username, final_category, template_id, project_id]
        );

        const [latest_data] = await pool.query(
            "SELECT * FROM templates WHERE template_id = ? AND project_id = ?",
            [template_id, project_id]
        );
        const responseTemplate = await expandTemplateMediaUrls(project_id, template_id, storageTemplate);

        return res.status(200).json({
            template_name,
            language_code,
            status: latest_data[0]?.status,
            template_id,
            template: responseTemplate,
        });
    } catch (error) {
        if (error.response) {
            return res.status(400).json({
                error: `${error.response.data?.message}${error?.response?.data?.error_user_msg ? " - " + error.response.data.error_user_msg : ""}`,
                error_from: "meta",
            });
        }
        return res.status(400).json({ error: "Failed to edit template" });
    }
});

router.post("/template-delete", developerTemplateAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id } = ctx;
    const template_id = req.body?.template_id;

    if (!template_id) {
        return res.status(400).json({ error: "template_id is required" });
    }

    const username = await resolveProjectAdminUsername(project_id);

    try {
        const [check_rows] = await pool.query(
            "SELECT * FROM `templates` WHERE `project_id` = ? AND `template_id` = ? AND `is_deleted` = ?",
            [project_id, template_id, "0"]
        );

        if (check_rows.length === 0) {
            return res.status(404).json({ error: "Template not found or already deleted" });
        }

        await pool.query(
            "UPDATE `templates` SET `is_deleted` = ?, `deleted_by` = ?, `modify_date` = ?, `modify_by` = ? WHERE `project_id` = ? AND `template_id` = ? AND `is_deleted` = ?",
            ["1", username, TIMESTAMP(), username, project_id, template_id, "0"]
        );

        return res.status(200).json({
            error: false,
            msg: "Template deleted successfully",
        });
    } catch (error) {
        return res.status(400).json({ error: "Failed to delete template" });
    }
});

export default router;
