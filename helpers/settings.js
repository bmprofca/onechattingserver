import pool from "../db.js";

function timestamp() {
    return new Date().toISOString().slice(0, 19).replace("T", " ");
}

let settingsReadyPromise = null;

export const WEBSITE_SETTING_GROUP = "website";

export function ensureSettingsTable() {
    if (!settingsReadyPromise) {
        settingsReadyPromise = setupSettingsTable().catch((error) => {
            settingsReadyPromise = null;
            throw error;
        });
    }
    return settingsReadyPromise;
}

async function setupSettingsTable() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
            id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
            setting_group VARCHAR(80) NOT NULL DEFAULT 'general',
            setting_key VARCHAR(120) NOT NULL,
            setting_value LONGTEXT NULL,
            label VARCHAR(255) NULL,
            value_type VARCHAR(30) NOT NULL DEFAULT 'text',
            is_public TINYINT(1) NOT NULL DEFAULT 0,
            sort_order INT NOT NULL DEFAULT 0,
            updated_at DATETIME NULL,
            UNIQUE KEY settings_group_key (setting_group, setting_key)
        )
    `);
}

const mapSetting = (row) => ({
    id: row.id,
    setting_group: row.setting_group,
    setting_key: row.setting_key,
    setting_value: row.setting_value ?? "",
    label: row.label || row.setting_key,
    value_type: row.value_type || "text",
    is_public: row.is_public == 1 || row.is_public === true,
    sort_order: Number(row.sort_order) || 0,
    updated_at: row.updated_at,
});

export function normalizeSettingToken(value, fallback = "") {
    const token = String(value || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 120);
    return token || fallback;
}

export async function listSettings({ group } = {}) {
    await ensureSettingsTable();
    const params = [];
    let where = "";
    if (group) {
        where = "WHERE setting_group = ?";
        params.push(group);
    }
    const [rows] = await pool.query(
        `SELECT * FROM settings ${where} ORDER BY setting_group ASC, sort_order ASC, setting_key ASC`,
        params
    );
    return rows.map(mapSetting);
}

export async function getSettingsMap(group, { publicOnly = false } = {}) {
    const rows = await listSettings({ group });
    const map = {};
    for (const row of rows) {
        if (publicOnly && !row.is_public) continue;
        map[row.setting_key] = row.setting_value;
    }
    return map;
}

export async function upsertSetting(payload, id = null) {
    await ensureSettingsTable();
    const settingGroup = normalizeSettingToken(payload.setting_group, "general");
    const settingKey = normalizeSettingToken(payload.setting_key);
    if (!settingKey) {
        return { error: "A valid setting key is required" };
    }

    const valueType = ["text", "textarea", "number", "boolean", "secret"].includes(payload.value_type)
        ? payload.value_type
        : "text";
    const values = [
        settingGroup,
        settingKey,
        payload.setting_value == null ? "" : String(payload.setting_value),
        String(payload.label || settingKey).trim().slice(0, 255),
        valueType,
        payload.is_public === true || payload.is_public === 1 || payload.is_public === "1" ? 1 : 0,
        Number.parseInt(payload.sort_order, 10) || 0,
        timestamp(),
    ];

    if (id) {
        const [dup] = await pool.query(
            "SELECT id FROM settings WHERE setting_group = ? AND setting_key = ? AND id <> ? LIMIT 1",
            [settingGroup, settingKey, id]
        );
        if (dup.length) return { error: "Another setting already uses this group and key" };

        const [result] = await pool.query(
            `UPDATE settings
             SET setting_group = ?, setting_key = ?, setting_value = ?, label = ?,
                 value_type = ?, is_public = ?, sort_order = ?, updated_at = ?
             WHERE id = ?`,
            [...values, id]
        );
        if (!result.affectedRows) return { error: "Setting not found" };
        return getSettingById(id);
    }

    await pool.query(
        `INSERT INTO settings
            (setting_group, setting_key, setting_value, label, value_type, is_public, sort_order, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
            setting_value = VALUES(setting_value),
            label = VALUES(label),
            value_type = VALUES(value_type),
            is_public = VALUES(is_public),
            sort_order = VALUES(sort_order),
            updated_at = VALUES(updated_at)`,
        values
    );

    const [rows] = await pool.query(
        "SELECT * FROM settings WHERE setting_group = ? AND setting_key = ? LIMIT 1",
        [settingGroup, settingKey]
    );
    return rows.length ? mapSetting(rows[0]) : null;
}

async function getSettingById(id) {
    const [rows] = await pool.query("SELECT * FROM settings WHERE id = ? LIMIT 1", [id]);
    return rows.length ? mapSetting(rows[0]) : null;
}

export async function deleteSetting(id) {
    await ensureSettingsTable();
    await pool.query("DELETE FROM settings WHERE id = ?", [id]);
}
