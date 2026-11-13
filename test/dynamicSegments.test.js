import test from "node:test";
import assert from "node:assert/strict";
import {
    buildSegmentRecipientQuery,
    collectSegmentReferences,
    isContactInDynamicSegment,
    normalizeSegmentDefinition,
    normalizeSegmentName,
    validateSegmentReferences,
} from "../helpers/dynamicSegments.js";

test("normalizes AND/OR trees and rejects malformed or oversized filters", () => {
    const definition = normalizeSegmentDefinition({
        operator: "and",
        children: [
            { type: "attribute", field: "name", operator: "contains", value: "Asha" },
            {
                type: "group",
                operator: "OR",
                children: [
                    { type: "tag", tag_id: "tag-1", operator: "has" },
                    { type: "opt_in", value: true },
                ],
            },
        ],
    });

    assert.equal(definition.operator, "AND");
    assert.throws(() => normalizeSegmentDefinition({ operator: "XOR", children: [] }));
    assert.throws(() => normalizeSegmentDefinition({
        operator: "AND",
        children: [{ type: "attribute", field: "project_id; DROP TABLE contacts", operator: "eq", value: "x" }],
    }));
    assert.throws(() => normalizeSegmentDefinition({
        operator: "AND",
        children: [{ type: "last_inbound", operator: "within_days", days: 0 }],
    }));
    assert.throws(() => normalizeSegmentDefinition({
        operator: "AND",
        children: [{ type: "attribute", field: "name", operator: "contains", value: "  " }],
    }), /non-empty value/);
    assert.throws(() => normalizeSegmentName("  "));
});

test("collects project-scoped tag, custom-field, and campaign references", () => {
    const definition = normalizeSegmentDefinition({
        operator: "AND",
        children: [
            { type: "tag", tag_id: "tag-a", operator: "has" },
            { type: "attribute", field: "custom", field_id: "field-a", operator: "eq", value: "Gold" },
            { type: "campaign_status", campaign_id: "campaign-a", status: "read" },
        ],
    });
    const references = collectSegmentReferences(definition);

    assert.deepEqual([...references.tagIds], ["tag-a"]);
    assert.deepEqual([...references.fieldIds], ["field-a"]);
    assert.deepEqual([...references.campaignIds], ["campaign-a"]);
});

test("builds parameterized project-scoped recipient queries for supported sources", () => {
    const definition = {
        operator: "AND",
        children: [
            { type: "attribute", field: "name", operator: "contains", value: "x' OR 1=1 --" },
            { type: "tag", tag_id: "tag-1", operator: "has" },
            { type: "opt_in", value: true },
            { type: "last_inbound", operator: "within_days", days: 30 },
            { type: "campaign_status", campaign_id: "campaign-1", status: "delivered" },
            { type: "case", status: "open" },
            { type: "origin", value: "import" },
            { type: "attribute", field: "custom", field_id: "field-1", operator: "eq", value: "Gold" },
        ],
    };
    const query = buildSegmentRecipientQuery(definition, {
        projectId: "project-a",
        customFieldIds: new Set(["field-1"]),
    });

    assert.match(query.sql, /c\.project_id = \?/);
    assert.match(query.sql, /c\.is_deleted = '0'/);
    assert.match(query.sql, /contact_tag_mapping/);
    assert.match(query.sql, /campaign_suppressions/);
    assert.match(query.sql, /messages inbound/);
    assert.match(query.sql, /campaign_messages cm/);
    assert.match(query.sql, /cases ca/);
    assert.match(query.sql, /c\.origin = \?/);
    assert.match(query.sql, /crm_custom_field_values/);
    assert.equal(query.sql.includes("x' OR 1=1 --"), false);
    assert.match(query.sql, /c\.number IS NOT NULL AND TRIM\(c\.number\) <> ''/);
    assert.deepEqual(query.params, [
        "project-a",
        "x' OR 1=1 --",
        "tag-1",
        30,
        "campaign-1",
        "delivered",
        "0",
        "import",
        "field-1",
        "Gold",
    ]);

    const countQuery = buildSegmentRecipientQuery(definition, {
        projectId: "project-a",
        customFieldIds: new Set(["field-1"]),
        countOnly: true,
    });
    assert.match(countQuery.sql, /^SELECT COUNT\(\*\) AS count/);
    assert.doesNotMatch(countQuery.sql, /ORDER BY/);
    assert.deepEqual(countQuery.params, query.params);

    const pagedQuery = buildSegmentRecipientQuery({
        operator: "AND",
        children: [{ type: "opt_in", value: true }],
    }, { projectId: "project-a", limit: 25, offset: 25 });
    assert.match(pagedQuery.sql, /ORDER BY c\.id ASC LIMIT \? OFFSET \?$/);
    assert.deepEqual(pagedQuery.params, ["project-a", 25, 25]);
    assert.throws(() => buildSegmentRecipientQuery({
        operator: "AND",
        children: [{ type: "opt_in", value: true }],
    }, { projectId: "project-a", limit: 101, offset: 0 }), /pagination is invalid/);
});

test("custom-field filters require active project field metadata before compilation", () => {
    const definition = {
        operator: "AND",
        children: [{ type: "attribute", field: "custom", field_id: "field-1", operator: "eq", value: "x" }],
    };
    assert.throws(() => buildSegmentRecipientQuery(definition, { projectId: "project-a" }), /not active/);
});

test("custom-field comparisons validate number and calendar-date values", () => {
    const makeDefinition = (fieldId, value) => ({
        operator: "AND",
        children: [{ type: "attribute", field: "custom", field_id: fieldId, operator: "gt", value }],
    });

    assert.throws(() => buildSegmentRecipientQuery(makeDefinition("number", "not-a-number"), {
        projectId: "project-a",
        customFieldIds: new Map([["number", "number"]]),
    }), /finite number/);
    assert.throws(() => buildSegmentRecipientQuery(makeDefinition("date", "2026-02-31"), {
        projectId: "project-a",
        customFieldIds: new Map([["date", "date"]]),
    }), /YYYY-MM-DD/);
    assert.doesNotThrow(() => buildSegmentRecipientQuery(makeDefinition("date", "2026-02-28"), {
        projectId: "project-a",
        customFieldIds: new Map([["date", "date"]]),
    }));
});

test("origin filters support recorded CRM source and inbound/QR source records", () => {
    const build = (value) => buildSegmentRecipientQuery({
        operator: "AND",
        children: [{ type: "origin", value }],
    }, { projectId: "project-a" }).sql;

    assert.match(build("whatsapp"), /FROM messages inbound/);
    assert.match(build("qr"), /FROM qr_scanned_users scan/);
    assert.match(build("import"), /c\.origin = \?/);
});

test("reference validation binds every referenced CRM resource to the active project", async () => {
    const definition = {
        operator: "AND",
        children: [
            { type: "tag", tag_id: "tag-1", operator: "has" },
            { type: "attribute", field: "custom", field_id: "field-1", operator: "eq", value: "Gold" },
            { type: "campaign_status", campaign_id: "campaign-1", status: "read" },
        ],
    };
    const calls = [];
    const customFields = await validateSegmentReferences({
        query: async (sql, params) => {
            calls.push({ sql, params });
            if (sql.includes("crm_custom_fields")) return [[{ field_id: "field-1", field_type: "select" }]];
            if (sql.includes("crm_tags")) return [[{ tag_id: "tag-1" }]];
            return [[{ campaign_id: "campaign-1" }]];
        },
    }, "project-a", definition);

    assert.equal(customFields.get("field-1"), "select");
    assert.equal(calls.length, 3);
    assert.ok(calls.every(({ params }) => params[0] === "project-a"));
    await assert.rejects(() => validateSegmentReferences({
        query: async () => [[]],
    }, "project-a", definition), /not active in this project/);
});

test("flow membership evaluates a saved segment for one project and exact contact number", async () => {
    const calls = [];
    const matched = await isContactInDynamicSegment({
        query: async (sql, params) => {
            calls.push({ sql, params });
            if (sql.includes("SELECT definition_json")) {
                return [[{ definition_json: { operator: "AND", children: [
                    { type: "attribute", field: "name", operator: "contains", value: "Asha" },
                ] } }]];
            }
            return [[{ contact_id: "contact-1" }]];
        },
    }, "project-a", "segment-1", "14155550100");

    assert.equal(matched, true);
    assert.equal(calls[0].params[0], "project-a");
    assert.equal(calls[1].params[0], "project-a");
    assert.match(calls[1].sql, /c\.number = \?/);
    assert.deepEqual(calls[1].params, ["project-a", "14155550100", "Asha"]);
});
