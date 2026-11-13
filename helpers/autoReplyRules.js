const RULE_TYPES = new Set(["keyword", "welcome", "away"]);
const MATCH_TYPES = new Set(["contains", "exact", "startsWith", "endsWith"]);
const MAX_REPLY_LENGTH = 4096;

export class RuleValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = "RuleValidationError";
    }
}

function isValidTimezone(timezone) {
    try {
        new Intl.DateTimeFormat("en-US", { timeZone: timezone });
        return true;
    } catch {
        return false;
    }
}

function parseTime(value) {
    if (typeof value !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
        return null;
    }
    const [hours, minutes] = value.split(":").map(Number);
    return hours * 60 + minutes;
}

function normalizeKeywords(value) {
    const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
    if ((Array.isArray(value) && value.length > 20) ||
        (typeof value === "string" && value.length > 2579)) {
        throw new RuleValidationError("A rule can contain at most 20 keywords");
    }
    if (values.some((keyword) => typeof keyword !== "string")) {
        throw new RuleValidationError("Keywords must be text");
    }
    const keywords = [...new Set(values.map((keyword) => keyword.trim()).filter(Boolean))];
    if (keywords.length > 20) {
        throw new RuleValidationError("A rule can contain at most 20 keywords");
    }
    if (keywords.some((keyword) => keyword.length > 128)) {
        throw new RuleValidationError("Keywords must be 128 characters or fewer");
    }
    return keywords;
}

export function normalizeRuleInput(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new RuleValidationError("Rule must be an object");
    }

    const ruleType = input.ruleType || input.rule_type || "keyword";
    if (!RULE_TYPES.has(ruleType)) {
        throw new RuleValidationError("Rule type must be keyword, welcome, or away");
    }

    const rawName = typeof input.name === "string" ? input.name : "";
    if (rawName.length > 120) {
        throw new RuleValidationError("Rule name must be 120 characters or fewer");
    }
    const name = rawName.trim();
    if (!name) {
        throw new RuleValidationError("Rule name is required and must be 120 characters or fewer");
    }

    const reply = input.response ?? input.replyText ?? input.replyPayload ?? input.reply_payload;
    if (typeof reply === "string" && reply.length > MAX_REPLY_LENGTH) {
        throw new RuleValidationError(`Reply text must be ${MAX_REPLY_LENGTH} characters or fewer`);
    }
    if (reply && typeof reply === "object" && typeof reply.text === "string" && reply.text.length > MAX_REPLY_LENGTH) {
        throw new RuleValidationError(`Reply text must be ${MAX_REPLY_LENGTH} characters or fewer`);
    }
    let response = reply;
    if (reply && typeof reply === "object") {
        if (reply.type !== "text" || typeof reply.text !== "string") {
            throw new RuleValidationError("Only text reply payloads are currently supported");
        }
        response = reply.text;
    } else if (typeof reply === "string") {
        try {
            const parsed = JSON.parse(reply);
            if (parsed && typeof parsed === "object" && parsed.type === "text") {
                response = parsed.text;
            }
        } catch {
            response = reply;
        }
    }
    response = typeof response === "string" ? response.trim() : "";
    if (!response || response.length > MAX_REPLY_LENGTH) {
        throw new RuleValidationError(`Reply text is required and must be ${MAX_REPLY_LENGTH} characters or fewer`);
    }

    const keywords = normalizeKeywords(input.keywords);
    if (ruleType === "keyword" && keywords.length === 0) {
        throw new RuleValidationError("At least one keyword is required for a keyword rule");
    }

    const matchType = input.matchType ?? input.match_type ?? "contains";
    if (!MATCH_TYPES.has(matchType)) {
        throw new RuleValidationError("Match type must be contains, exact, startsWith, or endsWith");
    }

    if (input.timezone !== undefined && (typeof input.timezone !== "string" || input.timezone.length > 64 || !input.timezone.trim())) {
        throw new RuleValidationError("Timezone must be a valid IANA timezone of at most 64 characters");
    }
    const timezone = input.timezone === undefined ? "UTC" : input.timezone.trim();
    if (!isValidTimezone(timezone)) {
        throw new RuleValidationError("Timezone must be a valid IANA timezone");
    }

    const ruleDays = input.daysOfWeek ?? input.days_of_week;
    if ((Array.isArray(ruleDays) && ruleDays.length > 7) ||
        (typeof ruleDays === "string" && ruleDays.length > 13)) {
        throw new RuleValidationError("Days of week can contain at most seven values");
    }
    const daysOfWeek = [...new Set(
        (Array.isArray(ruleDays) ? ruleDays : typeof ruleDays === "string" ? ruleDays.split(",") : [])
            .filter((day) => !(typeof day === "string" && day.trim() === ""))
            .map((day) => day === null ? Number.NaN : Number(day))
    )].sort((a, b) => a - b);
    if (daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new RuleValidationError("Days of week must be integers from 0 (Sunday) to 6 (Saturday)");
    }

    for (const field of ["businessHours", "scheduleEnabled"]) {
        if (input[field] !== undefined && typeof input[field] !== "boolean") {
            throw new RuleValidationError(`${field} must be a boolean`);
        }
    }
    const businessHours = ruleType === "away" || input.businessHours === true || input.scheduleEnabled === true;
    const startTime = input.startTime ?? input.start_time ?? null;
    const endTime = input.endTime ?? input.end_time ?? null;
    if (businessHours) {
        const startMinutes = parseTime(startTime);
        const endMinutes = parseTime(endTime);
        if (startMinutes === null || endMinutes === null || startMinutes >= endMinutes) {
            throw new RuleValidationError("Time window must use valid HH:mm times with start earlier than end");
        }
        if (daysOfWeek.length === 0) {
            throw new RuleValidationError("Select at least one day for a scheduled rule");
        }
    }

    const priority = Number(input.priority ?? 1);
    if (!Number.isInteger(priority) || priority < 1 || priority > 10000) {
        throw new RuleValidationError("Priority must be an integer from 1 to 10000");
    }

    const enabled = input.enabled ?? input.is_active ?? true;
    if (typeof enabled !== "boolean" && enabled !== 0 && enabled !== 1) {
        throw new RuleValidationError("Enabled status must be a boolean");
    }

    return {
        name,
        ruleType,
        keywords: ruleType === "keyword" ? keywords : [],
        matchType,
        response,
        timezone,
        daysOfWeek: businessHours ? daysOfWeek : [],
        businessHours,
        startTime: businessHours ? startTime : null,
        endTime: businessHours ? endTime : null,
        priority,
        enabled: enabled === true || enabled === 1,
    };
}

export function mapAutoReplyRule(row) {
    const keywords = Array.isArray(row.keywords) ? row.keywords : JSON.parse(row.keywords || "[]");
    const payload = typeof row.reply_payload === "string" ? JSON.parse(row.reply_payload) : row.reply_payload;
    const response = payload?.type === "text" && typeof payload.text === "string" ? payload.text : "";
    if (!Array.isArray(keywords) || keywords.some((keyword) => typeof keyword !== "string")) {
        throw new Error("Stored auto-reply rule has invalid keywords");
    }
    if (!response.trim()) {
        throw new Error("Stored auto-reply rule has an invalid reply payload");
    }
    if (!RULE_TYPES.has(row.rule_type) || !MATCH_TYPES.has(row.match_type)) {
        throw new Error("Stored auto-reply rule has invalid matching configuration");
    }

    const daysOfWeek = String(row.days_of_week || "")
        .split(",")
        .filter(Boolean)
        .map(Number);
    if (daysOfWeek.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
        throw new Error("Stored auto-reply rule has invalid days of week");
    }
    const businessHours = Number(row.business_hours);
    const triggered = Number(row.triggered_count);
    const enabled = Number(row.is_active);
    const priority = Number(row.priority);
    if (![0, 1].includes(businessHours) || !Number.isSafeInteger(triggered) || triggered < 0 ||
        ![0, 1].includes(enabled) || !Number.isInteger(priority) || priority < 1 || priority > 10000) {
        throw new Error("Stored auto-reply rule has invalid status or trigger count");
    }
    const startTime = row.start_time ? String(row.start_time).slice(0, 5) : null;
    const endTime = row.end_time ? String(row.end_time).slice(0, 5) : null;
    if (businessHours && (daysOfWeek.length === 0 || parseTime(startTime) === null ||
        parseTime(endTime) === null || parseTime(startTime) >= parseTime(endTime))) {
        throw new Error("Stored auto-reply rule has an invalid time window");
    }
    if (row.rule_type === "keyword" && keywords.length === 0) {
        throw new Error("Stored keyword rule does not contain any keywords");
    }
    if (!isValidTimezone(row.timezone)) {
        throw new Error("Stored auto-reply rule has an invalid timezone");
    }
    const lastTriggered = row.last_triggered_at || null;

    return {
        id: row.id,
        uniqueId: row.unique_id,
        name: row.name,
        ruleType: row.rule_type,
        keywords,
        matchType: row.match_type,
        response,
        timezone: row.timezone,
        daysOfWeek,
        businessHours: Boolean(businessHours),
        startTime,
        endTime,
        priority,
        enabled: Boolean(enabled),
        stats: {
            triggered,
            lastTriggered,
        },
        createdAt: row.create_date || null,
        updatedAt: row.modify_date || null,
    };
}

export function incrementAutoReplyRuleTrigger(connection, ruleId, projectId) {
    return connection.query(
        `UPDATE auto_reply_rules
         SET triggered_count = triggered_count + 1, last_triggered_at = UTC_TIMESTAMP()
         WHERE id = ? AND project_id = ?`,
        [ruleId, projectId]
    );
}

export function isScheduleActive(rule, date = new Date()) {
    if (!rule.businessHours) return true;

    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: rule.timezone || "UTC",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
    });
    const parts = Object.fromEntries(formatter.formatToParts(date).map(({ type, value }) => [type, value]));
    const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const localDay = weekdays[parts.weekday];
    const localMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    const startMinutes = parseTime(rule.startTime);
    const endMinutes = parseTime(rule.endTime);

    return rule.daysOfWeek.includes(localDay) && localMinutes >= startMinutes && localMinutes < endMinutes;
}

function matchesKeyword(rule, message) {
    const normalizedMessage = String(message || "").trim().toLocaleLowerCase();
    return rule.keywords.some((keyword) => {
        const normalizedKeyword = String(keyword).trim().toLocaleLowerCase();
        if (!normalizedKeyword) return false;
        switch (rule.matchType) {
            case "exact":
                return normalizedMessage === normalizedKeyword;
            case "startsWith":
                return normalizedMessage.startsWith(normalizedKeyword);
            case "endsWith":
                return normalizedMessage.endsWith(normalizedKeyword);
            default:
                return normalizedMessage.includes(normalizedKeyword);
        }
    });
}

export function selectAutoReplyRule(rules, { message, isFirstMessage, now = new Date() }) {
    const orderedRules = rules
        .map((rule, index) => ({ rule, index }))
        .sort((left, right) =>
            (left.rule.priority ?? 1) - (right.rule.priority ?? 1) ||
            (left.rule.id ?? 0) - (right.rule.id ?? 0) ||
            left.index - right.index
        );

    for (const { rule } of orderedRules) {
        if (rule.enabled === false) continue;
        const inSchedule = isScheduleActive(rule, now);
        if (rule.ruleType === "away" && !inSchedule) return rule;
        if (rule.ruleType === "welcome" && isFirstMessage && inSchedule) return rule;
        if (rule.ruleType === "keyword" && inSchedule && matchesKeyword(rule, message)) return rule;
    }
    return null;
}