import test from "node:test";
import assert from "node:assert/strict";
import {
    expandContactName,
    insertInternalNote,
    isActiveProjectMembership,
    normalizeCannedReply,
    normalizeConversationNumber
} from "../helpers/inboxProductivity.js";

test("internal-note access requires an active exact project membership", () => {
    assert.equal(isActiveProjectMembership({
        username: "agent-a",
        project_id: "project-a",
        is_deleted: "0"
    }, "agent-a", "project-a"), true);
    assert.equal(isActiveProjectMembership({
        username: "agent-a",
        project_id: "project-a",
        is_deleted: "1"
    }, "agent-a", "project-a"), false);
    assert.equal(isActiveProjectMembership({
        username: "agent-b",
        project_id: "project-a",
        is_deleted: "0"
    }, "agent-a", "project-a"), false);
    assert.equal(isActiveProjectMembership({
        username: "agent-a",
        project_id: "project-b",
        is_deleted: "0"
    }, "agent-a", "project-a"), false);
});

test("conversation numbers accept bounded phone numbers only", () => {
    assert.equal(normalizeConversationNumber(" +14155550123 "), "+14155550123");
    assert.equal(normalizeConversationNumber("123"), "");
    assert.equal(normalizeConversationNumber("abc1234567"), "");
    assert.equal(normalizeConversationNumber(14155550123), "");
});

test("canned replies normalize shortcuts and reject unsafe or oversized values", () => {
    assert.deepEqual(normalizeCannedReply({
        shortcut: "/Greeting_1",
        title: " Greeting ",
        body: " Hi {{contact.name}} "
    }), {
        shortcut: "greeting_1",
        title: "Greeting",
        body: "Hi {{contact.name}}"
    });
    assert.throws(() => normalizeCannedReply({ shortcut: "../bad", title: "Bad", body: "Text" }));
    assert.throws(() => normalizeCannedReply({ shortcut: "ok", title: "", body: "Text" }));
    assert.throws(() => normalizeCannedReply({ shortcut: "ok", title: "Good", body: " " }));
});

test("contact.name variables expand globally without touching unrelated variables", () => {
    assert.equal(
        expandContactName("Hello {{contact.name}} / {{ CONTACT.NAME }} {{contact.email}}", "Sam"),
        "Hello Sam / Sam {{contact.email}}"
    );
    assert.equal(expandContactName("Hello {{contact.name}}", "$&"), "Hello $&");
});

test("internal notes persist only to their private table, never the message pipeline", async () => {
    let captured;
    await insertInternalNote({
        query: async (sql, values) => {
            captured = { sql, values };
            return [{ affectedRows: 1 }];
        }
    }, {
        noteId: "note-1",
        projectId: "project-a",
        number: "14155550123",
        noteText: "Call tomorrow",
        createdAt: "2026-11-08 12:00:00",
        username: "agent-a"
    });

    assert.match(captured.sql, /INSERT INTO inbox_internal_notes/);
    assert.doesNotMatch(captured.sql, /messages|whatsapp|provider/i);
    assert.deepEqual(captured.values, [
        "note-1",
        "project-a",
        "14155550123",
        "Call tomorrow",
        "2026-11-08 12:00:00",
        "agent-a"
    ]);
});
