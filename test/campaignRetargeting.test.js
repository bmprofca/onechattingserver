import test from "node:test";
import assert from "node:assert/strict";
import {
    buildRetargetAudienceQuery,
    getConsentCommand,
    getRetargetAudience,
    normalizeSuppressionPhone
} from "../helpers/campaign/retargeting.js";

test("retarget audiences map to supported, project-correlated report predicates", () => {
    assert.equal(getRetargetAudience("delivered_not_read")?.predicate, "cm.status = 'delivered'");
    assert.match(getRetargetAudience("read_not_replied").predicate, /inbound\.project_id = cm\.project_id/);
    assert.match(getRetargetAudience("read_not_replied").predicate, /inbound\.create_date > cm\.send_date/);
    assert.match(getRetargetAudience("clicked").predicate, /click_event\.campaign_id = cm\.campaign_id/);
    assert.match(getRetargetAudience("clicked").predicate, /interaction\.reply_wamid = cm\.wamid/);
    assert.equal(getRetargetAudience("failed")?.predicate, "cm.status = 'failed'");
    assert.equal(getRetargetAudience("unknown"), null);
});

test("retarget queries scope report state and exclude suppressed project numbers", () => {
    const query = buildRetargetAudienceQuery("read_not_replied");
    assert.match(query.sql, /cm\.project_id = \?/);
    assert.match(query.sql, /cm\.campaign_id = \?/);
    assert.match(query.sql, /suppression\.project_id = cm\.project_id/);
    assert.match(query.sql, /suppression\.phone = cm\.number/);
    assert.match(query.sql, /suppression\.phone IS NULL/);
    assert.equal(buildRetargetAudienceQuery("invalid"), null);
});

test("consent commands are matched as whole commands only", () => {
    assert.equal(getConsentCommand("  STOP! "), "opt_out");
    assert.equal(getConsentCommand("unsubscribe"), "opt_out");
    assert.equal(getConsentCommand("START"), "opt_in");
    assert.equal(getConsentCommand("Please stop sending these"), null);
    assert.equal(getConsentCommand("start my campaign"), null);
});

test("suppression phone numbers normalize to the campaign recipient format", () => {
    assert.equal(normalizeSuppressionPhone("+1 (415) 555-0100"), "14155550100");
    assert.equal(normalizeSuppressionPhone(""), "");
});
