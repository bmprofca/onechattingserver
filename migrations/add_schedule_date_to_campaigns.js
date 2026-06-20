import pool from "../db.js";

/**
 * Migration: Add schedule_date column to campaigns table
 * 
 * This migration adds a schedule_date column to the campaigns table
 * to support scheduled campaign functionality.
 * 
 * Run with: node migrations/add_schedule_date_to_campaigns.js
 */

async function addScheduleDateColumn() {
    let connection;
    try {
        connection = await pool.getConnection();

        console.log("🔄 Starting migration: Add schedule_date to campaigns table...");

        // Check if column already exists
        const [columns] = await connection.query(`
            SELECT COLUMN_NAME 
            FROM INFORMATION_SCHEMA.COLUMNS 
            WHERE TABLE_SCHEMA = DATABASE()
            AND TABLE_NAME = 'campaigns' 
            AND COLUMN_NAME = 'schedule_date'
        `);

        if (columns.length > 0) {
            console.log("✅ Column 'schedule_date' already exists in campaigns table. Skipping migration.");
            return;
        }

        // Add the schedule_date column
        await connection.query(`
            ALTER TABLE \`campaigns\` 
            ADD COLUMN \`schedule_date\` DATETIME NULL 
            COMMENT 'Scheduled date and time for campaign execution (YYYY-MM-DD H:i:s format)'
            AFTER \`status\`
        `);

        console.log("✅ Successfully added 'schedule_date' column to campaigns table!");
        console.log("📋 Column details:");
        console.log("   - Type: DATETIME");
        console.log("   - Nullable: YES");
        console.log("   - Format: YYYY-MM-DD H:i:s");

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
// Usage: node migrations/add_schedule_date_to_campaigns.js
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.includes('add_schedule_date_to_campaigns.js')) {
    addScheduleDateColumn()
        .then(() => {
            console.log("✨ Migration completed successfully!");
            process.exit(0);
        })
        .catch((error) => {
            console.error("💥 Migration failed:", error);
            process.exit(1);
        });
}

export default addScheduleDateColumn;
