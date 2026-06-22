import pool from "../db.js";

const ids = [
    "7u772x38wgf3234d3p517wpd3e2x8bho07z0707c8rl",
    "lmg1vfc784vn93vd3831v1674wjmabh68058742ql8h",
    "0se367erqp6ull6lljp5hbn8y43j2x1769487560535",
];

for (const id of ids) {
    const [rows] = await pool.query(
        "SELECT template_id, template_json FROM templates WHERE template_id = ?",
        [id]
    );
    const j = JSON.parse(rows[0].template_json);
    const h = j.components?.find((c) => c.type === "HEADER")?.example?.header_handle;
    console.log(id, h || "no header");
}

const [countRows] = await pool.query(
    "SELECT COUNT(*) AS n FROM templates WHERE template_json IS NULL OR template_json = '{}' OR template_json = ''"
);
console.log("empty template_json rows:", countRows[0].n);

await pool.end();
