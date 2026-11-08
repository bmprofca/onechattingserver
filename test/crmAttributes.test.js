import test from "node:test";
import assert from "node:assert/strict";
import {
    makeCustomFieldKey,
    normalizeCustomFieldDefinition,
    validateCustomAttributeValues
} from "../helpers/crmAttributes.js";

test("custom field definitions validate types and select options", () => {
    assert.deepEqual(normalizeCustomFieldDefinition({
        name: "Customer type",
        field_type: "select",
        options: [" New ", "Existing", "New"]
    }), {
        name: "Customer type",
        field_type: "select",
        options: ["New", "Existing"]
    });
    assert.throws(() => normalizeCustomFieldDefinition({ name: "Choice", field_type: "select", options: [] }));
    assert.throws(() => normalizeCustomFieldDefinition({ name: "Choice", field_type: "select", options: [null] }));
    assert.throws(() => normalizeCustomFieldDefinition({ name: "Bad", field_type: "currency" }));
});

test("custom field keys are stable, readable identifiers", () => {
    assert.equal(makeCustomFieldKey("Preferred Language"), "preferred_language");
    assert.throws(() => makeCustomFieldKey("  "));
    assert.throws(() => makeCustomFieldKey("Name"));
    assert.throws(() => makeCustomFieldKey("Group ID"));
});

test("custom values validate all supported types and preserve false", () => {
    const fields = [
        { field_id: "text", name: "Notes", field_type: "text", options: [] },
        { field_id: "number", name: "Score", field_type: "number", options: [] },
        { field_id: "date", name: "Renewal", field_type: "date", options: [] },
        { field_id: "boolean", name: "VIP", field_type: "boolean", options: [] },
        { field_id: "select", name: "Tier", field_type: "select", options: ["Gold", "Silver"] }
    ];
    const result = validateCustomAttributeValues(fields, {
        text: "hello",
        number: "12.5",
        date: "2026-11-08",
        boolean: false,
        select: "Gold"
    });
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.values.map((entry) => entry.value), ["hello", "12.5", "2026-11-08", "false", "Gold"]);
});

test("custom values reject malformed, unknown, and out-of-project field ids", () => {
    const result = validateCustomAttributeValues([
        { field_id: "date", name: "Renewal", field_type: "date", options: [] },
        { field_id: "select", name: "Tier", field_type: "select", options: ["Gold"] }
    ], { date: "2026-02-30", select: "Platinum", unknown: "x" });
    assert.equal(result.values.length, 0);
    assert.equal(result.errors.length, 3);
});
