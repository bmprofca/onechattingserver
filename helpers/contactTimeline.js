const MAX_TIMELINE_PAGE = 100000;
const MAX_TIMELINE_LIMIT = 100;

const asTimelineText = (expression) =>
    `CONVERT(${expression} USING utf8mb4) COLLATE utf8mb4_unicode_ci`;

const TIMELINE_SOURCES = [
    `SELECT
        ${asTimelineText("CONCAT('chat:', m.id)")} AS event_id,
        ${asTimelineText("'chat'")} AS event_type,
        ${asTimelineText("CASE WHEN m.type = 'in' THEN 'Incoming message' ELSE 'Outgoing message' END")} AS title,
        ${asTimelineText("COALESCE(NULLIF(m.message, ''), CONCAT('Sent ', COALESCE(NULLIF(m.message_type, ''), 'message')))")} AS description,
        m.create_date AS occurred_at,
        ${asTimelineText("CASE WHEN m.type = 'in' THEN 'Contact' ELSE COALESCE(NULLIF(m.message_by, ''), 'Agent') END")} AS actor
     FROM messages m
     WHERE m.project_id = ? AND m.number = ?
       AND COALESCE(m.is_campaign, '0') <> '1'`,
    `SELECT
         ${asTimelineText("CASE WHEN campaign_message.id IS NULL THEN CONCAT('campaign:', cm.id) ELSE CONCAT('campaign-message:', cm.id, ':', campaign_message.id) END")} AS event_id,
        ${asTimelineText("'campaign'")} AS event_type,
        ${asTimelineText("'Campaign message'")} AS title,
        ${asTimelineText("CONCAT_WS(' · ', NULLIF(c.name, ''), CONCAT('Status: ', cm.status), NULLIF(cm.template_name, ''))")} AS description,
        COALESCE(cm.send_date, cm.create_date) AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(cm.create_by, ''), 'Campaign')")} AS actor
     FROM campaign_messages cm
     LEFT JOIN campaigns c ON c.project_id = cm.project_id AND c.campaign_id = cm.campaign_id
      LEFT JOIN messages campaign_message ON campaign_message.id = (
         SELECT MAX(m.id)
         FROM messages m
         WHERE m.project_id = cm.project_id AND m.number = cm.number
           AND ((cm.wamid IS NOT NULL AND m.wamid = cm.wamid)
             OR (cm.unique_id IS NOT NULL AND m.unique_id = cm.unique_id))
      )
      WHERE cm.project_id = ? AND cm.number = ?`,
    `SELECT
        ${asTimelineText("CONCAT('case-created:', c.id)")} AS event_id,
        ${asTimelineText("'case'")} AS event_type,
        ${asTimelineText("'Case opened'")} AS title,
        ${asTimelineText("COALESCE(NULLIF(c.name, ''), NULLIF(c.remark, ''), 'Case created')")} AS description,
        c.create_date AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(c.create_by, ''), 'System')")} AS actor
     FROM cases c
     WHERE c.project_id = ? AND c.number = ?`,
    `SELECT
        ${asTimelineText("CONCAT('case-updated:', c.id)")} AS event_id,
        ${asTimelineText("'case'")} AS event_type,
        ${asTimelineText("'Case updated'")} AS title,
        ${asTimelineText("CONCAT_WS(' · ', NULLIF(c.name, ''), CONCAT('Status: ', CASE WHEN c.status = '0' THEN 'Open' ELSE 'Closed' END), NULLIF(c.remark, ''))")} AS description,
        c.modify_date AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(c.modify_by, ''), 'System')")} AS actor
     FROM cases c
     WHERE c.project_id = ? AND c.number = ?
       AND c.modify_by IS NOT NULL AND c.modify_date >= c.create_date`,
    `SELECT
        ${asTimelineText("CONCAT('note:', n.id)")} AS event_id,
        ${asTimelineText("'note'")} AS event_type,
        ${asTimelineText("'Internal note'")} AS title,
        ${asTimelineText("n.note_text")} AS description,
        n.create_date AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(n.create_by, ''), 'Agent')")} AS actor
     FROM inbox_internal_notes n
     WHERE n.project_id = ? AND n.number = ?`,
    `SELECT
        ${asTimelineText("CONCAT('contact-created:', c.id)")} AS event_id,
        ${asTimelineText("'contact'")} AS event_type,
        ${asTimelineText("'Contact created'")} AS title,
        ${asTimelineText("'Contact profile added'")} AS description,
        c.create_date AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(c.create_by, ''), 'System')")} AS actor
     FROM contacts c
     WHERE c.project_id = ? AND c.number = ? AND c.is_deleted = '0'`,
    `SELECT
        ${asTimelineText("CONCAT('contact-updated:', c.id)")} AS event_id,
        ${asTimelineText("'contact'")} AS event_type,
        ${asTimelineText("'Contact updated'")} AS title,
        ${asTimelineText("'Contact profile updated'")} AS description,
        c.modify_date AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(c.modify_by, ''), 'System')")} AS actor
     FROM contacts c
     WHERE c.project_id = ? AND c.number = ? AND c.is_deleted = '0'
       AND c.modify_date > c.create_date`,
    `SELECT
        ${asTimelineText("CONCAT('contact-tag:', m.id)")} AS event_id,
        ${asTimelineText("'tag'")} AS event_type,
        ${asTimelineText("'Contact tag added'")} AS title,
        ${asTimelineText("t.name")} AS description,
        m.create_date AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(m.create_by, ''), 'Agent')")} AS actor
     FROM contact_tag_mapping m
     INNER JOIN contacts c ON c.project_id = m.project_id
       AND c.contact_id = m.contact_id
     INNER JOIN crm_tags t ON t.project_id = m.project_id
       AND t.tag_id = m.tag_id
     WHERE m.project_id = ? AND c.number = ?`,
    `SELECT
        ${asTimelineText("CONCAT('contact-tag-removed:', m.id)")} AS event_id,
        ${asTimelineText("'tag'")} AS event_type,
        ${asTimelineText("'Contact tag removed'")} AS title,
        ${asTimelineText("t.name")} AS description,
        m.deleted_date AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(m.deleted_by, ''), 'Agent')")} AS actor
     FROM contact_tag_mapping m
     INNER JOIN contacts c ON c.project_id = m.project_id
       AND c.contact_id = m.contact_id
     INNER JOIN crm_tags t ON t.project_id = m.project_id
       AND t.tag_id = m.tag_id
     WHERE m.project_id = ? AND c.number = ? AND m.deleted_date IS NOT NULL`,
    `SELECT
        ${asTimelineText("CONCAT('conversation-tag:', m.id)")} AS event_id,
        ${asTimelineText("'tag'")} AS event_type,
        ${asTimelineText("'Conversation tag added'")} AS title,
        ${asTimelineText("t.name")} AS description,
        m.create_date AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(m.create_by, ''), 'Agent')")} AS actor
     FROM conversation_label_mapping m
     INNER JOIN crm_tags t ON t.project_id = m.project_id
       AND t.tag_id = m.tag_id
     WHERE m.project_id = ? AND m.number = ?`,
    `SELECT
        ${asTimelineText("CONCAT('conversation-tag-removed:', m.id)")} AS event_id,
        ${asTimelineText("'tag'")} AS event_type,
        ${asTimelineText("'Conversation tag removed'")} AS title,
        ${asTimelineText("t.name")} AS description,
        m.deleted_date AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(m.deleted_by, ''), 'Agent')")} AS actor
     FROM conversation_label_mapping m
     INNER JOIN crm_tags t ON t.project_id = m.project_id
       AND t.tag_id = m.tag_id
     WHERE m.project_id = ? AND m.number = ? AND m.deleted_date IS NOT NULL`,
    `SELECT
        ${asTimelineText("CONCAT('flow-log:', l.id)")} AS event_id,
        ${asTimelineText("'flow'")} AS event_type,
        ${asTimelineText("COALESCE(NULLIF(f.name, ''), 'Flow execution')")} AS title,
        ${asTimelineText("CONCAT_WS(' · ', l.action, CONCAT('Status: ', l.status))")} AS description,
        l.create_date AS occurred_at,
        ${asTimelineText("'Automation'")} AS actor
     FROM flow_execution_logs l
     LEFT JOIN flows f ON f.project_id = l.project_id AND f.flow_id = l.flow_id
     WHERE l.project_id = ? AND l.number = ?`,
    `SELECT
        ${asTimelineText("CONCAT('flow-started:', fc.id)")} AS event_id,
        ${asTimelineText("'flow'")} AS event_type,
        ${asTimelineText("'Flow started'")} AS title,
        ${asTimelineText("COALESCE(NULLIF(f.name, ''), 'Flow')")} AS description,
        fc.started_at AS occurred_at,
        ${asTimelineText("'Automation'")} AS actor
     FROM flow_conversations fc
     LEFT JOIN flows f ON f.project_id = fc.project_id AND f.flow_id = fc.flow_id
     WHERE fc.project_id = ? AND fc.number = ?`,
    `SELECT
        ${asTimelineText("CONCAT('flow-updated:', fc.id)")} AS event_id,
        ${asTimelineText("'flow'")} AS event_type,
        ${asTimelineText("'Flow status changed'")} AS title,
        ${asTimelineText("CONCAT_WS(' · ', COALESCE(NULLIF(f.name, ''), 'Flow'), CONCAT('Status: ', fc.status))")} AS description,
        fc.updated_at AS occurred_at,
        ${asTimelineText("'Automation'")} AS actor
     FROM flow_conversations fc
     LEFT JOIN flows f ON f.project_id = fc.project_id AND f.flow_id = fc.flow_id
     WHERE fc.project_id = ? AND fc.number = ?
       AND fc.status <> 'active'`,
    `SELECT
        ${asTimelineText("CONCAT('qr-scan:', q.id)")} AS event_id,
        ${asTimelineText("'qr'")} AS event_type,
        ${asTimelineText("'QR origin captured'")} AS title,
        ${asTimelineText("CONCAT('QR code: ', COALESCE(NULLIF(q.qr_id, ''), 'unknown'))")} AS description,
        STR_TO_DATE(q.create_date, '%Y-%m-%d %H:%i:%s') AS occurred_at,
        ${asTimelineText("COALESCE(NULLIF(q.added_by, ''), 'QR form')")} AS actor
     FROM qr_scanned_users q
     WHERE q.project_id = ?
       AND REPLACE(q.mobile, '+', '') = REPLACE(?, '+', '')`,
];

export function normalizeTimelinePagination(pageValue, limitValue) {
    const parsedPage = Number(pageValue);
    const parsedLimit = Number(limitValue);
    const page = Number.isSafeInteger(parsedPage) && parsedPage > 0
        ? Math.min(parsedPage, MAX_TIMELINE_PAGE)
        : 1;
    const limit = Number.isSafeInteger(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, MAX_TIMELINE_LIMIT)
        : 30;
    return { page, limit, offset: (page - 1) * limit };
}

export function buildContactTimelineQuery(projectId, number, page, limit, offset) {
    const unionSql = TIMELINE_SOURCES.join("\nUNION ALL\n");
    const sourceParams = TIMELINE_SOURCES.flatMap(() => [projectId, number]);
    return {
        countSql: `SELECT COUNT(*) AS total
                   FROM (${unionSql}) timeline_count
                   WHERE occurred_at IS NOT NULL`,
        countParams: sourceParams,
        dataSql: `SELECT event_id, event_type, title, description, occurred_at, actor
                  FROM (${unionSql}) timeline_events
                  WHERE occurred_at IS NOT NULL
                  ORDER BY occurred_at DESC, event_id DESC
                  LIMIT ? OFFSET ?`,
        dataParams: [...sourceParams, limit, offset],
        page,
        limit,
        offset,
        sourceCount: TIMELINE_SOURCES.length
    };
}
