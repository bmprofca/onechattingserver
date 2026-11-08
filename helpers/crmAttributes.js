export const CUSTOM_FIELD_TYPES = new Set(["text", "number", "date", "boolean", "select"]);

export function normalizeCustomFieldDefinition(input = {}) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    const field_type = typeof input.field_type === "string" ? input.field_type.trim().toLowerCase() : "";
    if (!name || name.length > 120) {
        throw new Error("Field name must contain 1 to 120 characters");
    }
    if (!CUSTOM_FIELD_TYPES.has(field_type)) {
        throw new Error("Field type must be text, number, date, boolean, or select");
    }

    const options = field_type === "select" ? normalizeSelectOptions(input.options) : [];
    return { name, field_type, options };
}

export function normalizeSelectOptions(rawOptions) {
    if (!Array.isArray(rawOptions)) {
        throw new Error("Select fields require an options array");
    }
    if (rawOptions.some((option) => typeof option !== "string")) {
        throw new Error("Select field options must be text");
    }
    const options = Array.from(new Set(rawOptions.map((option) => option.trim()).filter(Boolean)));
    if (options.length < 1 || options.length > 100 || options.some((option) => option.length > 120)) {
        throw new Error("Select fields require 1 to 100 options of at most 120 characters");
    }
    return options;
}

export function makeCustomFieldKey(name) {
    const key = String(name || "")
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80);
    if (!key) throw new Error("Field name must include a letter or number");
    const reservedKeys = new Set([
        "id", "project_id", "contact_id", "name", "number", "email", "firm_name",
        "website", "remark", "tags", "groups", "group_id", "group_ids", "custom_attributes",
        "custom_attribute_values", "assign_to_me", "is_favorite", "create_date",
        "modify_date", "create_by", "modify_by", "delete_by", "is_deleted",
        "language_code", "country"
    ]);
    if (reservedKeys.has(key)) {
        throw new Error("Field name conflicts with a built-in contact field");
    }
    return key;
}

function normalizeFieldValue(field, rawValue) {
    if (rawValue === null || rawValue === undefined || rawValue === "") return null;

    switch (field.field_type) {
        case "text": {
            if (typeof rawValue !== "string" && typeof rawValue !== "number") {
                throw new Error("must be text");
            }
            const value = String(rawValue);
            if (value.length > 2000) throw new Error("must be at most 2000 characters");
            return value;
        }
        case "number": {
            const value = String(rawValue).trim();
            if (!value || !Number.isFinite(Number(value))) throw new Error("must be a valid number");
            return value;
        }
        case "date": {
            const value = String(rawValue);
            const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
            if (!match) throw new Error("must be a date in YYYY-MM-DD format");
            const date = new Date(`${value}T00:00:00.000Z`);
            if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
                throw new Error("must be a valid calendar date");
            }
            return value;
        }
        case "boolean": {
            if (rawValue === true || rawValue === 1 || rawValue === "1" || rawValue === "true") return "true";
            if (rawValue === false || rawValue === 0 || rawValue === "0" || rawValue === "false") return "false";
            throw new Error("must be true or false");
        }
        case "select": {
            const value = String(rawValue);
            if (!field.options.includes(value)) throw new Error("is not an available option");
            return value;
        }
        default:
            throw new Error("has an unsupported field type");
    }
}

export function validateCustomAttributeValues(fields, values) {
    if (values === undefined) return { values: [], errors: [] };
    if (!values || typeof values !== "object" || Array.isArray(values)) {
        return { values: [], errors: [{ field_id: null, error: "Custom attributes must be an object" }] };
    }

    const fieldMap = new Map(fields.map((field) => [String(field.field_id), field]));
    const normalized = [];
    const errors = [];
    for (const [fieldId, rawValue] of Object.entries(values)) {
        const field = fieldMap.get(String(fieldId));
        if (!field) {
            errors.push({ field_id: fieldId, error: "Unknown or inactive custom field" });
            continue;
        }
        try {
            normalized.push({ field_id: field.field_id, value: normalizeFieldValue(field, rawValue) });
        } catch (error) {
            errors.push({ field_id: fieldId, error: `${field.name}: ${error.message}` });
        }
    }
    return { values: normalized, errors };
}
