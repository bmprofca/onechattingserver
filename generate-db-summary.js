import pool from "./db.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Fetches database summary (tables, columns, row counts) and saves to database-context.json at project base path.
 * Use this output for future database-related work (migrations, queries, documentation).
 * @returns {Promise<object|null>} The summary object, or null on error
 */
export async function generateSummary() {
    let connection;
    try {
        connection = await pool.getConnection();
        const dbName = connection.config.database;

        // Tables with approximate row counts and engine
        const [tables] = await connection.query(
            `SELECT TABLE_NAME, TABLE_ROWS, ENGINE, TABLE_COMMENT, CREATE_TIME, UPDATE_TIME
             FROM information_schema.TABLES
             WHERE TABLE_SCHEMA = ?
             ORDER BY TABLE_NAME`,
            [dbName]
        );

        const tablesSummary = [];

        for (const table of tables) {
            const [columns] = await connection.query(
                `SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
                 FROM information_schema.COLUMNS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                 ORDER BY ORDINAL_POSITION`,
                [dbName, table.TABLE_NAME]
            );

            const [indexes] = await connection.query(
                `SELECT INDEX_NAME, COLUMN_NAME, NON_UNIQUE
                 FROM information_schema.STATISTICS
                 WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
                 ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
                [dbName, table.TABLE_NAME]
            );

            const indexMap = {};
            for (const idx of indexes) {
                if (!indexMap[idx.INDEX_NAME]) {
                    indexMap[idx.INDEX_NAME] = { columns: [], nonUnique: idx.NON_UNIQUE === 1 };
                }
                indexMap[idx.INDEX_NAME].columns.push(idx.COLUMN_NAME);
            }

            tablesSummary.push({
                table: table.TABLE_NAME,
                tableRows: table.TABLE_ROWS != null ? Number(table.TABLE_ROWS) : null,
                engine: table.ENGINE,
                comment: table.TABLE_COMMENT || null,
                createTime: table.CREATE_TIME,
                updateTime: table.UPDATE_TIME,
                columns: columns.map((c) => ({
                    name: c.COLUMN_NAME,
                    type: c.COLUMN_TYPE || c.DATA_TYPE,
                    nullable: c.IS_NULLABLE === "YES",
                    key: c.COLUMN_KEY || null,
                    default: c.COLUMN_DEFAULT,
                    extra: c.EXTRA || null,
                    comment: c.COLUMN_COMMENT || null,
                })),
                indexes: indexMap,
            });
        }

        const summary = {
            generatedAt: new Date().toISOString(),
            database: dbName,
            tableCount: tablesSummary.length,
            tables: tablesSummary,
        };

        const outputPath = path.join(__dirname, "database-context.json");
        fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), "utf8");
        return summary;
    } catch (err) {
        console.error("Failed to generate database summary:", err.message);
        return null;
    } finally {
        if (connection) connection.release();
    }
}
