ALTER TABLE contacts
    ADD COLUMN origin VARCHAR(32) NOT NULL DEFAULT 'manual';

CREATE TABLE IF NOT EXISTS dynamic_segments (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    segment_id CHAR(30) NOT NULL,
    project_id VARCHAR(100) NOT NULL,
    name VARCHAR(100) NOT NULL,
    definition_json JSON NOT NULL,
    create_date DATETIME NOT NULL,
    create_by VARCHAR(100) NOT NULL,
    modify_date DATETIME NOT NULL,
    modify_by VARCHAR(100) NOT NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_dynamic_segment_id (segment_id),
    KEY idx_dynamic_segments_project_active (project_id, is_deleted, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
