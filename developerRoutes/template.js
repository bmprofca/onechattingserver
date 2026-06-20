import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import pool from "../db.js";
import { developerTemplateAuth } from "../middleware/developerAuth.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveProjectContext(req, res) {
    const project_id = req.developerProject?.project_id;

    if (!project_id) {
        res.status(200).json({ error: "Invalid or missing token" });
        return null;
    }

    return { project_id };
}

function loadTemplateJson(template_id) {
    const filePath = path.join(__dirname, "../media/templates/" + template_id + ".json");
    if (fs.existsSync(filePath)) {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    }
    return {};
}

router.get("/template-list", developerTemplateAuth, async (req, res) => {
    const ctx = resolveProjectContext(req, res);
    if (!ctx) return;

    const { project_id } = ctx;
    const status = (req.query?.status ?? "").toString();
    const page_no = Number(req.query?.page_no) || 1;
    let limit = Number(req.query?.limit) || 20;

    if (limit > 100) {
        limit = 100;
    }

    const offset = (page_no - 1) * limit;

    const [total_count_result] = await pool.query(
        "SELECT COUNT(*) as total FROM templates WHERE project_id = ? AND status LIKE ? AND is_deleted = ?",
        [project_id, `%${status}%`, "0"]
    );
    const total_records = total_count_result[0]?.total || 0;
    const total_pages = Math.ceil(total_records / limit);

    const [rows] = await pool.query(
        "SELECT * FROM templates WHERE project_id = ? AND status LIKE ? AND is_deleted = ? ORDER BY id DESC LIMIT ? OFFSET ?",
        [project_id, `%${status}%`, "0", limit, offset]
    );

    const res_data = rows.map((element) => ({
        template_id: element.template_id,
        waba_template_id: element.waba_template_id,
        category: element.category,
        create_date: element.create_date,
        template_name: element.template_name,
        status: element.status,
        reject_reason: element.reject_reason,
        template: loadTemplateJson(element.template_id),
    }));

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

    return res.status(200).json({
        data: {
            template_id: data?.template_id,
            waba_template_id: data?.waba_template_id,
            template_name: data?.template_name,
            status: data?.status,
            category: data?.category,
            create_date: data?.create_date,
            project_id,
            reject_reason: data?.reject_reason,
        },
        template: loadTemplateJson(data?.template_id),
    });
});

export default router;