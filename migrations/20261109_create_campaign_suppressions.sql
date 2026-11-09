CREATE TABLE IF NOT EXISTS campaign_suppressions (
    project_id VARCHAR(100) NOT NULL,
    phone VARCHAR(100) NOT NULL,
    opt_out_date DATETIME NOT NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'whatsapp',
    PRIMARY KEY (project_id, phone),
    KEY idx_campaign_suppressions_project_date (project_id, opt_out_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS campaign_message_clicks (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    project_id VARCHAR(100) NOT NULL,
    campaign_id VARCHAR(100) NOT NULL,
    phone VARCHAR(100) NOT NULL,
    inbound_wamid VARCHAR(1000) NOT NULL,
    click_type VARCHAR(32) NOT NULL,
    create_date DATETIME NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uniq_campaign_message_click (project_id, inbound_wamid(600)),
    KEY idx_campaign_message_clicks_report (project_id, campaign_id, phone, create_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
