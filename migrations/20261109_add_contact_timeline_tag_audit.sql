ALTER TABLE contact_tag_mapping
    ADD COLUMN deleted_date DATETIME NULL,
    ADD COLUMN deleted_by VARCHAR(100) NULL;

ALTER TABLE conversation_label_mapping
    ADD COLUMN deleted_date DATETIME NULL,
    ADD COLUMN deleted_by VARCHAR(100) NULL;
