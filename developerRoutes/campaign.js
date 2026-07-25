import express from "express";
import pool from "../db.js";
import { developerSendMessageAuth } from "../middleware/developerAuth.js";
import { AISENSY_PROJECT_DATA, USER_DATA_MAP, auditUserRecord } from "../helpers/function.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import { processInBackgroundContacts } from "../helpers/campaign/excel.js";
import { validateScheduleDate, validateTemplate, insertCampaign } from "../helpers/campaign/createHelper.js";

const router = express.Router();

const MAX_NUMBERS_PER_REQUEST = 10000;

function resolveProjectContext(req, res) {
    const project_id = req.developerMapping?.project_id;
    const username = req.developerMapping?.username;

    if (!project_id || !username) {
        res.status(200).json({ error: "Invalid or missing token" });
        return null;
    }

    return { project_id, username };
}

function normalizeNumbers(input) {
    if (!Array.isArray(input)) return [];
    const seen = new Set();
    const result = [];
    for (const value of input) {
        const number = String(value ?? "").trim().replace(/\D/g, "");
        if (!number || seen.has(number)) continue;
        seen.add(number);
        result.push(number);
    }
    return result;
}

function mapCampaignStatus(dbStatus, scheduleDate) {
    if (dbStatus == "0") {
        return scheduleDate ? "scheduled" : "pending";
    }
    if (dbStatus == "1") return "complete";
    if (dbStatus == "2") return "stopped";
    return "pending";
}

/**
 * POST /developer/campaign/create
 * Create a campaign from phone numbers only (optional schedule).
 */
router.post("/create", developerSendMessageAuth, async (req, res) => {
    try {
        const ctx = resolveProjectContext(req, res);
        if (!ctx) return;

        const { project_id, username } = ctx;
        const numbers = normalizeNumbers(req.body?.numbers);
        const component = req.body?.component;
        const name = (req.body?.name ?? "").toString().trim();
        const template_id = (req.body?.template_id ?? "").toString().trim();
        const schedule_date = req.body?.schedule_date || null;

        if (!numbers.length) {
            return res.status(200).json({ error: "Provide numbers array (non-empty)" });
        }
        if (numbers.length > MAX_NUMBERS_PER_REQUEST) {
            return res.status(200).json({
                error: `Maximum ${MAX_NUMBERS_PER_REQUEST} numbers allowed per request`,
            });
        }
        if (!component || !Array.isArray(component)) {
            return res.status(200).json({ error: "component is required and must be an array" });
        }
        if (!name || !template_id) {
            return res.status(200).json({ error: "Provide all mandatory fields: name, template_id, component, numbers" });
        }

        let scheduleDateValue;
        let isScheduled;
        try {
            const sched = validateScheduleDate(schedule_date);
            scheduleDateValue = sched.scheduleDateValue;
            isScheduled = sched.isScheduled;
        } catch (e) {
            return res.status(200).json({ error: e.message });
        }

        let template_name;
        let language_code;
        try {
            const tpl = await validateTemplate(project_id, template_id);
            template_name = tpl.template_name;
            language_code = tpl.language_code;
        } catch (e) {
            return res.status(200).json({ error: e.message });
        }

        const campaignParams = JSON.stringify({
            contact_ids: [],
            numbers,
            component,
            is_select_all: false,
        });

        const campaign_id = await insertCampaign({
            username,
            source: "contact",
            url: null,
            name,
            project_id,
            template_id,
            scheduleDateValue,
            campaignParams,
        });

        processInBackgroundContacts({
            contact_ids: [],
            numbers,
            component,
            campaign_id,
            username,
            template_id,
            template_name,
            language_code,
            project_id,
            isScheduled,
        });

        if (isScheduled) {
            return res.status(200).json({
                error: false,
                msg: "Campaign scheduled successfully",
                campaign_id,
                schedule_date: scheduleDateValue,
                total_numbers: numbers.length,
            });
        }

        return res.status(200).json({
            error: false,
            msg: "Campaign created successfully",
            campaign_id,
            total_numbers: numbers.length,
        });
    } catch (error) {
        return res.status(200).json({
            error: "Failed to create campaign",
            e: error?.message || String(error),
        });
    }
});

/**
 * GET /developer/campaign/list
 */
router.get("/list", developerSendMessageAuth, async (req, res) => {
    try {
        const ctx = resolveProjectContext(req, res);
        if (!ctx) return;

        const { project_id } = ctx;
        const status = (req.query?.status || "all").toString();
        let page_no = Number(req.query?.page_no) || 1;
        let limit = Number(req.query?.limit) || 20;

        if (limit > 100) limit = 100;
        if (page_no < 1) page_no = 1;

        const offset = (page_no - 1) * limit;

        let status_string = "%%";
        if (status === "complete") status_string = "%1%";
        else if (status === "pending") status_string = "%0%";
        else if (status === "stopped") status_string = "%2%";

        const [total_count_result] = await pool.query(
            "SELECT COUNT(*) as total FROM `campaigns` WHERE project_id = ? AND status LIKE ? AND is_deleted = ?",
            [project_id, status_string, "0"]
        );
        const total_records = total_count_result[0]?.total || 0;
        const total_pages = Math.ceil(total_records / limit) || 0;

        const [rows] = await pool.query(
            "SELECT * FROM `campaigns` WHERE project_id = ? AND status LIKE ? AND is_deleted = ? ORDER BY id DESC LIMIT ? OFFSET ?",
            [project_id, status_string, "0", limit, offset]
        );

        const return_data = [];

        if (rows.length > 0) {
            const templateIds = [...new Set(rows.map((element) => element.template_id).filter(Boolean))];
            const auditUsernames = rows.flatMap((element) => [element.create_by, element.modify_by]);
            const userMap = await USER_DATA_MAP(auditUsernames);

            let templateMap = new Map();
            if (templateIds.length > 0) {
                const [templateRows] = await pool.query(
                    "SELECT template_id, template_name FROM templates WHERE project_id = ? AND template_id IN (?)",
                    [project_id, templateIds]
                );
                templateMap = new Map(templateRows.map((item) => [item.template_id, item.template_name]));
            }

            const completeCampaignIds = rows
                .filter((element) => element.entry_complete == "1")
                .map((element) => element.campaign_id);

            let recipientStatsMap = new Map();
            if (completeCampaignIds.length > 0) {
                const [recipientRows] = await pool.query(
                    `
                    SELECT campaign_id,
                        COUNT(*) AS total,
                        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
                        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
                        SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) AS \`read\`,
                        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
                    FROM campaign_messages
                    WHERE project_id = ? AND campaign_id IN (?)
                    GROUP BY campaign_id
                `,
                    [project_id, completeCampaignIds]
                );
                recipientStatsMap = new Map(recipientRows.map((item) => [item.campaign_id, item]));
            }

            for (const element of rows) {
                const campaign_id = element?.campaign_id;
                const template_id = element?.template_id;
                const schedule_date = element?.schedule_date;
                const entry_complete = element?.entry_complete == "1";
                const source = element?.source;
                const res_status = mapCampaignStatus(element?.status, schedule_date);

                const object = {
                    campaign_id,
                    name: element?.name,
                    create_by: auditUserRecord(userMap.get(element?.create_by) || {}, { includeUsername: true }),
                    create_date: element?.create_date,
                    modify_by: auditUserRecord(userMap.get(element?.modify_by) || {}, { includeUsername: true }),
                    modify_date: element?.modify_date,
                    entry_complete,
                    source,
                    status: res_status,
                    template: {
                        template_id,
                        template_name: templateMap.get(template_id) || null,
                    },
                };

                if (res_status === "scheduled") {
                    object.schedule_date = schedule_date;
                }

                if (entry_complete) {
                    const recipients = recipientStatsMap.get(campaign_id) || {};
                    object.recipients = {
                        total: Number(recipients?.total || 0),
                        pending: Number(recipients?.pending || 0),
                        sent:
                            Number(recipients?.sent || 0) +
                            Number(recipients?.delivered || 0) +
                            Number(recipients?.read || 0),
                        delivered: Number(recipients?.delivered || 0) + Number(recipients?.read || 0),
                        read: Number(recipients?.read || 0),
                        failed: Number(recipients?.failed || 0),
                    };
                }

                if (source === "excel" || source === "sheets" || source === "sheet") {
                    const has_error = element?.has_error == "1";
                    object.url = element?.url;
                    object.has_error = has_error;
                    if (has_error) {
                        object.error_file = `${BASE_DOMAIN}/error/${element?.error_file}`;
                    }
                } else if (source === "group") {
                    object.group_id = element?.group_id;
                }

                return_data.push(object);
            }
        }

        return res.status(200).json({
            data: return_data,
            count: return_data.length,
            meta: {
                page_no,
                limit,
                total_records,
                total_pages,
                has_more: page_no < total_pages,
            },
        });
    } catch (error) {
        return res.status(200).json({
            error: "Failed to fetch campaign list",
            e: error?.message || String(error),
        });
    }
});

/**
 * GET /developer/campaign/messages
 */
router.get("/messages", developerSendMessageAuth, async (req, res) => {
    try {
        const ctx = resolveProjectContext(req, res);
        if (!ctx) return;

        const { project_id } = ctx;
        const campaign_id = (req.query?.campaign_id || "").toString().trim();
        let status = (req.query?.status || "all").toString();
        let page_no = Number(req.query?.page_no) || 1;
        let limit = Number(req.query?.limit) || 20;

        if (!campaign_id) {
            return res.status(200).json({ error: "Provide campaign_id" });
        }

        if (limit > 100) limit = 100;
        if (page_no < 1) page_no = 1;

        if (status === "all") status = "";

        const status_like = `%${status}%`;
        const offset = (page_no - 1) * limit;

        const [total_count_result] = await pool.query(
            "SELECT COUNT(*) as total FROM `campaign_messages` WHERE project_id = ? AND status LIKE ? AND campaign_id = ?",
            [project_id, status_like, campaign_id]
        );
        const total_records = total_count_result[0]?.total || 0;
        const total_pages = Math.ceil(total_records / limit) || 0;

        const [rows] = await pool.query(
            "SELECT * FROM `campaign_messages` WHERE project_id = ? AND status LIKE ? AND campaign_id = ? ORDER BY id DESC LIMIT ? OFFSET ?",
            [project_id, status_like, campaign_id, limit, offset]
        );

        const creatorUsernames = rows.map((element) => element?.create_by);
        const userMap = await USER_DATA_MAP(creatorUsernames);

        const return_data = rows.map((element) => {
            let component = [];
            try {
                component = JSON.parse(element?.component || "[]");
            } catch {
                component = [];
            }

            const object = {
                unique_id: element?.unique_id,
                number: element?.number,
                template_id: element?.template_id,
                template_name: element?.template_name,
                component,
                wamid: element?.wamid,
                send_date: element?.send_date,
                create_by: auditUserRecord(userMap.get(element?.create_by) || {}, { includeUsername: true }),
                create_date: element?.create_date,
                status: element?.status,
            };

            if (element?.status === "failed") {
                object.failed_reason = element?.failed_reason;
            }

            return object;
        });

        return res.status(200).json({
            data: return_data,
            count: return_data.length,
            meta: {
                page_no,
                limit,
                total_records,
                total_pages,
                has_more: page_no < total_pages,
            },
        });
    } catch (error) {
        return res.status(200).json({
            error: "Failed to fetch campaign messages",
            e: error?.message || String(error),
        });
    }
});

/**
 * GET /developer/campaign/details
 */
router.get("/details", developerSendMessageAuth, async (req, res) => {
    try {
        const ctx = resolveProjectContext(req, res);
        if (!ctx) return;

        const { project_id } = ctx;
        const campaign_id = (req.query?.campaign_id || "").toString().trim();

        if (!campaign_id) {
            return res.status(200).json({ error: "Provide campaign_id" });
        }

        const project_data = await AISENSY_PROJECT_DATA(project_id);
        const marketing_charge = project_data?.marketing_charge;
        const utility_charge = project_data?.utility_charge;
        const authentication_charge = project_data?.authentication_charge;

        const [row] = await pool.query(
            "SELECT * FROM `campaigns` WHERE project_id = ? AND campaign_id = ? AND is_deleted = ?",
            [project_id, campaign_id, "0"]
        );

        if (row.length === 0) {
            return res.status(200).json({ error: "Invalid campaign id" });
        }

        const element = row[0];
        const schedule_date = element?.schedule_date;
        let status = mapCampaignStatus(element?.status, schedule_date);
        // details endpoint historically maps pending/complete/stopped without "scheduled"
        if (element?.status == "0") status = schedule_date ? "scheduled" : "pending";
        else if (element?.status == "1") status = "complete";
        else if (element?.status == "2") status = "stopped";

        const template_id = element?.template_id;
        const [template_row] = await pool.query(
            "SELECT template_name, category, language_code FROM `templates` WHERE project_id = ? AND template_id = ? LIMIT 1",
            [project_id, template_id]
        );
        const template_name = template_row[0]?.template_name;
        const category = template_row[0]?.category || "";
        const language_code = template_row[0]?.language_code || "";

        const userMap = await USER_DATA_MAP([element?.create_by, element?.modify_by]);

        const object = {
            campaign_id,
            name: element?.name,
            create_date: element?.create_date,
            modify_date: element?.modify_date,
            status,
            entry_complete: element?.entry_complete == "1",
            source: element?.source,
            create_by: auditUserRecord(userMap.get(element?.create_by) || {}, { includeUsername: true }),
            modify_by: auditUserRecord(userMap.get(element?.modify_by) || {}, { includeUsername: true }),
            template: {
                template_id,
                template_name,
                category,
                language_code,
            },
        };

        if (status === "scheduled") {
            object.schedule_date = schedule_date;
        }

        if (element?.source === "excel" || element?.source === "sheets" || element?.source === "sheet") {
            const has_error = element?.has_error == "1";
            object.url = element?.url;
            object.has_error = has_error;
            if (has_error) {
                object.error_file = `${BASE_DOMAIN}/error/${element?.error_file}`;
            }
        } else if (element?.source === "group") {
            object.group_id = element?.group_id;
        }

        const [recipients] = await pool.query(
            `
            SELECT
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
                SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
                SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) AS \`read\`,
                SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
            FROM campaign_messages
            WHERE project_id = ? AND campaign_id = ?
        `,
            [project_id, campaign_id]
        );

        object.recipients = {
            total: Number(recipients[0]?.total || 0),
            pending: Number(recipients[0]?.pending || 0),
            sent:
                Number(recipients[0]?.sent || 0) +
                Number(recipients[0]?.delivered || 0) +
                Number(recipients[0]?.read || 0),
            delivered: Number(recipients[0]?.delivered || 0) + Number(recipients[0]?.read || 0),
            read: Number(recipients[0]?.read || 0),
            failed: Number(recipients[0]?.failed || 0),
        };

        let per_message_cost = 0;
        if (category === "MARKETING") per_message_cost = marketing_charge;
        else if (category === "UTILITY") per_message_cost = utility_charge;
        else if (category === "AUTHENTICATION") per_message_cost = authentication_charge;

        object.cost = {
            total: Number(object.recipients.total) * Number(per_message_cost || 0),
            per_message: Number(per_message_cost || 0),
            used: Number(object.recipients.delivered) * Number(per_message_cost || 0),
        };

        return res.status(200).json({
            error: false,
            data: object,
            msg: "Campaign data fetched successfully",
        });
    } catch (error) {
        return res.status(200).json({
            error: "Failed to fetch campaign details",
            e: error?.message || String(error),
        });
    }
});

/**
 * POST /developer/campaign/delete
 * Soft-delete a campaign (same rules as portal).
 */
router.post("/delete", developerSendMessageAuth, async (req, res) => {
    try {
        const ctx = resolveProjectContext(req, res);
        if (!ctx) return;

        const { project_id, username } = ctx;
        const campaign_id = (req.body?.campaign_id || "").toString().trim();

        if (!campaign_id) {
            return res.status(200).json({ error: "campaign_id is required" });
        }

        const [campaign] = await pool.query(
            "SELECT `is_deleted` FROM `campaigns` WHERE `project_id` = ? AND `campaign_id` = ?",
            [project_id, campaign_id]
        );

        if (campaign.length === 0) {
            return res.status(200).json({ error: "Campaign not found" });
        }

        if (campaign[0].is_deleted === "1") {
            return res.status(200).json({ error: "Campaign is already deleted" });
        }

        const [result] = await pool.query(
            "UPDATE `campaigns` SET `is_deleted` = ?, `deleted_by` = ? WHERE `project_id` = ? AND `campaign_id` = ?",
            ["1", username, project_id, campaign_id]
        );

        if (result.affectedRows === 0) {
            return res.status(200).json({ error: "Failed to delete campaign" });
        }

        return res.status(200).json({
            error: false,
            msg: "Campaign deleted successfully",
        });
    } catch (error) {
        return res.status(200).json({
            error: "Failed to delete campaign",
            e: error?.message || error,
        });
    }
});

export default router;
