import test from "node:test";
import assert from "node:assert/strict";
import {
    buildCampaignReportRowsQuery,
    buildCampaignReportScope,
    parseCampaignReportRequest
} from "../helpers/campaignReport.js";

test("campaign report validates project, dates, pagination and snapshot inputs", () => {
    assert.deepEqual(parseCampaignReportRequest({
        project_id: " project-a ",
        from: "2026-03-01",
        to: "2026-03-31",
        page: "2",
        limit: "50",
        cursor: "900",
        snapshot_id: "1000"
    }), {
        projectId: "project-a",
        from: "2026-03-01",
        to: "2026-03-31",
        page: 2,
        limit: 50,
        cursor: 900,
        snapshotId: 1000
    });
    assert.match(parseCampaignReportRequest({ project_id: "p", from: "2026-02-30", to: "2026-03-01" }).error, /valid/);
    assert.match(parseCampaignReportRequest({ project_id: "p", from: "2026-03-02", to: "2026-03-01" }).error, /on or before/);
    assert.match(parseCampaignReportRequest({ project_id: "p", from: "2026-03-01" }).error, /Both/);
    assert.match(parseCampaignReportRequest({ project_id: "p", limit: 101 }).error, /Limit/);
    assert.match(parseCampaignReportRequest({ project_id: "p", cursor: -1 }).error, /Cursor/);
});

test("report scope and keyset page queries remain project-, date- and snapshot-scoped", () => {
    const scope = buildCampaignReportScope({
        projectId: "project-a",
        from: "2026-03-01",
        to: "2026-03-31",
        snapshotId: 1000
    });
    assert.match(scope.where, /cm\.project_id = \?/);
    assert.match(scope.where, /cm\.create_date >= \?/);
    assert.match(scope.where, /cm\.create_date < DATE_ADD\(\?, INTERVAL 1 DAY\)/);
    assert.match(scope.where, /cm\.id <= \?/);
    assert.deepEqual(scope.params, ["project-a", "2026-03-01", "2026-03-31", 1000]);

    const query = buildCampaignReportRowsQuery({ scope, cursor: 900, limit: 100 });
    assert.match(query.sql, /cm\.id < \?/);
    assert.match(query.sql, /ORDER BY cm\.id DESC/);
    assert.match(query.sql, /LEFT JOIN campaigns c/);
    assert.deepEqual(query.params, ["project-a", "2026-03-01", "2026-03-31", 1000, 900, 101]);
});

test("all-time reports omit date constraints and malformed project ids are rejected", () => {
    const scope = buildCampaignReportScope({ projectId: "p", from: "", to: "", snapshotId: null });
    assert.deepEqual(scope, { where: "cm.project_id = ?", params: ["p"] });
    assert.match(parseCampaignReportRequest({ project_id: "" }).error, /required/);
});
