import pool from "../db.js";

/**
 * Migration: Add auto_reply and context columns to aisensy_projects table
 * 
 * Run with: node migrations/add_auto_reply_to_projects.js
 */

async function addAutoReplyToProjects() {
    let connection;
    try {
        connection = await pool.getConnection();
        
        console.log("🔄 Starting migration: Alter aisensy_projects table...");
        
        // Check if auto_reply already exists
        const [columns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'aisensy_projects'
            AND COLUMN_NAME = 'auto_reply'
        `);
        
        if (columns.length > 0) {
            console.log("✅ Columns 'auto_reply' already exists. Skipping migration.");
            return;
        }
        
        // Alter the table to add auto_reply and context
        await connection.query(`
            ALTER TABLE \`aisensy_projects\` 
            ADD COLUMN \`auto_reply\` enum('0','1') DEFAULT '0' COMMENT '0 = Inactive, 1 = Active' AFTER \`auto_renewal\`,
            ADD COLUMN \`context\` LONGTEXT DEFAULT NULL COMMENT 'Company Q&A Context for AI Auto-reply' AFTER \`auto_reply\`;
        `);
        
        console.log("✅ Successfully altered 'aisensy_projects' table!");
        console.log("📋 Added columns:");
        console.log("   - auto_reply: ENUM('0', '1') DEFAULT '0'");
        console.log("   - context: LONGTEXT DEFAULT NULL");
        
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
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.includes('add_auto_reply_to_projects.js')) {
    addAutoReplyToProjects()
        .then(() => {
            console.log("✨ Migration completed successfully!");
            process.exit(0);
        })
        .catch((error) => {
            console.error("💥 Migration failed:", error);
            process.exit(1);
        });
}

export default addAutoReplyToProjects;
