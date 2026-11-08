import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../db.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(scriptDir, "../migrations/20261108_create_crm_tags_custom_fields.sql");

try {
    const migration = await fs.readFile(migrationPath, "utf8");
    const statements = migration.split(";").map((statement) => statement.trim()).filter(Boolean);
    for (const statement of statements) {
        await pool.query(statement);
    }
    console.log("CRM tags and custom fields migration completed.");
} catch (error) {
    console.error("CRM tags and custom fields migration failed:", error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
