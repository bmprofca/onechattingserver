import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../db.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(scriptDir, "../migrations/20261113_create_dynamic_segments.sql");

try {
    const migration = await fs.readFile(migrationPath, "utf8");
    const statements = migration.split(";").map((statement) => statement.trim()).filter(Boolean);
    const [existingOrigin] = await pool.query(
        `SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'contacts' AND COLUMN_NAME = 'origin'`
    );
    for (const statement of statements) {
        if (/^ALTER TABLE contacts\s+ADD COLUMN origin\b/i.test(statement) && existingOrigin.length > 0) {
            continue;
        }
        await pool.query(statement);
    }
    console.log("Dynamic segments migration completed.");
} catch (error) {
    console.error("Dynamic segments migration failed:", error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
