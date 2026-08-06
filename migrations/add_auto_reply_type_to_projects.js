import pool from "../db.js";

/**
 * Migration: Add auto_reply_type column to aisensy_projects table
 * 
 * Run with: node migrations/add_auto_reply_type_to_projects.js
 */

async function addAutoReplyTypeToProjects() {
    let connection;
    try {
        connection = await pool.getConnection();
        
        console.log("🔄 Starting migration: Add auto_reply_type to aisensy_projects...");
        
        const [columns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'aisensy_projects'
            AND COLUMN_NAME = 'auto_reply_type'
        `);
        
        if (columns.length > 0) {
            console.log("✅ Column 'auto_reply_type' already exists. Skipping migration.");
            return;
        }
        
        await connection.query(`
            ALTER TABLE \`aisensy_projects\` 
            ADD COLUMN \`auto_reply_type\` enum('all','new') DEFAULT 'new' COMMENT 'all = reply to all conversations, new = reply to new conversations only' AFTER \`auto_reply\`;
        `);
        
        console.log("✅ Successfully added 'auto_reply_type' column!");
        console.log("   - auto_reply_type: ENUM('all', 'new') DEFAULT 'new'");
        
    } catch (error) {
        console.error("❌ Migration failed:", error.message);
        throw error;
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.includes('add_auto_reply_type_to_projects.js')) {
    addAutoReplyTypeToProjects()
        .then(() => {
            console.log("✨ Migration completed successfully!");
            process.exit(0);
        })
        .catch((error) => {
            console.error("💥 Migration failed:", error);
            process.exit(1);
        });
}

export default addAutoReplyTypeToProjects;
