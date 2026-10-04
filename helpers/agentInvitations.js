import pool from "../db.js";

let invitationsTableReady = null;

export function ensureAgentInvitationsTable() {
    if (!invitationsTableReady) {
        invitationsTableReady = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS agent_invitations (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    unique_id VARCHAR(40) NOT NULL,
                    project_id VARCHAR(100) NOT NULL,
                    username VARCHAR(100) NOT NULL,
                    permission_id VARCHAR(100) NOT NULL,
                    status VARCHAR(20) NOT NULL DEFAULT 'pending',
                    invited_by VARCHAR(100) NOT NULL,
                    create_date DATETIME NULL,
                    modify_date DATETIME NULL,
                    UNIQUE KEY uniq_invitation_id (unique_id),
                    KEY idx_invitee_status (username, status),
                    KEY idx_project_status (project_id, status)
                ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
            `);
            await pool.query(
                "ALTER TABLE agent_invitations CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
            );
        })().catch((error) => {
            invitationsTableReady = null;
            throw error;
        });
    }
    return invitationsTableReady;
}

export function usableEmail(value) {
    const email = String(value || "").trim();
    if (!email) return "";
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

export async function listPendingInvitationsForUser(username) {
    await ensureAgentInvitationsTable();
    const [rows] = await pool.query(`
        SELECT i.unique_id, i.project_id, i.permission_id, i.create_date,
               p.project_name,
               u.name AS invited_by_name,
               pl.name AS permission_name
        FROM agent_invitations i
        JOIN aisensy_projects p ON p.project_id = i.project_id
        LEFT JOIN users u ON u.username = i.invited_by
        LEFT JOIN permission_list pl ON pl.permission_id = i.permission_id
        WHERE i.username = ? AND i.status = 'pending'
        ORDER BY i.create_date DESC
    `, [username]);

    return rows.map((row) => ({
        invitation_id: row.unique_id,
        project_id: row.project_id,
        project_name: row.project_name,
        permission_id: row.permission_id,
        permission_name: row.permission_name || "",
        invited_by_name: row.invited_by_name || "",
        create_date: row.create_date,
    }));
}
