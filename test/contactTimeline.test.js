import test from "node:test";
import assert from "node:assert/strict";
import {
    buildContactTimelineQuery,
    normalizeTimelinePagination
} from "../helpers/contactTimeline.js";

test("timeline pagination is bounded and ignores malformed values", () => {
    assert.deepEqual(normalizeTimelinePagination("3", "50"), {
        page: 3,
        limit: 50,
        offset: 100
    });
    assert.deepEqual(normalizeTimelinePagination("2x", "1000"), {
        page: 1,
        limit: 100,
        offset: 0
    });
    assert.deepEqual(normalizeTimelinePagination(-1, 0), {
        page: 1,
        limit: 30,
        offset: 0
    });
});

test("timeline queries cover all requested sources and bind project/number values", () => {
    const query = buildContactTimelineQuery("project'; SELECT 1; --", "+14155550123", 2, 20, 20);
    const expectedTables = [
        "messages",
        "campaign_messages",
        "cases",
        "inbox_internal_notes",
        "contacts",
        "contact_tag_mapping",
        "conversation_label_mapping",
        "flow_execution_logs",
        "flow_conversations",
        "qr_scanned_users"
    ];

    expectedTables.forEach((table) => assert.match(query.dataSql, new RegExp(`\\b${table}\\b`)));
    assert.match(query.dataSql, /ORDER BY occurred_at DESC, event_id DESC\s+LIMIT \? OFFSET \?/);
    assert.match(query.countSql, /WHERE occurred_at IS NOT NULL/);
    assert.match(query.dataSql, /COALESCE\(m\.is_campaign, '0'\) <> '1'/);
    assert.match(query.dataSql, /CONCAT\('campaign-message:', cm\.id, ':', campaign_message\.id\)/);
    assert.match(query.dataSql, /campaign_message\.id = \(\s*SELECT MAX\(m\.id\)/);
    assert.match(query.dataSql, /deleted_date/);
    assert.equal((query.countSql.match(/\?/g) || []).length, query.sourceCount * 2);
    assert.equal((query.dataSql.match(/\?/g) || []).length, query.sourceCount * 2 + 2);
    assert.equal(query.sourceCount, 15);
    assert.equal(query.countParams.length, query.sourceCount * 2);
    assert.deepEqual(query.dataParams.slice(-4), [
        "project'; SELECT 1; --",
        "+14155550123",
        20,
        20
    ]);
    assert.doesNotMatch(query.dataSql, /project'; SELECT 1; --/);
});
