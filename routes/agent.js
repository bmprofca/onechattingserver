import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP, USER_DATA, USER_DATA_MAP } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { sendAgentInvitationEmail } from "../helpers/email.js";
import { ensureAgentInvitationsTable, listPendingInvitationsForUser, usableEmail } from "../helpers/agentInvitations.js";

const router = express.Router();

function normalizeMobile(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
    if (digits.length === 10) return digits;
    return "";
}

router.post("/add", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    const mobile = normalizeMobile(decrypt.mobile);
    const permission_id = decrypt.permission_id;

    if (!project_id || !permission_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    if (!mobile) {
        return res.status(200).json({ error: 'Enter a valid 10-digit mobile number' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const [email_check_row] = await pool.query("SELECT * FROM users WHERE mobile = ? AND status = ?", [mobile, '1']);

    if (email_check_row.length !== 1) {
        return res.status(200).json({ error: 'User not registered on given mobile number' })
    }

    const agent_data = email_check_row[0];
    const agent_username = agent_data?.username;
    const [check_already_exist] = await pool.query("SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND is_deleted = ?", [project_id, agent_username, '0']);

    if (check_already_exist.length > 0) {
        return res.status(200).json({ error: 'Agent already added' })
    }

    const [permission_row] = await pool.query("SELECT * FROM permission_list WHERE permission_id = ?", [permission_id]);
    if (permission_row.length !== 1) {
        return res.status(200).json({ error: 'Invalid permission' });
    }

    try {
        await ensureAgentInvitationsTable();

        const [pending_row] = await pool.query(
            "SELECT unique_id FROM agent_invitations WHERE project_id = ? AND username = ? AND status = ?",
            [project_id, agent_username, 'pending']
        );
        if (pending_row.length > 0) {
            return res.status(200).json({ error: 'An invitation is already waiting for this user to accept' });
        }

        const [project_row] = await pool.query("SELECT project_name FROM aisensy_projects WHERE project_id = ?", [project_id]);
        const project_name = project_row[0]?.project_name || 'a project';
        const inviter = await USER_DATA(username);
        const now = TIMESTAMP();
        const unique_id = RANDOM_STRING(30);

        const [rejected_row] = await pool.query(
            "SELECT unique_id FROM agent_invitations WHERE project_id = ? AND username = ? AND status = ? ORDER BY id DESC LIMIT 1",
            [project_id, agent_username, 'rejected']
        );

        if (rejected_row.length > 0) {
            await pool.query(
                "UPDATE agent_invitations SET unique_id = ?, permission_id = ?, status = ?, invited_by = ?, create_date = ?, modify_date = ? WHERE unique_id = ?",
                [unique_id, permission_id, 'pending', username, now, now, rejected_row[0].unique_id]
            );
        } else {
            await pool.query(
                "INSERT INTO agent_invitations (unique_id, project_id, username, permission_id, status, invited_by, create_date, modify_date) VALUES (?,?,?,?,?,?,?,?)",
                [unique_id, project_id, agent_username, permission_id, 'pending', username, now, now]
            );
        }

        const invite_email = usableEmail(agent_data?.email);
        let email_sent = false;
        if (invite_email) {
            email_sent = await sendAgentInvitationEmail(
                invite_email,
                agent_data?.name || 'there',
                project_name,
                inviter?.name || ''
            );
        }

        const msg = invite_email
            ? (email_sent
                ? 'Invitation sent. They can accept it from Switch Project after signing in.'
                : 'Invitation created. The email could not be sent, but they can accept it from Switch Project after signing in.')
            : 'Invitation created. This user has no email, so they can accept it from Switch Project after signing in.';

        return res.status(200).json({ msg, email_sent });
    } catch (error) {
        res.json({
            error: 'Failed to send invitation',
            e: error
        });
    }




});

router.post("/list", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;


    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const [row] = await pool.query("SELECT project_mapping.*,users.name,users.email, users.country_code, users.mobile, users.status,permission_list.name AS permission_name FROM `project_mapping` JOIN users ON users.username = project_mapping.username JOIN permission_list ON permission_list.permission_id = project_mapping.permission_id WHERE project_mapping.project_id = ? AND project_mapping.type = ? AND project_mapping.is_deleted = ? ORDER BY users.name ASC", [project_id, 'agent', '0']);

    const auditUsernames = row.flatMap((element) => [element.create_by, element.modify_by]);
    const userMap = await USER_DATA_MAP(auditUsernames);

    const res_data = [];

    for (let index = 0; index < row.length; index++) {
        const element = row[index];

        const name = element?.name;
        const mobile = element?.mobile;
        const country_code = element?.country_code;
        const email = element?.email;
        const status = element?.status;
        const create_date = element?.create_date;
        const create_by = element?.create_by;
        const modify_date = element?.modify_date;
        const modify_by = element?.modify_by;
        const permission_name = element?.permission_name;
        const permission_id = element?.permission_id;
        const mapping_id = element?.unique_id;


        const create_by_data = userMap.get(create_by) || {};
        const modify_by_data = userMap.get(modify_by) || {};

        var object = {
            name,
            mobile,
            country_code,
            email,
            status: status == '1' ? true : false,
            create_date,
            mapping_id,
            create_by: {
                name: create_by_data?.name,
                mobile: create_by_data?.mobile,
                email: create_by_data?.email,
                status: create_by_data?.status == '1' ? true : false,
            },
            modify_date,
            modify_by: {
                name: modify_by_data?.name,
                mobile: modify_by_data?.mobile,
                email: modify_by_data?.email,
                status: modify_by_data?.status == '1' ? true : false,
            },
            permission: {
                permission_id,
                name: permission_name
            },
            invitation_status: 'active'
        };

        res_data.push(object);

    }

    await ensureAgentInvitationsTable();
    const [pending_rows] = await pool.query(`
        SELECT i.unique_id, i.permission_id, i.create_date, i.modify_date, i.invited_by,
               users.name, users.email, users.country_code, users.mobile, users.status,
               permission_list.name AS permission_name
        FROM agent_invitations i
        JOIN users ON users.username = i.username
        LEFT JOIN permission_list ON permission_list.permission_id = i.permission_id
        WHERE i.project_id = ? AND i.status = 'pending'
        ORDER BY users.name ASC
    `, [project_id]);

    for (const element of pending_rows) {
        res_data.push({
            name: element.name,
            mobile: element.mobile,
            country_code: element.country_code,
            email: element.email,
            status: element.status == '1',
            create_date: element.create_date,
            mapping_id: null,
            invitation_id: element.unique_id,
            invitation_status: 'pending',
            create_by: { name: '', mobile: '', email: '', status: false },
            modify_date: element.modify_date,
            modify_by: { name: '', mobile: '', email: '', status: false },
            permission: {
                permission_id: element.permission_id,
                name: element.permission_name || ''
            }
        });
    }

    return res.status(200).json({
        data: res_data,
        count: res_data.length,
        msg: 'Agent fetched successfully'
    })

});

router.post("/change-permission", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    const mapping_id = decrypt.mapping_id;
    const permission_id = decrypt.permission_id;


    if (!project_id || !mapping_id || !permission_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }


    const [check_agent_exist] = await pool.query("SELECT * FROM project_mapping WHERE unique_id = ? AND project_id = ? AND is_deleted = ?", [mapping_id, project_id, '0']);

    if (check_agent_exist.length !== 1) {
        return res.status(200).json({ error: 'Invalid mapping ID' })
    }


    const [check_permission_exist] = await pool.query("SELECT * FROM permission_list WHERE permission_id = ?", [permission_id]);

    if (check_permission_exist.length !== 1) {
        return res.status(200).json({ error: 'Invalid mapping ID' })
    }


    try {

        await pool.query("UPDATE `project_mapping` SET `modify_by`=?,`modify_date`=?,`permission_id`=? WHERE unique_id= ?", [username, TIMESTAMP(), permission_id, mapping_id]);

        return res.status(200).json({
            msg: 'Permission changed successfuly',
        })


    } catch (error) {
        return res.status(200).json({
            error: 'Failed to change permission',
            e: error,
        })
    }





});

router.post("/fetch-agent", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    const mobile = normalizeMobile(decrypt.mobile);


    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    if (!mobile) {
        return res.status(200).json({ error: 'Enter a valid 10-digit mobile number', agent_exist: false });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    // CHECK USER REGISTERED
    const [checo_user] = await pool.query("SELECT * FROM users WHERE mobile = ? AND status = ?", [mobile, '1']);
    if (checo_user.length !== 1) {
        return res.status(200).json({ error: 'User not registered on given mobile number', agent_exist: false });
    }

    const agent_data = checo_user[0];
    const agent_username = agent_data?.username;

    const [check_agent_exist] = await pool.query("SELECT * FROM project_mapping WHERE username = ? AND project_id = ? AND is_deleted = ?", [agent_username, project_id, '0']);

    if (check_agent_exist.length > 0) {
        return res.status(200).json({ error: 'User already added', agent_exist: false })
    }

    await ensureAgentInvitationsTable();
    const [pending_invite] = await pool.query(
        "SELECT unique_id FROM agent_invitations WHERE project_id = ? AND username = ? AND status = ?",
        [project_id, agent_username, 'pending']
    );
    if (pending_invite.length > 0) {
        return res.status(200).json({ error: 'An invitation is already waiting for this user to accept', agent_exist: false });
    }


    return res.status(200).json({
        agent_exist: true,
        data: {
            name: agent_data?.name,
            email: agent_data?.email || '',
            country_code: agent_data?.country_code || '',
            mobile: agent_data?.mobile,
            status: agent_data?.status == '1' ? true : false,
        },
        msg: 'User fetched successfully'
    })


});


router.post("/delete", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    const mapping_id = decrypt.mapping_id;


    if (!project_id || !mapping_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }


    const [check_agent_exist] = await pool.query("SELECT * FROM project_mapping WHERE unique_id = ? AND project_id = ? AND is_deleted = ?", [mapping_id, project_id, '0']);

    if (check_agent_exist.length == 0) {
        return res.status(200).json({ error: 'Invalid mapping ID' })
    }


    try {
        await pool.query("UPDATE `project_mapping` SET `modify_by`=?,`modify_date`=?,`is_deleted`=?,`delete_by`=? WHERE unique_id = ? AND project_id = ?", [username, TIMESTAMP(), '1', username, mapping_id, project_id]);

        return res.status(200).json({
            msg: 'Agent deleted successfully'
        })
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to delete agent',
            e: error
        })
    }




});

router.post("/invitations", auth, async (req, res) => {
    const username = req.headers["username"] ? req.headers["username"] : '';

    try {
        const list = await listPendingInvitationsForUser(username);
        return res.status(200).json({
            error: false,
            list,
            count: list.length
        });
    } catch (error) {
        return res.status(200).json({ error: 'Failed to load invitations' });
    }
});

router.post("/invitation/respond", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);
    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const invitation_id = decrypt.invitation_id;
    const action = String(decrypt.action || '').toLowerCase();

    if (!invitation_id || !['accept', 'reject'].includes(action)) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    await ensureAgentInvitationsTable();
    const [rows] = await pool.query(
        "SELECT * FROM agent_invitations WHERE unique_id = ? AND username = ? AND status = ?",
        [invitation_id, username, 'pending']
    );

    if (rows.length !== 1) {
        return res.status(200).json({ error: 'Invitation not found' });
    }

    const invitation = rows[0];
    const now = TIMESTAMP();

    if (action === 'reject') {
        await pool.query(
            "UPDATE agent_invitations SET status = ?, modify_date = ? WHERE unique_id = ?",
            ['rejected', now, invitation_id]
        );
        return res.status(200).json({ error: false, msg: 'Invitation rejected' });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        const [existing] = await connection.query(
            "SELECT unique_id FROM project_mapping WHERE project_id = ? AND username = ? AND is_deleted = ?",
            [invitation.project_id, username, '0']
        );

        if (existing.length === 0) {
            await connection.query(
                "INSERT INTO `project_mapping`(`unique_id`, `project_id`, `username`, `type`, `create_by`, `create_date`, `modify_by`, `modify_date`, `is_deleted`,`permission_id`) VALUES (?,?,?,?,?,?,?,?,?,?)",
                [RANDOM_STRING(30), invitation.project_id, username, 'agent', invitation.invited_by, now, username, now, '0', invitation.permission_id]
            );
        }

        await connection.query(
            "UPDATE agent_invitations SET status = ?, modify_date = ? WHERE unique_id = ?",
            ['accepted', now, invitation_id]
        );
        await connection.commit();
        return res.status(200).json({ error: false, msg: 'Invitation accepted. You are now an agent on this project.' });
    } catch (error) {
        await connection.rollback();
        return res.status(200).json({ error: 'Failed to accept invitation' });
    } finally {
        connection.release();
    }
});

router.post("/invitation/cancel", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);
    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt.project_id;
    const invitation_id = decrypt.invitation_id;

    if (!project_id || !invitation_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    await ensureAgentInvitationsTable();
    const [rows] = await pool.query(
        "SELECT unique_id FROM agent_invitations WHERE unique_id = ? AND project_id = ? AND status = ?",
        [invitation_id, project_id, 'pending']
    );
    if (rows.length !== 1) {
        return res.status(200).json({ error: 'Invitation not found' });
    }

    await pool.query(
        "UPDATE agent_invitations SET status = ?, modify_date = ? WHERE unique_id = ?",
        ['cancelled', TIMESTAMP(), invitation_id]
    );

    return res.status(200).json({ error: false, msg: 'Invitation cancelled' });
});

export default router;
