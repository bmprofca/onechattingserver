import test from "node:test";
import assert from "node:assert/strict";
import {
    incrementAutoReplyRuleTrigger,
    isScheduleActive,
    mapAutoReplyRule,
    normalizeRuleInput,
    selectAutoReplyRule,
} from "../helpers/autoReplyRules.js";

const validKeyword = {
    name: "Sales",
    ruleType: "keyword",
    keywords: ["Price"],
    matchType: "contains",
    response: "Here is our price list",
    timezone: "Asia/Kolkata",
    enabled: true,
};

test("normalizes valid keyword rules and rejects invalid time windows", () => {
    const rule = normalizeRuleInput(validKeyword);
    assert.equal(rule.ruleType, "keyword");
    assert.deepEqual(rule.keywords, ["Price"]);
    assert.throws(() => normalizeRuleInput({
        ...validKeyword,
        businessHours: true,
        daysOfWeek: [1, 2],
        startTime: "17:00",
        endTime: "09:00",
    }), /start earlier than end/);
});

test("requires valid project-local schedules for away rules", () => {
    assert.throws(() => normalizeRuleInput({
        ...validKeyword,
        ruleType: "away",
        keywords: [],
        timezone: "Not/AZone",
        daysOfWeek: [1, 2, 3],
        startTime: "09:00",
        endTime: "17:00",
    }), /IANA timezone/);

    const away = normalizeRuleInput({
        ...validKeyword,
        ruleType: "away",
        keywords: [],
        timezone: "Asia/Kolkata",
        daysOfWeek: [1, 2, 3, 4, 5],
        startTime: "09:00",
        endTime: "17:00",
    });
    assert.equal(away.businessHours, true);
});

test("evaluates schedule boundaries and weekdays in the rule timezone", () => {
    const rule = {
        businessHours: true,
        timezone: "Asia/Kolkata",
        daysOfWeek: [1],
        startTime: "09:00",
        endTime: "17:00",
    };
    assert.equal(isScheduleActive(rule, new Date("2026-11-02T03:30:00Z")), true);
    assert.equal(isScheduleActive(rule, new Date("2026-11-02T03:29:00Z")), false);
    assert.equal(isScheduleActive(rule, new Date("2026-11-02T11:30:00Z")), false);
    assert.equal(isScheduleActive(rule, new Date("2026-11-03T03:30:00Z")), false);
});

test("selects the first priority-ordered eligible rule with exact matching", () => {
    const rules = [
        { ruleType: "welcome", businessHours: false },
        {
            ruleType: "keyword",
            keywords: ["pricing"],
            matchType: "exact",
            businessHours: false,
        },
    ];
    assert.equal(
        selectAutoReplyRule(rules, { message: "PRICING", isFirstMessage: false })?.ruleType,
        "keyword"
    );
    assert.equal(
        selectAutoReplyRule(rules, { message: "pricing please", isFirstMessage: false }),
        null
    );
    assert.equal(
        selectAutoReplyRule(rules, { message: "hello", isFirstMessage: true })?.ruleType,
        "welcome"
    );
});

test("away rules are selected outside their configured timezone schedule", () => {
    const away = {
        ruleType: "away",
        businessHours: true,
        timezone: "Asia/Kolkata",
        daysOfWeek: [1, 2, 3, 4, 5],
        startTime: "09:00",
        endTime: "17:00",
    };
    assert.equal(
        selectAutoReplyRule([away], {
            message: "help",
            isFirstMessage: false,
            now: new Date("2026-11-02T13:00:00Z"),
        }),
        away
    );
    assert.equal(
        selectAutoReplyRule([away], {
            message: "help",
            isFirstMessage: false,
            now: new Date("2026-11-02T05:00:00Z"),
        }),
        null
    );
});

test("increments trigger counters atomically and within the project", async () => {
    let captured;
    await incrementAutoReplyRuleTrigger({
        query: async (...args) => { captured = args; },
    }, 17, "project-a");

    assert.match(captured[0], /triggered_count = triggered_count \+ 1/);
    assert.match(captured[0], /WHERE id = \? AND project_id = \?/);
    assert.deepEqual(captured[1], [17, "project-a"]);
});

test("maps persisted rows and surfaces malformed stored rule data", () => {
    const mapped = mapAutoReplyRule({
        id: 8,
        unique_id: "rule-8",
        name: "Pricing",
        rule_type: "keyword",
        keywords: '["price"]',
        match_type: "contains",
        reply_payload: '{"type":"text","text":"Pricing details"}',
        timezone: "UTC",
        days_of_week: "",
        business_hours: 0,
        start_time: null,
        end_time: null,
        priority: 1,
        is_active: 1,
        triggered_count: 12,
    });
    assert.equal(mapped.stats.triggered, 12);
    assert.equal(mapped.response, "Pricing details");
    assert.throws(() => mapAutoReplyRule({
        id: 9,
        unique_id: "rule-9",
        name: "Bad",
        rule_type: "away",
        keywords: "[]",
        match_type: "contains",
        reply_payload: '{"type":"text","text":"Away"}',
        timezone: "UTC",
        days_of_week: "",
        business_hours: 1,
        start_time: "09:00:00",
        end_time: "17:00:00",
        priority: 1,
        is_active: 1,
        triggered_count: 0,
    }), /invalid time window/);
});
