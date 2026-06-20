-- Migration: Add schedule_date column to campaigns table
-- This migration adds a schedule_date column to support scheduled campaign functionality
-- Format: YYYY-MM-DD H:i:s

-- Check if column exists before adding (safe to run multiple times)
SET @column_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.COLUMNS 
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'campaigns' 
    AND COLUMN_NAME = 'schedule_date'
);

-- Add column if it doesn't exist
SET @sql = IF(@column_exists = 0,
    'ALTER TABLE `campaigns` 
     ADD COLUMN `schedule_date` DATETIME NULL 
     COMMENT ''Scheduled date and time for campaign execution (YYYY-MM-DD H:i:s format)''
     AFTER `status`',
    'SELECT ''Column schedule_date already exists in campaigns table'' AS message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Alternative simple version (run this if the above doesn't work):
-- ALTER TABLE `campaigns` 
-- ADD COLUMN `schedule_date` DATETIME NULL 
-- COMMENT 'Scheduled date and time for campaign execution (YYYY-MM-DD H:i:s format)'
-- AFTER `status`;
