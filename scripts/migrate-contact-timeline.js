import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../db.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(scriptDir, "../migrations/20261109_add_contact_timeline_tag_audit.sql");
const auditedTables = ["contact_tag_mapping", "conversation_label_mapping"];
const auditColumns = ["deleted_date", "deleted_by"];

try {
    const [existingColumns] = await pool.query(
        `SELECT TABLE_NAME, COLUMN_NAME
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE()
           AND TABLE_NAME IN (?, ?)
           AND COLUMN_NAME IN (?, ?)`,
        [...auditedTables, ...auditColumns]
    );
    const existing = new Set(existingColumns.map((column) => `${column.TABLE_NAME}.${column.COLUMN_NAME}`));
    const migration = (await fs.readFile(migrationPath, "utf8"))
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);

    for (const table of auditedTables) {
        const missing = auditColumns.filter((column) => !existing.has(`${table}.${column}`));
        if (!missing.length) continue;
        const statement = migration.find((item) => new RegExp(`^ALTER TABLE ${table}\\s`).test(item));
        if (!statement) throw new Error(`Missing migration statement for ${table}`);
        const additions = missing.map((column) => {
            const clause = `ADD COLUMN ${column} `;
            const matched = statement.match(new RegExp(`${clause}[^,\\n]+`));
            if (!matched) throw new Error(`Missing schema definition for ${table}.${column}`);
            return matched[0];
        });
        await pool.query(`ALTER TABLE ${table} ${additions.join(", ")}`);
    }
    console.log("Contact timeline tag audit migration completed.");
} catch (error) {
    console.error("Contact timeline tag audit migration failed:", error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
