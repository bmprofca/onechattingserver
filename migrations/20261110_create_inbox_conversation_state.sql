CREATE TABLE IF NOT EXISTS inbox_conversation_state (
    project_id VARCHAR(100) NOT NULL,
    number VARCHAR(64) NOT NULL,
    status ENUM('open', 'closed') NOT NULL DEFAULT 'open',
    snoozed_until DATETIME NULL,
    snooze_on_reply TINYINT(1) NOT NULL DEFAULT 0,
    snooze_after_message_id BIGINT UNSIGNED NULL,
    closed_at DATETIME NULL,
    closed_by VARCHAR(100) NULL,
    modify_date DATETIME NOT NULL,
    modify_by VARCHAR(100) NOT NULL,
    PRIMARY KEY (project_id, number),
    KEY idx_inbox_state_status (project_id, status),
    KEY idx_inbox_state_snooze (project_id, snoozed_until, snooze_on_reply)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
