import pool from "../db.js";
import { RANDOM_STRING, TIMESTAMP } from "../helpers/function.js";

// Set the cost per AI auto-reply message (default 1.0 Rs)
const AI_REPLY_COST = 1.0;

export async function generateAiBills() {
    let connection;
    try {
        connection = await pool.getConnection();

        // Calculate "yesterday" date for billing
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        
        const year = yesterday.getFullYear();
        const month = String(yesterday.getMonth() + 1).padStart(2, '0');
        const day = String(yesterday.getDate()).padStart(2, '0');
        
        const billDateStr = `${year}-${month}-${day}`;
        const startTimeStr = `${billDateStr} 00:00:00`;
        const endTimeStr = `${billDateStr} 23:59:59`;

        console.log(`[aiBilling] Starting AI billing for date: ${billDateStr}`);

        // Get count of BOT messages per project for yesterday
        const [usageRows] = await connection.query(
            `SELECT project_id, COUNT(*) as usage_count 
             FROM messages 
             WHERE message_by = 'BOT' 
               AND create_date >= ? 
               AND create_date <= ? 
             GROUP BY project_id`,
            [startTimeStr, endTimeStr]
        );

        if (usageRows.length === 0) {
            console.log(`[aiBilling] No AI usage found for ${billDateStr}.`);
            return;
        }

        for (const row of usageRows) {
            const project_id = row.project_id;
            const usage_count = Number(row.usage_count);
            
            if (usage_count <= 0) continue;

            const bill_amount = usage_count * AI_REPLY_COST;

            // Find project owner
            const [ownerRows] = await connection.query(
                "SELECT username FROM project_mapping WHERE project_id = ? AND type = 'admin' LIMIT 1",
                [project_id]
            );

            if (ownerRows.length === 0) {
                console.log(`[aiBilling] No admin owner found for project ${project_id}. Skipping billing.`);
                continue;
            }

            const username = ownerRows[0].username;

            // Keep one daily ledger charge per project. ai_agent_bills is not
            // part of every deployment, so use the transactions ledger itself
            // as the source of truth and idempotency check.
            const [existingBillRows] = await connection.query(
                `SELECT id FROM transactions
                 WHERE project_id = ?
                   AND transaction_type = 'ai auto reply bill'
                   AND type = '0'
                   AND DATE(create_date) = ?
                 LIMIT 1`,
                [project_id, billDateStr]
            );

            if (existingBillRows.length > 0) {
                console.log(`[aiBilling] Bill already exists for project ${project_id} on ${billDateStr}. Skipping.`);
                continue;
            }

            // The wallet balance is calculated from this debit transaction.
            if (bill_amount > 0) {
                await connection.query(
                    "INSERT INTO transactions (transaction_id, username, project_id, amount, type, transaction_type, remark, create_date, create_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    [RANDOM_STRING(30), username, project_id, bill_amount, "0", "ai auto reply bill", `Daily AI Agent usage bill for ${billDateStr} (${usage_count} replies)`, TIMESTAMP(), "SYSTEM"]
                );
            }

            console.log(`[aiBilling] Billed ${username} (Project ${project_id}) for ${usage_count} AI replies = ${bill_amount} Rs.`);
        }

        console.log(`[aiBilling] Completed AI billing for ${billDateStr}.`);

    } catch (error) {
        console.error("[aiBilling] Error generating AI bills:", error);
    } finally {
        if (connection) {
            connection.release();
        }
    }
}
