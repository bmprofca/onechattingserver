const RETARGET_AUDIENCES = Object.freeze({
    delivered_not_read: {
        label: "Delivered, not read",
        predicate: "cm.status = 'delivered'"
    },
    read_not_replied: {
        label: "Read, not replied",
        predicate: `cm.status = 'read' AND NOT EXISTS (
            SELECT 1
            FROM messages inbound
            WHERE inbound.project_id = cm.project_id
              AND inbound.number = cm.number
              AND inbound.type = 'in'
              AND inbound.create_date > cm.send_date
        )`
    },
    clicked: {
        label: "Clicked (interactive reply)",
        predicate: `(
            EXISTS (
                SELECT 1
                FROM campaign_message_clicks click_event
                WHERE click_event.project_id = cm.project_id
                  AND click_event.campaign_id = cm.campaign_id
                  AND click_event.phone = cm.number
                  AND click_event.create_date >= cm.send_date
            )
            OR EXISTS (
                SELECT 1
                FROM messages interaction
                WHERE interaction.project_id = cm.project_id
                  AND interaction.number = cm.number
                  AND interaction.type = 'in'
                  AND interaction.message_type = 'interactive'
                  AND interaction.reply_wamid = cm.wamid
            )
        )`
    },
    failed: {
        label: "Failed",
        predicate: "cm.status = 'failed'"
    }
});

export function getRetargetAudience(audience) {
    return RETARGET_AUDIENCES[String(audience || "").trim()] || null;
}

export function buildRetargetAudienceQuery(audience) {
    const definition = getRetargetAudience(audience);
    if (!definition) return null;

    return {
        ...definition,
        sql: `SELECT DISTINCT cm.number
            FROM campaign_messages cm
            LEFT JOIN campaign_suppressions suppression
                ON suppression.project_id = cm.project_id
                AND suppression.phone = cm.number
            WHERE cm.project_id = ?
              AND cm.campaign_id = ?
              AND cm.number IS NOT NULL
              AND TRIM(cm.number) <> ''
              AND suppression.phone IS NULL
              AND ${definition.predicate}`
    };
}

export function normalizeSuppressionPhone(phone) {
    return String(phone || "").replace(/\D/g, "");
}

export function getConsentCommand(message) {
    const command = String(message || "")
        .trim()
        .toUpperCase()
        .replace(/[.!?]+$/, "")
        .trim();

    if (["STOP", "STOP ALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(command)) {
        return "opt_out";
    }
    if (["START", "UNSTOP"].includes(command)) {
        return "opt_in";
    }
    return null;
}
