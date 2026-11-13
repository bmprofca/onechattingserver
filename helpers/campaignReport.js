const MAX_REPORT_LIMIT = 100;
const MAX_REPORT_PAGE = 100000;

function isValidDate(value) {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year
        && date.getUTCMonth() === month - 1
        && date.getUTCDate() === day;
}

export function parseCampaignReportRequest(payload = {}) {
    const projectId = typeof payload.project_id === "string" ? payload.project_id.trim() : "";
    if (!projectId) return { error: "Project id is required." };

    const from = payload.from || "";
    const to = payload.to || "";
    if (Boolean(from) !== Boolean(to)) {
        return { error: "Both start and end dates are required." };
    }
    if ((from && !isValidDate(from)) || (to && !isValidDate(to))) {
        return { error: "Dates must be valid YYYY-MM-DD values." };
    }
    if (from && from > to) {
        return { error: "Start date must be on or before end date." };
    }

    const page = payload.page === undefined ? 1 : Number(payload.page);
    const limit = payload.limit === undefined ? 25 : Number(payload.limit);
    const cursor = payload.cursor === undefined || payload.cursor === null || payload.cursor === ""
        ? null
        : Number(payload.cursor);
    const snapshotId = payload.snapshot_id === undefined || payload.snapshot_id === null || payload.snapshot_id === ""
        ? null
        : Number(payload.snapshot_id);

    if (!Number.isSafeInteger(page) || page < 1 || page > MAX_REPORT_PAGE) {
        return { error: "Page must be a positive integer." };
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_REPORT_LIMIT) {
        return { error: `Limit must be between 1 and ${MAX_REPORT_LIMIT}.` };
    }
    if (cursor !== null && (!Number.isSafeInteger(cursor) || cursor < 1)) {
        return { error: "Cursor must be a positive integer." };
    }
    if (snapshotId !== null && (!Number.isSafeInteger(snapshotId) || snapshotId < 1)) {
        return { error: "Snapshot id must be a positive integer." };
    }

    return { projectId, from, to, page, limit, cursor, snapshotId };
}

export function buildCampaignReportScope({ projectId, from, to, snapshotId }) {
    const clauses = ["cm.project_id = ?"];
    const params = [projectId];
    if (from) {
        clauses.push("cm.create_date >= ?", "cm.create_date < DATE_ADD(?, INTERVAL 1 DAY)");
        params.push(from, to);
    }
    if (snapshotId !== null) {
        clauses.push("cm.id <= ?");
        params.push(snapshotId);
    }
    return { where: clauses.join(" AND "), params };
}

export function buildCampaignReportRowsQuery({ scope, cursor, limit }) {
    const clauses = [scope.where];
    const params = [...scope.params];
    if (cursor !== null) {
        clauses.push("cm.id < ?");
        params.push(cursor);
    }
    params.push(limit + 1);
    return {
        sql: `SELECT cm.id, c.name AS campaign_name, cm.number AS recipient, cm.status,
                     cm.template_name, cm.create_date
              FROM campaign_messages cm
              LEFT JOIN campaigns c
                ON c.project_id = cm.project_id AND c.campaign_id = cm.campaign_id
              WHERE ${clauses.join(" AND ")}
              ORDER BY cm.id DESC
              LIMIT ?`,
        params
    };
}
