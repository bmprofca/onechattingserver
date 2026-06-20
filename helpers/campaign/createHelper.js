import pool from "../../db.js";
import { RANDOM_STRING, TIMESTAMP } from "../function.js";

const SCHEDULE_DATE_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

/**
 * Validate schedule_date. Returns { scheduleDateValue, isScheduled } or throws.
 * schedule_date format: YYYY-MM-DD HH:mm:ss (IST)
 */
export function validateScheduleDate(schedule_date) {
    if (!schedule_date) {
        return { scheduleDateValue: null, isScheduled: false };
    }

    if (!SCHEDULE_DATE_REGEX.test(schedule_date)) {
        throw new Error("schedule_date must be in format YYYY-MM-DD HH:mm:ss");
    }

    const parsedDate = new Date(schedule_date.replace(" ", "T") + "+05:30");
    if (isNaN(parsedDate.getTime())) {
        throw new Error("Invalid schedule_date");
    }

    if (parsedDate.getTime() <= Date.now()) {
        throw new Error("Past time not allowed");
    }

    return { scheduleDateValue: schedule_date, isScheduled: true };
}

/**
 * Validate template exists and is APPROVED. Returns { template_name, language_code }.
 */
export async function validateTemplate(project_id, template_id) {
    const [rows] = await pool.query(
        "SELECT template_name, language_code FROM templates WHERE template_id = ? AND project_id = ? AND status = ?",
        [template_id, project_id, "APPROVED"]
    );

    if (!rows || rows.length === 0) {
        throw new Error("Invalid template id or template not approved");
    }

    return { template_name: rows[0].template_name, language_code: rows[0].language_code };
}

/**
 * Insert campaign row. Returns campaign_id.
 */
export async function insertCampaign({ username, source, url, name, project_id, template_id, scheduleDateValue, campaignParams }) {
    const campaign_id = RANDOM_STRING(30);
    await pool.query(
        `INSERT INTO campaigns (
            campaign_id, create_date, create_by, modify_date, modify_by,
            entry_complete, source, url, has_error, status, name, project_id,
            template_id, schedule_date, params
        ) VALUES (?, ?, ?, ?, ?, '0', ?, ?, '0', '0', ?, ?, ?, ?, ?)`,
        [
            campaign_id,
            TIMESTAMP(),
            username,
            TIMESTAMP(),
            username,
            source,
            url || null,
            name,
            project_id,
            template_id,
            scheduleDateValue,
            campaignParams
        ]
    );
    return campaign_id;
}
