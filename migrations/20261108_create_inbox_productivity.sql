CREATE TABLE IF NOT EXISTS conversation_label_mapping (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    project_id VARCHAR(100) NOT NULL,
    number VARCHAR(64) NOT NULL,
    tag_id CHAR(30) NOT NULL,
    create_date DATETIME NOT NULL,
    create_by VARCHAR(100) NOT NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_conversation_label (project_id, number, tag_id),
    KEY idx_conversation_labels_project_number (project_id, number, is_deleted),
    KEY idx_conversation_labels_project_tag (project_id, tag_id, is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inbox_internal_notes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    note_id CHAR(30) NOT NULL,
    project_id VARCHAR(100) NOT NULL,
    number VARCHAR(64) NOT NULL,
    note_text TEXT NOT NULL,
    create_date DATETIME NOT NULL,
    create_by VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_inbox_note_id (note_id),
    KEY idx_inbox_notes_project_number (project_id, number, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inbox_canned_replies (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    reply_id CHAR(30) NOT NULL,
    project_id VARCHAR(100) NOT NULL,
    shortcut VARCHAR(40) NOT NULL,
    title VARCHAR(80) NOT NULL,
    body TEXT NOT NULL,
    create_date DATETIME NOT NULL,
    create_by VARCHAR(100) NOT NULL,
    modify_date DATETIME NOT NULL,
    modify_by VARCHAR(100) NOT NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    active_shortcut VARCHAR(40) GENERATED ALWAYS AS (IF(is_deleted = 0, shortcut, NULL)) STORED,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_inbox_reply_id (reply_id),
    UNIQUE KEY uniq_inbox_reply_project_shortcut (project_id, active_shortcut),
    KEY idx_inbox_replies_project_active (project_id, is_deleted, shortcut)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
