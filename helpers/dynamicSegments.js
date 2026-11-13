const MAX_TREE_DEPTH = 8;
const MAX_FILTERS = 50;
const MAX_TEXT_LENGTH = 2000;

const BUILT_IN_FIELDS = new Set([
    "name",
    "number",
    "email",
    "firm_name",
    "website",
    "remark",
    "origin",
    "create_date",
]);
const VALUE_OPERATORS = new Set(["eq", "not_eq", "contains", "not_contains", "gt", "gte", "lt", "lte"]);
const EMPTY_OPERATORS = new Set(["is_empty", "is_not_empty"]);
const SEGMENT_ORIGINS = new Set(["manual", "import", "campaign", "api", "whatsapp", "qr"]);
const CAMPAIGN_STATUSES = new Set(["pending", "sent", "delivered", "read", "failed"]);

function isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export class SegmentValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "SegmentValidationError";
    }
}

export function normalizeSegmentName(value) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > 100) {
        throw new SegmentValidationError("Segment name must contain 1 to 100 characters");
    }
    return value.trim();
}

export function normalizeSegmentDefinition(input) {
    let nodeCount = 0;
    const visit = (node, depth) => {
        if (!node || typeof node !== "object" || Array.isArray(node)) {
            throw new SegmentValidationError("Each filter must be an object");
        }
        nodeCount += 1;
        if (nodeCount > MAX_FILTERS) throw new SegmentValidationError("A segment can contain at most 50 filters");
        if (depth > MAX_TREE_DEPTH) throw new SegmentValidationError("Filter groups cannot be nested more than 8 levels");

        if (node.type === "group" || Array.isArray(node.children)) {
            const operator = String(node.operator || "").toUpperCase();
            if (!["AND", "OR"].includes(operator) || !Array.isArray(node.children) || node.children.length === 0) {
                throw new SegmentValidationError("Filter groups require AND or OR and at least one child");
            }
            return {
                type: "group",
                operator,
                children: node.children.map((child) => visit(child, depth + 1)),
            };
        }

        const type = node.type;
        if (type === "attribute") {
            const field = typeof node.field === "string" ? node.field : "";
            const fieldId = typeof node.field_id === "string" ? node.field_id.trim() : "";
            if (!BUILT_IN_FIELDS.has(field) && !(field === "custom" && fieldId && fieldId.length <= 100)) {
                throw new SegmentValidationError("Attribute filters require a supported field or custom field id");
            }
            if (field !== "custom" && fieldId) {
                throw new SegmentValidationError("Only custom attribute filters may specify a field id");
            }
            const operator = String(node.operator || "");
            if (!VALUE_OPERATORS.has(operator) && !EMPTY_OPERATORS.has(operator)) {
                throw new SegmentValidationError("Attribute filter operator is invalid");
            }
            if (EMPTY_OPERATORS.has(operator)) return { type, field, ...(fieldId ? { field_id: fieldId } : {}), operator };
            const value = node.value;
            if ((typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
                String(value).length > MAX_TEXT_LENGTH) {
                throw new SegmentValidationError("Attribute filter value must be text, a number, or a boolean up to 2000 characters");
            }
            if (["contains", "not_contains"].includes(operator) && !String(value).trim()) {
                throw new SegmentValidationError("Contains filters require a non-empty value");
            }
            return { type, field, ...(fieldId ? { field_id: fieldId } : {}), operator, value: typeof value === "boolean" ? String(value) : value };
        }

        if (type === "tag") {
            const tagId = String(node.tag_id || "").trim();
            if (!tagId || tagId.length > 100 || !["has", "not_has"].includes(node.operator)) {
                throw new SegmentValidationError("Tag filters require a valid tag id and has/not_has operator");
            }
            return { type, tag_id: tagId, operator: node.operator };
        }

        if (type === "opt_in") {
            if (typeof node.value !== "boolean") throw new SegmentValidationError("Opt-in filter value must be a boolean");
            return { type, value: node.value };
        }

        if (type === "last_inbound") {
            if (!["has", "never", "within_days", "older_than_days"].includes(node.operator)) {
                throw new SegmentValidationError("Last-inbound filter operator is invalid");
            }
            if (["within_days", "older_than_days"].includes(node.operator) &&
                (!Number.isInteger(node.days) || node.days < 1 || node.days > 3650)) {
                throw new SegmentValidationError("Last-inbound days must be an integer from 1 to 3650");
            }
            return {
                type,
                operator: node.operator,
                ...(["within_days", "older_than_days"].includes(node.operator) ? { days: node.days } : {}),
            };
        }

        if (type === "campaign_status") {
            const campaignId = String(node.campaign_id || "").trim();
            if (!campaignId || campaignId.length > 100 || !CAMPAIGN_STATUSES.has(node.status)) {
                throw new SegmentValidationError("Campaign-status filters require a campaign id and supported status");
            }
            return { type, campaign_id: campaignId, status: node.status };
        }

        if (type === "case") {
            if (!["open", "closed", "has", "none"].includes(node.status)) {
                throw new SegmentValidationError("Case status must be open, closed, has, or none");
            }
            return { type, status: node.status };
        }

        if (type === "origin") {
            if (!SEGMENT_ORIGINS.has(node.value)) throw new SegmentValidationError("Contact origin is not supported");
            return { type, value: node.value };
        }

        throw new SegmentValidationError("Filter type is not supported");
    };

    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new SegmentValidationError("Segment definition must be a filter group");
    }
    const normalized = visit(input, 1);
    if (normalized.type !== "group") throw new SegmentValidationError("Segment definition root must be a filter group");
    return normalized;
}

export function collectSegmentReferences(definition) {
    const references = { tagIds: new Set(), fieldIds: new Set(), campaignIds: new Set() };
    const visit = (node) => {
        if (node.type === "group") {
            node.children.forEach(visit);
        } else if (node.type === "tag") {
            references.tagIds.add(node.tag_id);
        } else if (node.type === "campaign_status") {
            references.campaignIds.add(node.campaign_id);
        } else if (node.type === "attribute" && node.field === "custom") {
            references.fieldIds.add(node.field_id);
        }
    };
    visit(definition);
    return references;
}

function compileAttribute(node, customFieldIds, params) {
    const { operator } = node;
    if (node.field === "custom") {
        const customFieldType = customFieldIds instanceof Map
            ? customFieldIds.get(node.field_id)
            : customFieldIds.has(node.field_id) ? "text" : null;
        if (!customFieldType) {
            throw new SegmentValidationError("Custom field is not active in this project");
        }
        if (customFieldType === "number" && ["gt", "gte", "lt", "lte"].includes(operator) &&
            (!String(node.value).trim() || !Number.isFinite(Number(node.value)))) {
            throw new SegmentValidationError("Numeric custom-field comparisons require a finite number");
        }
        if (customFieldType === "date" && ["gt", "gte", "lt", "lte"].includes(operator) &&
            !isValidDate(node.value)) {
            throw new SegmentValidationError("Date custom-field comparisons require a YYYY-MM-DD value");
        }
        const comparison = {
            eq: "cv.field_value = ?",
            not_eq: "cv.field_value = ?",
            contains: "LOCATE(?, cv.field_value) > 0",
            not_contains: "LOCATE(?, cv.field_value) > 0",
            gt: `${customFieldType === "number" ? "CAST(cv.field_value AS DECIMAL(20,6))" : "cv.field_value"} > ?`,
            gte: `${customFieldType === "number" ? "CAST(cv.field_value AS DECIMAL(20,6))" : "cv.field_value"} >= ?`,
            lt: `${customFieldType === "number" ? "CAST(cv.field_value AS DECIMAL(20,6))" : "cv.field_value"} < ?`,
            lte: `${customFieldType === "number" ? "CAST(cv.field_value AS DECIMAL(20,6))" : "cv.field_value"} <= ?`,
        };
        const empty = operator === "is_empty" || operator === "is_not_empty";
        const predicate = empty
            ? "TRIM(cv.field_value) <> ''"
            : comparison[operator];
        params.push(node.field_id);
        if (!empty) params.push(node.value);
        const exists = `EXISTS (
            SELECT 1
            FROM crm_custom_field_values cv
            INNER JOIN crm_custom_fields cf
                ON cf.project_id = cv.project_id AND cf.field_id = cv.field_id AND cf.is_deleted = 0
            WHERE cv.project_id = c.project_id AND cv.contact_id = c.contact_id
              AND cv.field_id = ? AND ${predicate}
        )`;
        return operator === "not_eq" || operator === "not_contains" || operator === "is_empty"
            ? `NOT ${exists}`
            : exists;
    }

    const column = `c.${node.field}`;
    if (operator === "is_empty") return `(${column} IS NULL OR TRIM(CAST(${column} AS CHAR)) = '')`;
    if (operator === "is_not_empty") return `(${column} IS NOT NULL AND TRIM(CAST(${column} AS CHAR)) <> '')`;
    const sqlOperator = {
        eq: "=",
        not_eq: "<>",
        gt: ">",
        gte: ">=",
        lt: "<",
        lte: "<=",
    }[operator];
    if (operator === "contains" || operator === "not_contains") {
        params.push(String(node.value));
        const contains = `LOCATE(?, COALESCE(CAST(${column} AS CHAR), '')) > 0`;
        return operator === "not_contains" ? `NOT (${contains})` : contains;
    }
    params.push(node.value);
    return operator === "not_eq"
        ? `(${column} IS NULL OR ${column} ${sqlOperator} ?)`
        : `${column} ${sqlOperator} ?`;
}

function compileNode(node, customFieldIds, params) {
    if (node.type === "group") {
        const joiner = node.operator === "AND" ? " AND " : " OR ";
        return `(${node.children.map((child) => compileNode(child, customFieldIds, params)).join(joiner)})`;
    }
    if (node.type === "attribute") return compileAttribute(node, customFieldIds, params);
    if (node.type === "tag") {
        params.push(node.tag_id);
        const exists = `EXISTS (
            SELECT 1 FROM contact_tag_mapping ctm
            INNER JOIN crm_tags t ON t.project_id = ctm.project_id AND t.tag_id = ctm.tag_id AND t.is_deleted = 0
            WHERE ctm.project_id = c.project_id AND ctm.contact_id = c.contact_id
              AND ctm.tag_id = ? AND ctm.is_deleted = 0
        )`;
        return node.operator === "not_has" ? `NOT ${exists}` : exists;
    }
    if (node.type === "opt_in") {
        const exists = `EXISTS (
            SELECT 1 FROM campaign_suppressions cs
            WHERE cs.project_id = c.project_id AND cs.phone = c.number
        )`;
        return node.value ? `NOT ${exists}` : exists;
    }
    if (node.type === "last_inbound") {
        if (node.operator === "never" || node.operator === "has") {
            const exists = `EXISTS (
                SELECT 1 FROM messages inbound
                WHERE inbound.project_id = c.project_id AND inbound.number = c.number AND inbound.type = 'in'
            )`;
            return node.operator === "never" ? `NOT ${exists}` : exists;
        }
        params.push(node.days);
        const comparison = node.operator === "within_days" ? ">=" : "<";
        return `EXISTS (
            SELECT 1 FROM messages inbound
            WHERE inbound.project_id = c.project_id AND inbound.number = c.number AND inbound.type = 'in'
              AND inbound.create_date ${comparison} DATE_SUB(NOW(), INTERVAL ? DAY)
        )`;
    }
    if (node.type === "campaign_status") {
        params.push(node.campaign_id, node.status);
        return `EXISTS (
            SELECT 1 FROM campaign_messages cm
            WHERE cm.project_id = c.project_id AND cm.number = c.number
              AND cm.campaign_id = ? AND cm.status = ?
        )`;
    }
    if (node.type === "case") {
        if (node.status === "has" || node.status === "none") {
            const exists = `EXISTS (
                SELECT 1 FROM cases ca
                WHERE ca.project_id = c.project_id AND ca.number = c.number
            )`;
            return node.status === "none" ? `NOT ${exists}` : exists;
        }
        params.push(node.status === "open" ? "0" : "1");
        return `EXISTS (
            SELECT 1 FROM cases ca
            WHERE ca.project_id = c.project_id AND ca.number = c.number AND ca.status = ?
        )`;
    }
    if (node.type === "origin") {
        if (node.value === "whatsapp") {
            return `EXISTS (
                SELECT 1 FROM messages inbound
                WHERE inbound.project_id = c.project_id AND inbound.number = c.number AND inbound.type = 'in'
            )`;
        }
        if (node.value === "qr") {
            return `EXISTS (
                SELECT 1 FROM qr_scanned_users scan
                WHERE scan.project_id = c.project_id AND scan.mobile = c.number AND scan.status = '1'
            )`;
        }
        params.push(node.value);
        return "c.origin = ?";
    }
    throw new SegmentValidationError("Filter type is not supported");
}

export function buildSegmentRecipientQuery(definition, {
    projectId,
    customFieldIds = new Set(),
    contactNumber,
    countOnly = false,
    limit,
    offset = 0,
}) {
    const normalized = normalizeSegmentDefinition(definition);
    if (!countOnly && limit !== undefined &&
        (!Number.isInteger(limit) || limit < 1 || limit > 100 ||
            !Number.isInteger(offset) || offset < 0)) {
        throw new SegmentValidationError("Segment contact pagination is invalid");
    }
    const params = [projectId];
    const numberFilter = contactNumber === undefined ? "" : " AND c.number = ?";
    if (contactNumber !== undefined) params.push(contactNumber);
    const predicate = compileNode(normalized, customFieldIds, params);
    const pagination = !countOnly && limit !== undefined ? "LIMIT ? OFFSET ?" : "";
    if (pagination) params.push(limit, offset);
    return {
        sql: `${countOnly
            ? "SELECT COUNT(*) AS count"
            : "SELECT c.id, c.contact_id, c.number, c.name, c.email, c.firm_name, c.website, c.remark, c.origin"}
              FROM contacts c
              WHERE c.project_id = ? AND c.is_deleted = '0'
                AND c.number IS NOT NULL AND TRIM(c.number) <> ''${numberFilter} AND ${predicate}
              ${countOnly ? "" : `ORDER BY c.id ASC ${pagination}`}`,
        params,
    };
}

export async function validateSegmentReferences(connection, projectId, definition) {
    const references = collectSegmentReferences(normalizeSegmentDefinition(definition));
    const assertProjectIds = async (ids, sql, label) => {
        const values = [...ids];
        if (values.length === 0) return;
        const [rows] = await connection.query(sql, [projectId, values]);
        if (rows.length !== values.length) throw new SegmentValidationError(`One or more ${label} are not active in this project`);
    };

    await assertProjectIds(
        references.tagIds,
        "SELECT tag_id FROM crm_tags WHERE project_id = ? AND tag_id IN (?) AND is_deleted = 0",
        "tags"
    );
    await assertProjectIds(
        references.campaignIds,
        "SELECT campaign_id FROM campaigns WHERE project_id = ? AND campaign_id IN (?) AND is_deleted = '0'",
        "campaigns"
    );

    let customFieldIds = new Set();
    if (references.fieldIds.size > 0) {
        const [rows] = await connection.query(
            "SELECT field_id, field_type FROM crm_custom_fields WHERE project_id = ? AND field_id IN (?) AND is_deleted = 0",
            [projectId, [...references.fieldIds]]
        );
        if (rows.length !== references.fieldIds.size) {
            throw new SegmentValidationError("One or more custom fields are not active in this project");
        }
        customFieldIds = new Map(rows.map((row) => [String(row.field_id), row.field_type]));
    }
    return customFieldIds;
}

export async function resolveSegmentRecipients(connection, projectId, definition) {
    const normalized = normalizeSegmentDefinition(definition);
    const customFieldIds = await validateSegmentReferences(connection, projectId, normalized);
    const query = buildSegmentRecipientQuery(normalized, { projectId, customFieldIds });
    const [rows] = await connection.query(query.sql, query.params);
    return rows;
}

export async function isContactInDynamicSegment(connection, projectId, segmentId, number) {
    const [rows] = await connection.query(
        "SELECT definition_json FROM dynamic_segments WHERE project_id = ? AND segment_id = ? AND is_deleted = 0 LIMIT 1",
        [projectId, segmentId]
    );
    if (rows.length === 0) return false;
    const definition = typeof rows[0].definition_json === "string"
        ? JSON.parse(rows[0].definition_json)
        : rows[0].definition_json;
    const normalized = normalizeSegmentDefinition(definition);
    const customFieldIds = await validateSegmentReferences(connection, projectId, normalized);
    const query = buildSegmentRecipientQuery(normalized, { projectId, customFieldIds, contactNumber: number });
    const [matches] = await connection.query(
        `SELECT 1 FROM (${query.sql}) AS segment_contacts LIMIT 1`,
        query.params
    );
    return matches.length > 0;
}
