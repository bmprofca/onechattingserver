-- Migration: Create bot_reply_context table
-- This migration creates a table to store bot reply contexts/rules for automatic message responses

-- Check if table exists before creating
SET @table_exists = (
    SELECT COUNT(*) 
    FROM INFORMATION_SCHEMA.TABLES 
    WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'bot_reply_context'
);

-- Create table if it doesn't exist
SET @sql = IF(@table_exists = 0,
    'CREATE TABLE `bot_reply_context` (
        `id` int(11) NOT NULL AUTO_INCREMENT,
        `context_id` varchar(100) NOT NULL,
        `project_id` varchar(100) DEFAULT NULL,
        `context_name` varchar(255) NOT NULL,
        `keywords` text NOT NULL COMMENT ''JSON array of keywords to trigger this response'',
        `response_message` text NOT NULL COMMENT ''Message to send as response'',
        `response_type` varchar(100) DEFAULT ''text'' COMMENT ''Type of response: text, template, media'',
        `template_id` varchar(100) DEFAULT NULL COMMENT ''Template ID if response_type is template'',
        `conditions` text DEFAULT NULL COMMENT ''JSON object for additional conditions'',
        `is_active` enum(''0'',''1'') DEFAULT ''1'' COMMENT ''0 = Inactive, 1 = Active'',
        `priority` int(11) DEFAULT 0 COMMENT ''Higher number = higher priority when multiple matches'',
        `create_date` timestamp NULL DEFAULT current_timestamp(),
        `create_by` varchar(100) DEFAULT NULL,
        `modify_date` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
        `modify_by` varchar(100) DEFAULT NULL,
        `is_deleted` enum(''0'',''1'') DEFAULT ''0'' COMMENT ''0 = Not deleted, 1 = Deleted'',
        `delete_by` varchar(100) DEFAULT NULL,
        PRIMARY KEY (`id`),
        KEY `idx_project_id` (`project_id`),
        KEY `idx_context_id` (`context_id`),
        KEY `idx_is_active` (`is_active`),
        KEY `idx_is_deleted` (`is_deleted`),
        KEY `idx_priority` (`priority`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT=''Bot reply context and rules for automatic message responses''',
    'SELECT ''Table bot_reply_context already exists'' AS message'
);

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Alternative simple version (run this if the above doesn't work):
-- CREATE TABLE IF NOT EXISTS `bot_reply_context` (
--     `id` int(11) NOT NULL AUTO_INCREMENT,
--     `context_id` varchar(100) NOT NULL,
--     `project_id` varchar(100) DEFAULT NULL,
--     `context_name` varchar(255) NOT NULL,
--     `keywords` text NOT NULL COMMENT 'JSON array of keywords to trigger this response',
--     `response_message` text NOT NULL COMMENT 'Message to send as response',
--     `response_type` varchar(100) DEFAULT 'text' COMMENT 'Type of response: text, template, media',
--     `template_id` varchar(100) DEFAULT NULL COMMENT 'Template ID if response_type is template',
--     `conditions` text DEFAULT NULL COMMENT 'JSON object for additional conditions',
--     `is_active` enum('0','1') DEFAULT '1' COMMENT '0 = Inactive, 1 = Active',
--     `priority` int(11) DEFAULT 0 COMMENT 'Higher number = higher priority when multiple matches',
--     `create_date` timestamp NULL DEFAULT current_timestamp(),
--     `create_by` varchar(100) DEFAULT NULL,
--     `modify_date` timestamp NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
--     `modify_by` varchar(100) DEFAULT NULL,
--     `is_deleted` enum('0','1') DEFAULT '0' COMMENT '0 = Not deleted, 1 = Deleted',
--     `delete_by` varchar(100) DEFAULT NULL,
--     PRIMARY KEY (`id`),
--     KEY `idx_project_id` (`project_id`),
--     KEY `idx_context_id` (`context_id`),
--     KEY `idx_is_active` (`is_active`),
--     KEY `idx_is_deleted` (`is_deleted`),
--     KEY `idx_priority` (`priority`)
-- ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='Bot reply context and rules for automatic message responses';
