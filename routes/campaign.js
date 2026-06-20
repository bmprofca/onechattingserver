import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AISENSY_PROJECT_DATA, USER_DATA } from "../helpers/function.js";
import pool from "../db.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { processInBackgroundExcel, processInBackgroundContacts, processInBackgroundGroups } from "../helpers/campaign/excel.js";
import { validateScheduleDate, validateTemplate, insertCampaign } from "../helpers/campaign/createHelper.js";
import { InitiateCampaignMessages } from "../helpers/campaign/sendMessage.js";
import { RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

const errorDir = path.join(__dirname, "../media/error");
if (!fs.existsSync(errorDir)) {
    fs.mkdirSync(errorDir, { recursive: true });
}

router.post("/create/excel", auth, async (req, res) => {
    try {
        let data = req.body?.data || "";
        let key = req.body?.key || "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body.data || "";
            key = req.body.key || "";
        }

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = (req.headers["username"] || "").toString().trim();
        const url = (decrypt?.url ?? "").toString().trim();
        const phone_index = parseInt(decrypt?.phone_index, 10);
        const start_row = parseInt(decrypt?.start_row, 10);
        const end_row = parseInt(decrypt?.end_row, 10);
        const component = decrypt?.component;
        const name = (decrypt?.name ?? "").toString().trim();
        const template_id = (decrypt?.template_id ?? "").toString().trim();
        const project_id = (decrypt?.project_id ?? "").toString().trim();
        const source = (decrypt?.source ?? "").toString().toLowerCase();
        const schedule_date = decrypt?.schedule_date || null;

        if (!url || isNaN(phone_index) || isNaN(start_row) || isNaN(end_row) || !name || !template_id || !project_id || !source) {
            return res.status(200).json({ error: "Provide all mandatory fields: url, phone_index, start_row, end_row, component, name, template_id, project_id, source" });
        }
        if (source !== "excel" && source !== "sheet") {
            return res.status(200).json({ error: "source must be 'excel' or 'sheet'" });
        }
        if (!component || !Array.isArray(component)) {
            return res.status(200).json({ error: "component is required and must be an array" });
        }
        if (end_row < start_row) {
            return res.status(200).json({ error: "Invalid row range: end_row must be >= start_row" });
        }

        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: "User is not assigned on the project" });
        }

        let scheduleDateValue, isScheduled;
        try {
            const sched = validateScheduleDate(schedule_date);
            scheduleDateValue = sched.scheduleDateValue;
            isScheduled = sched.isScheduled;
        } catch (e) {
            return res.status(200).json({ error: e.message });
        }

        let template_name, language_code;
        try {
            const tpl = await validateTemplate(project_id, template_id);
            template_name = tpl.template_name;
            language_code = tpl.language_code;
        } catch (e) {
            return res.status(200).json({ error: e.message });
        }

        const campaignParams = JSON.stringify({ phone_index, start_row, end_row, component });
        const campaign_id = await insertCampaign({
            username, source, url, name, project_id, template_id, scheduleDateValue, campaignParams
        });

        processInBackgroundExcel({
            url, phone_index, start_row, end_row, component, campaign_id, username,
            template_id, template_name, language_code, project_id, isScheduled
        });

        if (isScheduled) {
            return res.status(200).json({ error: false, msg: "Campaign scheduled successfully", schedule_date: scheduleDateValue });
        }
        return res.status(200).json({ error: false, msg: "Campaign created successfully" });
    } catch (error) {
        return res.status(200).json({ error: "Failed to create campaign", e: error?.message || String(error) });
    }
});

router.post("/create/contact", auth, async (req, res) => {
    try {
        let data = req.body?.data || "";
        let key = req.body?.key || "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body.data || "";
            key = req.body.key || "";
        }

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = (req.headers["username"] || "").toString().trim();
        const is_select_all = !!decrypt?.is_select_all;
        const contact_ids = Array.isArray(decrypt?.contact_ids) ? decrypt.contact_ids : [];
        const numbers = Array.isArray(decrypt?.numbers) ? decrypt.numbers : [];
        const component = decrypt?.component;
        const name = (decrypt?.name ?? "").toString().trim();
        const template_id = (decrypt?.template_id ?? "").toString().trim();
        const project_id = (decrypt?.project_id ?? "").toString().trim();
        const schedule_date = decrypt?.schedule_date || null;

        if (!is_select_all && (!contact_ids || contact_ids.length === 0) && (!numbers || numbers.length === 0)) {
            return res.status(200).json({ error: "Provide contact_ids or numbers array (non-empty), or set is_select_all = true" });
        }
        if (!component || !Array.isArray(component) || !name || !template_id || !project_id) {
            return res.status(200).json({ error: "Provide all mandatory fields: component, name, template_id, project_id" });
        }

        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: "User is not assigned on the project" });
        }

        let scheduleDateValue, isScheduled;
        try {
            const sched = validateScheduleDate(schedule_date);
            scheduleDateValue = sched.scheduleDateValue;
            isScheduled = sched.isScheduled;
        } catch (e) {
            return res.status(200).json({ error: e.message });
        }

        let template_name, language_code;
        try {
            const tpl = await validateTemplate(project_id, template_id);
            template_name = tpl.template_name;
            language_code = tpl.language_code;
        } catch (e) {
            return res.status(200).json({ error: e.message });
        }

        // If is_select_all, fetch all contacts for this project and ignore payload arrays
        let final_contact_ids = contact_ids;
        let final_numbers = numbers;
        if (is_select_all) {
            const [allContacts] = await pool.query(
                "SELECT contact_id FROM contacts WHERE project_id = ? AND is_deleted = '0'",
                [project_id]
            );
            final_contact_ids = allContacts.map((c) => c.contact_id);
            final_numbers = [];
        }

        const campaignParams = JSON.stringify({ contact_ids: final_contact_ids, numbers: final_numbers, component, is_select_all });
        const campaign_id = await insertCampaign({
            username, source: "contact", url: null, name, project_id, template_id, scheduleDateValue, campaignParams
        });

        processInBackgroundContacts({
            contact_ids: final_contact_ids, numbers: final_numbers, component, campaign_id, username,
            template_id, template_name, language_code, project_id, isScheduled
        });

        if (isScheduled) {
            return res.status(200).json({ error: false, msg: "Campaign scheduled successfully", schedule_date: scheduleDateValue });
        }
        return res.status(200).json({ error: false, msg: "Campaign created successfully" });
    } catch (error) {
        return res.status(200).json({ error: "Failed to create campaign", e: error?.message || String(error) });
    }
});

router.post("/create/group", auth, async (req, res) => {
    try {
        let data = req.body?.data || "";
        let key = req.body?.key || "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body.data || "";
            key = req.body.key || "";
        }

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = (req.headers["username"] || "").toString().trim();
        const group_ids = Array.isArray(decrypt?.group_ids) ? decrypt.group_ids : [];
        const component = decrypt?.component;
        const name = (decrypt?.name ?? "").toString().trim();
        const template_id = (decrypt?.template_id ?? "").toString().trim();
        const project_id = (decrypt?.project_id ?? "").toString().trim();
        const schedule_date = decrypt?.schedule_date || null;

        if (!group_ids || group_ids.length === 0) {
            return res.status(200).json({ error: "Provide group_ids array (non-empty)" });
        }
        if (!component || !Array.isArray(component) || !name || !template_id || !project_id) {
            return res.status(200).json({ error: "Provide all mandatory fields: component, name, template_id, project_id" });
        }

        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: "User is not assigned on the project" });
        }

        let scheduleDateValue, isScheduled;
        try {
            const sched = validateScheduleDate(schedule_date);
            scheduleDateValue = sched.scheduleDateValue;
            isScheduled = sched.isScheduled;
        } catch (e) {
            return res.status(200).json({ error: e.message });
        }

        let template_name, language_code;
        try {
            const tpl = await validateTemplate(project_id, template_id);
            template_name = tpl.template_name;
            language_code = tpl.language_code;
        } catch (e) {
            return res.status(200).json({ error: e.message });
        }

        const campaignParams = JSON.stringify({ group_ids, component });
        const campaign_id = await insertCampaign({
            username, source: "group", url: null, name, project_id, template_id, scheduleDateValue, campaignParams
        });

        processInBackgroundGroups({
            group_ids, component, campaign_id, username,
            template_id, template_name, language_code, project_id, isScheduled
        });

        if (isScheduled) {
            return res.status(200).json({ error: false, msg: "Campaign scheduled successfully", schedule_date: scheduleDateValue });
        }
        return res.status(200).json({ error: false, msg: "Campaign created successfully" });
    } catch (error) {
        return res.status(200).json({ error: "Failed to create campaign", e: error?.message || String(error) });
    }
});

router.post("/duplicate", auth, async (req, res) => {
    try {
        let data = req.body?.data || "";
        let key = req.body?.key || "";
        if (req.body && Object.keys(req.body).length > 0) {
            data = req.body.data || "";
            key = req.body.key || "";
        }

        const decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = (req.headers["username"] || "").toString().trim();
        const campaign_id = (decrypt?.campaign_id ?? "").toString().trim();
        const name = (decrypt?.name ?? "").toString().trim();
        const schedule_date = decrypt?.schedule_date || null;

        if (!campaign_id || !name) {
            return res.status(200).json({ error: "Provide campaign_id and name" });
        }

        const [campaignRows] = await pool.query(
            "SELECT * FROM campaigns WHERE campaign_id = ? AND is_deleted = ?",
            [campaign_id, "0"]
        );
        if (campaignRows.length === 0) {
            return res.status(200).json({ error: "Campaign not found" });
        }

        const origCampaign = campaignRows[0];
        const project_id = origCampaign.project_id;

        const check_project_mapping = await CheckUserProjectMaping(username, project_id);
        if (!check_project_mapping) {
            return res.status(200).json({ error: "User is not assigned on the project" });
        }

        const [messages] = await pool.query(
            "SELECT * FROM campaign_messages WHERE campaign_id = ?",
            [campaign_id]
        );
        if (!messages || messages.length === 0) {
            return res.status(200).json({ error: "No campaign messages to duplicate" });
        }

        let scheduleDateValue, isScheduled;
        try {
            const sched = validateScheduleDate(schedule_date);
            scheduleDateValue = sched.scheduleDateValue;
            isScheduled = sched.isScheduled;
        } catch (e) {
            return res.status(200).json({ error: e.message });
        }

        const new_campaign_id = RANDOM_STRING(30);
        await pool.query(
            `INSERT INTO campaigns (
                campaign_id, create_date, create_by, modify_date, modify_by,
                entry_complete, source, url, has_error, status, name, project_id,
                template_id, schedule_date, params
            ) VALUES (?, ?, ?, ?, ?, '1', ?, ?, '0', '0', ?, ?, ?, ?, ?)`,
            [
                new_campaign_id,
                TIMESTAMP(),
                username,
                TIMESTAMP(),
                username,
                origCampaign.source || "contact",
                origCampaign.url || null,
                name,
                project_id,
                origCampaign.template_id,
                scheduleDateValue,
                origCampaign.params
            ]
        );

        for (const msg of messages) {
            const unique_id = RANDOM_STRING(30);
            await pool.query(
                `INSERT INTO campaign_messages (unique_id, campaign_id, number, create_date, create_by, template_id, template_name, language_code, component, project_id, status)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
                [
                    unique_id,
                    new_campaign_id,
                    msg.number,
                    TIMESTAMP(),
                    username,
                    msg.template_id,
                    msg.template_name,
                    msg.language_code,
                    msg.component,
                    project_id
                ]
            );
        }

        if (!isScheduled) {
            InitiateCampaignMessages({ campaign_id: new_campaign_id });
        }

        if (isScheduled) {
            return res.status(200).json({ error: false, msg: "Campaign duplicated and scheduled successfully", campaign_id: new_campaign_id, schedule_date: scheduleDateValue });
        }
        return res.status(200).json({ error: false, msg: "Campaign duplicated successfully", campaign_id: new_campaign_id });
    } catch (error) {
        return res.status(200).json({ error: "Failed to duplicate campaign", e: error?.message || String(error) });
    }
});

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
    const status = decrypt?.status || 'all';
    var page_no = Number(decrypt?.page_no) || 1;
    let limit = Number(decrypt?.limit) || 20;

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: "User is not assigned on the project" });
    }

    // Ensure limit doesn't exceed 100
    if (limit > 100) {
        limit = 100;
    }

    const offset = (page_no - 1) * limit;

    var status_string = `%%`;
    if (status == 'all') {
        status_string = `%%`;
    } else if (status == 'complete') {
        status_string = `%1%`;
    } else if (status == 'pending') {
        status_string = `%0%`;
    } else if (status == 'stopped') {
        status_string = `%2%`;
    }

    // Get total count for meta
    const [total_count_result] = await pool.query("SELECT COUNT(*) as total FROM `campaigns` WHERE project_id = ? AND status LIKE ? AND is_deleted = ?", [project_id, status_string, '0']);
    const total_records = total_count_result[0]?.total || 0;
    const total_pages = Math.ceil(total_records / limit);

    var [rows] = await pool.query("SELECT * FROM `campaigns` WHERE project_id = ? AND status LIKE ? AND is_deleted = ? ORDER BY id DESC LIMIT ? OFFSET ?", [project_id, status_string, '0', limit, offset]);

    const return_data = [];

    if (rows.length > 0) {
        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];

            var campaign_id = element?.campaign_id;
            var template_id = element?.template_id;
            var name = element?.name;
            var create_by = element?.create_by;
            var create_date = element?.create_date;
            var modify_by = element?.modify_by;
            var modify_date = element?.modify_date;
            var source = element?.source;
            var db_status = element?.status;
            var entry_complete = element?.entry_complete == '1' ? true : false;
            var schedule_date = element?.schedule_date;


            var res_status = 'pending';
            if (db_status == '0') {
                if (schedule_date) {
                    res_status = 'scheduled';
                } else {
                    res_status = 'pending';
                }
            } else if (db_status == '1') {
                res_status = 'complete';
            } else if (db_status == '2') {
                res_status = 'stopped';
            }

            const [template_row] = await pool.query("SELECT * FROM `templates` WHERE project_id = ? AND template_id = ?", [project_id, template_id]);
            const template_name = template_row[0]?.template_name;

            const creator_data = await USER_DATA(create_by);
            const modify_data = await USER_DATA(modify_by);

            var object = {
                campaign_id,
                name,
                create_by: {
                    name: creator_data?.name,
                    mobile: creator_data?.mobile,
                    email: creator_data?.email,
                    username: creator_data?.username,
                    status: creator_data?.status == '1' ? true : false,
                },
                create_date,
                modify_by: {
                    name: modify_data?.name,
                    mobile: modify_data?.mobile,
                    email: modify_data?.email,
                    username: modify_data?.username,
                    status: modify_data?.status == '1' ? true : false,
                },
                modify_date,
                entry_complete,
                source,
                status: res_status,
                template: {
                    template_id,
                    template_name
                }
            };

            if (res_status == 'scheduled') {
                object.schedule_date = schedule_date;
            }

            if (entry_complete) {
                const [recipients] = await pool.query(`
                    SELECT 
                        COUNT(*) AS total,
                        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
                        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
                        SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) AS \`read\`,
                        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
                    FROM campaign_messages
                    WHERE project_id = ? AND campaign_id = ?
                    `, [project_id, campaign_id]);


                object.recipients = {
                    total: Number(recipients[0]?.total),
                    pending: Number(recipients[0]?.pending),
                    sent: Number(recipients[0]?.sent) + Number(recipients[0]?.delivered) + Number(recipients[0]?.read),
                    delivered: Number(recipients[0]?.delivered) + Number(recipients[0]?.read),
                    read: Number(recipients[0]?.read),
                    failed: Number(recipients[0]?.failed),
                }
            }


            if (source == 'excel' || source == 'sheets') {
                var has_error = element?.has_error == '1' ? true : false;
                var url = element?.url;

                object.url = url;
                object.has_error = has_error;
                if (has_error) {
                    var error_file = `${BASE_DOMAIN}/error/${element?.error_file}`;
                    object.error_file = error_file;
                }
            } else if (source == 'group') {
                const group_id = element?.group_id;
                object.group_id = group_id;
            }


            if (status == 'failed') {
                object.failed_reason = failed_reason;
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
            has_more: page_no < total_pages
        }
    });
});

router.post("/campaign-messages", auth, async (req, res) => {
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
    const campaign_id = decrypt?.campaign_id;
    var status = decrypt?.status || 'all';

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: "User is not assigned on the project" });
    }
    var page_no = Number(decrypt?.page_no) || 1;
    let limit = Number(decrypt?.limit) || 20;

    // Ensure limit doesn't exceed 100
    if (limit > 100) {
        limit = 100;
    }

    if (status == 'all') {
        var status = '';
    }

    const status_like = `%${status}%`;
    const offset = (page_no - 1) * limit;

    // Get total count for meta
    const [total_count_result] = await pool.query("SELECT COUNT(*) as total FROM `campaign_messages` WHERE project_id = ? AND status LIKE ? AND campaign_id = ?", [project_id, status_like, campaign_id]);
    const total_records = total_count_result[0]?.total || 0;
    const total_pages = Math.ceil(total_records / limit);

    var [rows] = await pool.query("SELECT * FROM `campaign_messages` WHERE project_id = ? AND status LIKE ? AND campaign_id = ? ORDER BY id DESC LIMIT ? OFFSET ?", [project_id, status_like, campaign_id, limit, offset]);


    const return_data = [];

    if (rows.length > 0) {
        for (let index = 0; index < rows.length; index++) {
            const element = rows[index];

            var unique_id = element?.unique_id;
            var number = element?.number;
            var create_date = element?.create_date;
            var create_by = element?.create_by;
            var template_id = element?.template_id;
            var template_name = element?.template_name;
            var component = JSON.parse(element?.component);
            var wamid = element?.wamid;
            var send_date = element?.send_date;
            var status = element?.status;
            var failed_reason = element?.failed_reason;

            const creator_data = await USER_DATA(create_by);

            var object = {
                unique_id,
                number,
                template_id,
                template_name,
                component,
                wamid,
                send_date,
                create_by: {
                    name: creator_data?.name,
                    mobile: creator_data?.mobile,
                    email: creator_data?.email,
                    username: creator_data?.username,
                    status: creator_data?.status == '1' ? true : false,
                },
                create_date,
                status
            };

            if (status == 'failed') {
                object.failed_reason = failed_reason;
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
            has_more: page_no < total_pages
        }
    });
});

router.post("/campaign-details", auth, async (req, res) => {
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
    const campaign_id = decrypt?.campaign_id;

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: "User is not assigned on the project" });
    }

    const project_data = await AISENSY_PROJECT_DATA(project_id);
    const marketing_charge = project_data?.marketing_charge;
    const utility_charge = project_data?.utility_charge;
    const authentication_charge = project_data?.authentication_charge;

    var [row] = await pool.query("SELECT * FROM `campaigns` WHERE project_id = ? AND campaign_id = ?", [project_id, campaign_id]);

    if (row.length == 0) {
        return res.status(200).json({
            error: 'Invalid campaign id'
        });
    }

    const element = row[0];
    const name = element?.name;
    const create_date = element?.create_date;
    const create_by = element?.create_by;
    const modify_date = element?.modify_date;
    const modify_by = element?.modify_by;
    var status = element?.status;
    const entry_complete = element?.entry_complete == '1' ? true : false;
    const source = element?.source;

    const template_id = element?.template_id;

    if (status == '0') {
        status = 'pending';
    } else if (status == '1') {
        status = 'complete';
    } else if (status == '2') {
        status = 'stopped';
    }

    const [template_row] = await pool.query("SELECT * FROM `templates` WHERE project_id = ? AND template_id = ?", [project_id, template_id]);
    const template_name = template_row[0]?.template_name;
    const category = template_row[0]?.category || '';
    const language_code = template_row[0]?.language_code || '';

    const creator_data = await USER_DATA(create_by);
    const modify_data = await USER_DATA(modify_by);


    const object = {
        campaign_id,
        name,
        create_date,
        modify_date,
        status,
        entry_complete,
        source,
        create_by: {
            name: creator_data?.name,
            mobile: creator_data?.mobile,
            email: creator_data?.email,
            username: creator_data?.username,
            status: creator_data?.status == '1' ? true : false,
        },
        modify_by: {
            name: modify_data?.name,
            mobile: modify_data?.mobile,
            email: modify_data?.email,
            username: modify_data?.username,
            status: modify_data?.status == '1' ? true : false,
        },
        template: {
            template_id,
            template_name,
            category,
            language_code
        },
    };

    if (source == 'excel' || source == 'sheets') {
        var has_error = element?.has_error == '1' ? true : false;
        var url = element?.url;

        object.url = url;
        object.has_error = has_error;
        if (has_error) {
            var error_file = `${BASE_DOMAIN}/error/${element?.error_file}`;
            object.error_file = error_file;
        }
    } else if (source == 'group') {
        const group_id = element?.group_id;
        object.group_id = group_id;
    }



    const [recipients] = await pool.query(`
                    SELECT 
                        COUNT(*) AS total,
                        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
                        SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sent,
                        SUM(CASE WHEN status = 'delivered' THEN 1 ELSE 0 END) AS delivered,
                        SUM(CASE WHEN status = 'read' THEN 1 ELSE 0 END) AS \`read\`,
                        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
                    FROM campaign_messages
                    WHERE project_id = ? AND campaign_id = ?
                    `, [project_id, campaign_id]);
    object.recipients = {
        total: Number(recipients[0]?.total),
        pending: Number(recipients[0]?.pending),
        sent: Number(recipients[0]?.sent) + Number(recipients[0]?.delivered) + Number(recipients[0]?.read),
        delivered: Number(recipients[0]?.delivered) + Number(recipients[0]?.read),
        read: Number(recipients[0]?.read),
        failed: Number(recipients[0]?.failed),
    }
    let per_message_cost = 0;
    if (category == 'MARKETING') {
        per_message_cost = marketing_charge;
    } else if (category == 'UTILITY') {
        per_message_cost = utility_charge;
    } else if (category == 'AUTHENTICATION') {
        per_message_cost = authentication_charge;
    }

    object.cost = {
        total: Number(object.recipients.total) * Number(per_message_cost),
        per_message: Number(per_message_cost),
        used: Number(object.recipients.delivered) * Number(per_message_cost)
    }


    return res.status(200).json({
        error: false,
        data: object,
        msg: 'Campaign data fetched successfully'
    });
});

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
    const campaign_id = decrypt?.campaign_id;

    if (!project_id || !campaign_id) {
        return res.status(200).json({ error: 'project_id and campaign_id are required' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: "User is not assigned on the project" });
    }

    try {
        // Check if campaign exists and if it's already deleted
        const [campaign] = await pool.query(
            "SELECT `is_deleted` FROM `campaigns` WHERE `project_id` = ? AND `campaign_id` = ?",
            [project_id, campaign_id]
        );

        if (campaign.length === 0) {
            return res.status(200).json({
                error: 'Campaign not found'
            });
        }

        if (campaign[0].is_deleted === '1') {
            return res.status(200).json({
                error: 'Campaign is already deleted'
            });
        }

        // Update is_deleted and deleted_by
        const [result] = await pool.query(
            "UPDATE `campaigns` SET `is_deleted` = ?, `deleted_by` = ? WHERE `project_id` = ? AND `campaign_id` = ?",
            ['1', username, project_id, campaign_id]
        );

        if (result.affectedRows === 0) {
            return res.status(200).json({
                error: 'Failed to delete campaign'
            });
        }

        return res.status(200).json({
            error: false,
            msg: 'Campaign deleted successfully'
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to delete campaign',
            e: error.message || error
        });
    }
});

export default router;