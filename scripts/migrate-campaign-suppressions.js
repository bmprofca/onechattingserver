import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pool from "../db.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const migrationPath = path.join(scriptDir, "../migrations/20261109_create_campaign_suppressions.sql");

try {
    const migration = await fs.readFile(migrationPath, "utf8");
    const statements = migration.split(";").map((statement) => statement.trim()).filter(Boolean);
    for (const statement of statements) {
        await pool.query(statement);
    }

    const indexes = [
        {
            table: "campaign_messages",
            name: "idx_campaign_messages_retarget",
            definition: "(project_id, campaign_id, status, number)"
        },
        {
            table: "messages",
            name: "idx_messages_project_number_type_date",
            definition: "(project_id, number(100), type, create_date)"
        },
        {
            table: "messages",
            name: "idx_messages_campaign_interaction",
            definition: "(project_id, number(100), type, message_type, reply_wamid(300))"
        }
    ];
    for (const index of indexes) {
        const [existingIndexes] = await pool.query(
            `SELECT index_name FROM information_schema.statistics
             WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ? LIMIT 1`,
            [index.table, index.name]
        );
        if (existingIndexes.length === 0) {
            await pool.query(`CREATE INDEX ${index.name} ON ${index.table} ${index.definition}`);
        }
    }

    console.log("Campaign suppression migration completed.");
} catch (error) {
    console.error("Campaign suppression migration failed:", error?.message || error);
    process.exitCode = 1;
} finally {
    await pool.end();
}
