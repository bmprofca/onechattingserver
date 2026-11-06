import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../db.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(scriptDir, "../migrations/20261106_create_auto_reply_rules.sql");

try {
    const migration = await fs.readFile(migrationPath, "utf8");
    await pool.query(migration);
    console.log("Auto-reply rules migration completed.");
} catch (error) {
    console.error("Auto-reply rules migration failed:", error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
