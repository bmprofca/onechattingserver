CREATE TABLE IF NOT EXISTS crm_tags (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    tag_id CHAR(30) NOT NULL,
    project_id VARCHAR(100) NOT NULL,
    name VARCHAR(80) NOT NULL,
    color CHAR(7) NOT NULL DEFAULT '#6366f1',
    create_date DATETIME NOT NULL,
    create_by VARCHAR(100) NOT NULL,
    modify_date DATETIME NOT NULL,
    modify_by VARCHAR(100) NOT NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    active_name VARCHAR(80) GENERATED ALWAYS AS (IF(is_deleted = 0, name, NULL)) STORED,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_crm_tag_id (tag_id),
    UNIQUE KEY uniq_crm_tag_project_name (project_id, active_name),
    KEY idx_crm_tags_project_active (project_id, is_deleted, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS contact_tag_mapping (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    project_id VARCHAR(100) NOT NULL,
    contact_id VARCHAR(100) NOT NULL,
    tag_id CHAR(30) NOT NULL,
    create_date DATETIME NOT NULL,
    create_by VARCHAR(100) NOT NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_contact_tag_project_mapping (project_id, contact_id, tag_id),
    KEY idx_contact_tag_project_tag (project_id, tag_id, is_deleted),
    KEY idx_contact_tag_project_contact (project_id, contact_id, is_deleted)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_custom_fields (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    field_id CHAR(30) NOT NULL,
    project_id VARCHAR(100) NOT NULL,
    name VARCHAR(120) NOT NULL,
    field_key VARCHAR(80) NOT NULL,
    field_type ENUM('text', 'number', 'date', 'boolean', 'select') NOT NULL,
    options_json TEXT NULL,
    create_date DATETIME NOT NULL,
    create_by VARCHAR(100) NOT NULL,
    modify_date DATETIME NOT NULL,
    modify_by VARCHAR(100) NOT NULL,
    is_deleted TINYINT(1) NOT NULL DEFAULT 0,
    active_field_key VARCHAR(80) GENERATED ALWAYS AS (IF(is_deleted = 0, field_key, NULL)) STORED,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_crm_custom_field_id (field_id),
    UNIQUE KEY uniq_crm_custom_field_project_key (project_id, active_field_key),
    KEY idx_crm_custom_fields_project_active (project_id, is_deleted, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS crm_custom_field_values (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    project_id VARCHAR(100) NOT NULL,
    contact_id VARCHAR(100) NOT NULL,
    field_id CHAR(30) NOT NULL,
    field_value TEXT NOT NULL,
    modify_date DATETIME NOT NULL,
    modify_by VARCHAR(100) NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_crm_custom_value_project_contact_field (project_id, contact_id, field_id),
    KEY idx_crm_custom_values_project_field (project_id, field_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
