import pool from "../db.js";

/**
 * Migration: Create bot_reply_context table
 * 
 * This migration creates a table to store bot reply contexts/rules
 * for automatic message responses based on keywords and conditions.
 * 
 * Run with: node migrations/create_bot_reply_context_table.js
 */

async function createBotReplyContextTable() {
    let connection;
    try {
        connection = await pool.getConnection();
        
        console.log("🔄 Starting migration: Create bot_reply_context table...");
        
        // Check if table already exists
        const [tables] = await connection.query(`
            SELECT TABLE_NAME 
            FROM INFORMATION_SCHEMA.TABLES 
            WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'bot_reply_context'
        `);
        
        if (tables.length > 0) {
            console.log("✅ Table 'bot_reply_context' already exists. Skipping migration.");
            return;
        }
        
        // Create the bot_reply_context table
        await connection.query(`
            CREATE TABLE \`bot_reply_context\` (
                \`id\` int(11) NOT NULL AUTO_INCREMENT,
                \`context_id\` varchar(100) NOT NULL,
                \`project_id\` varchar(100) DEFAULT NULL,
                \`context_name\` varchar(255) NOT NULL,
                \`keywords\` text NOT NULL COMMENT 'JSON array of keywords to trigger this response',
                \`response_message\` text NOT NULL COMMENT 'Message to send as response',
                \`response_type\` varchar(100) DEFAULT 'text' COMMENT 'Type of response: text, template, media',
                \`template_id\` varchar(100) DEFAULT NULL COMMENT 'Template ID if response_type is template',
                \`conditions\` text DEFAULT NULL COMMENT 'JSON object for additional conditions',
                \`is_active\` enum('0','1') DEFAULT '1' COMMENT '0 = Inactive, 1 = Active',
                \`priority\` int(11) DEFAULT 0 COMMENT 'Higher number = higher priority when multiple matches',
                \`create_date\` timestamp NULL DEFAULT current_timestamp(),
                \`create_by\` varchar(100) DEFAULT NULL,
                \`modify_date\` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
                \`modify_by\` varchar(100) DEFAULT NULL,
                \`is_deleted\` enum('0','1') DEFAULT '0' COMMENT '0 = Not deleted, 1 = Deleted',
                \`delete_by\` varchar(100) DEFAULT NULL,
                PRIMARY KEY (\`id\`),
                KEY \`idx_project_id\` (\`project_id\`),
                KEY \`idx_context_id\` (\`context_id\`),
                KEY \`idx_is_active\` (\`is_active\`),
                KEY \`idx_is_deleted\` (\`is_deleted\`),
                KEY \`idx_priority\` (\`priority\`)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Bot reply context and rules for automatic message responses'
        `);
        
        console.log("✅ Successfully created 'bot_reply_context' table!");
        console.log("📋 Table structure:");
        console.log("   - id: Primary key (auto increment)");
        console.log("   - context_id: Unique identifier for context");
        console.log("   - project_id: Associated project");
        console.log("   - context_name: Name of the context/rule");
        console.log("   - keywords: JSON array of trigger keywords");
        console.log("   - response_message: Response message text");
        console.log("   - response_type: Type of response (text, template, media)");
        console.log("   - template_id: Template ID if using template response");
        console.log("   - conditions: JSON object for additional conditions");
        console.log("   - is_active: Active status");
        console.log("   - priority: Priority level for matching");
        console.log("   - Standard audit fields: create_date, create_by, modify_date, modify_by");
        console.log("   - Soft delete: is_deleted, delete_by");
        
    } catch (error) {
        console.error("❌ Migration failed:", error.message);
        throw error;
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

// Run migration when executed directly
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.includes('create_bot_reply_context_table.js')) {
    createBotReplyContextTable()
        .then(() => {
            console.log("✨ Migration completed successfully!");
            process.exit(0);
        })
        .catch((error) => {
            console.error("💥 Migration failed:", error);
            process.exit(1);
        });
}

export default createBotReplyContextTable;
