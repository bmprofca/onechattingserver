import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP, USER_DATA, USER_DATA_MAP } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";

const router = express.Router();

const PERMISSION_FIELD_MAP = {
    "create contact": "contact_create",
    "edit contact": "contact_edit",
    "delete contact": "contact_delete",
    "view contact": "contact_view",
    "view all chat": "all_chat_view",
    "create template": "template_create",
    "edit template": "template_edit",
    "delete template": "template_delete",
    "broadcast access": "broadcast_access",
    "setting access": "setting_access",
    "chat assign access": "chat_assign_access",
};

const emptyPermissionOptions = () => ({
    contact_create: false,
    contact_edit: false,
    contact_delete: false,
    contact_view: false,
    all_chat_view: false,
    template_create: false,
    template_edit: false,
    template_delete: false,
    broadcast_access: false,
    setting_access: false,
    chat_assign_access: false,
});

function buildPermissionOptionsFromRows(rows = []) {
    const object = emptyPermissionOptions();

    rows.forEach((element) => {
        const permission = element.permission;
        const status = element.status == "1";
        const key = PERMISSION_FIELD_MAP[permission];
        if (key && status) {
            object[key] = true;
        }
    });

    return object;
}

const PermissionOptions = async (permission_id) => {
    const [row] = await pool.query("SELECT permission, status FROM `permission_options` WHERE permission_id = ?", [permission_id]);
    return buildPermissionOptionsFromRows(row);
};

async function permissionOptionsMap(permissionIds = []) {
    const uniqueIds = [...new Set(permissionIds.filter(Boolean))];
    const map = new Map(uniqueIds.map((id) => [id, emptyPermissionOptions()]));

    if (uniqueIds.length === 0) {
        return map;
    }

    const [rows] = await pool.query(
        "SELECT permission_id, permission, status FROM permission_options WHERE permission_id IN (?)",
        [uniqueIds]
    );

    const grouped = new Map();
    for (const row of rows) {
        if (!grouped.has(row.permission_id)) {
            grouped.set(row.permission_id, []);
        }
        grouped.get(row.permission_id).push(row);
    }

    for (const [permissionId, permissionRows] of grouped) {
        map.set(permissionId, buildPermissionOptionsFromRows(permissionRows));
    }

    return map;
}

async function projectMappingTypeMap(project_id, usernames = []) {
    const unique = [...new Set(usernames.filter(Boolean))];
    const map = new Map();

    if (unique.length === 0) {
        return map;
    }

    const [rows] = await pool.query(
        "SELECT username, type FROM project_mapping WHERE project_id = ? AND username IN (?)",
        [project_id, unique]
    );

    for (const row of rows) {
        map.set(row.username, row.type);
    }

    return map;
}

function buildAuditUser(userMap, username, mappingTypeMap) {
    const user = userMap.get(username) || {};
    return {
        name: user?.name,
        mobile: user?.mobile,
        type: mappingTypeMap.get(username),
    };
}

router.post("/create", auth, async (req, res) => {
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
    const name = decrypt.name;
    const remark = decrypt.remark;


    if (name == '') {
        return res.status(200).json({ error: 'Permission name is required' })
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    try {
        const permission_id = RANDOM_STRING(30);
        await pool.query("INSERT INTO `permission_list`(`permission_id`, `name`, `create_date`, `create_by`, `modify_date`, `modify_by`, `remark`,`project_id`) VALUES (?,?,?,?,?,?,?,?)", [permission_id, name, TIMESTAMP(), username, TIMESTAMP(), username, remark, project_id]);

        const user_data = await USER_DATA(username);

        const [project_mapping] = await pool.query("SELECT type FROM project_mapping WHERE project_id = ? AND username = ? LIMIT 1", [project_id, username]);

        res.json({
            msg: 'Permission created successfully',
            data: {
                permission_id,
                name,
                remark,
                agent_count: 0,
                create_date: TIMESTAMP(),
                modify_date: TIMESTAMP(),
                create_by: {
                    name: user_data?.name,
                    mobile: user_data?.mobile,
                    type: project_mapping[0]?.type,
                },
                modify_by: {
                    name: user_data?.name,
                    mobile: user_data?.mobile,
                    type: project_mapping[0]?.type,
                }
            }
        });

    } catch (error) {
        return res.status(200).json({ error: 'Failed to create permission', e: error })
    }
});

router.post("/edit", auth, async (req, res) => {
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
    const permission_id = decrypt.permission_id;
    const name = decrypt.name;
    const remark = decrypt.remark;


    if (name == '') {
        return res.status(200).json({ error: 'Permission name is required' })
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const [check_row] = await pool.query("SELECT permission_id FROM permission_list WHERE permission_id = ? LIMIT 1", [permission_id]);

    if (check_row.length == 0) {
        return res.status(200).json({ error: 'Permission not found' })
    }

    try {
        await pool.query("UPDATE `permission_list` SET `name`=?,`modify_date`=?,`modify_by`=?,`remark`=? WHERE permission_id = ?", [name, TIMESTAMP(), username, remark, permission_id]);

        const [[agent_count_row]] = await pool.query("SELECT COUNT(*) AS total FROM project_mapping WHERE permission_id = ? AND is_deleted = ?", [permission_id, '0']);

        const [new_data] = await pool.query("SELECT * FROM permission_list WHERE permission_id = ? LIMIT 1", [permission_id]);
        const permissionRow = new_data[0];
        const userMap = await USER_DATA_MAP([permissionRow?.create_by, permissionRow?.modify_by]);
        const mappingTypeMap = await projectMappingTypeMap(project_id, [permissionRow?.create_by, permissionRow?.modify_by]);

        res.json({
            msg: 'Permission edited successfully',
            data: {
                permission_id: permissionRow?.permission_id,
                name: permissionRow?.name,
                remark: permissionRow?.remark,
                agent_count: Number(agent_count_row?.total || 0),
                create_date: permissionRow?.create_date,
                modify_date: permissionRow?.modify_date,
                create_by: buildAuditUser(userMap, permissionRow?.create_by, mappingTypeMap),
                modify_by: buildAuditUser(userMap, permissionRow?.modify_by, mappingTypeMap),
            }
        });

    } catch (error) {
        return res.status(200).json({ error: 'Failed to create permission', e: error })
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

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const [row] = await pool.query("SELECT * FROM permission_list WHERE project_id = ? ORDER BY id DESC", [project_id]);

    if (row.length === 0) {
        return res.status(200).json({ data: [], count: 0, msg: 'Permission list fetched successfully' });
    }

    const permissionIds = row.map((element) => element.permission_id);
    const auditUsernames = row.flatMap((element) => [element.create_by, element.modify_by]);

    const [agentCountRows] = await pool.query(
        "SELECT permission_id, COUNT(*) AS agent_count FROM project_mapping WHERE project_id = ? AND is_deleted = ? AND permission_id IN (?) GROUP BY permission_id",
        [project_id, "0", permissionIds]
    );
    const agentCountMap = new Map(agentCountRows.map((item) => [item.permission_id, Number(item.agent_count)]));

    const userMap = await USER_DATA_MAP(auditUsernames);
    const mappingTypeMap = await projectMappingTypeMap(project_id, auditUsernames);
    const permissionsMap = await permissionOptionsMap(permissionIds);

    const res_data = row.map((element) => ({
        permission_id: element?.permission_id,
        name: element?.name,
        remark: element?.remark,
        agent_count: agentCountMap.get(element.permission_id) || 0,
        create_date: element?.create_date,
        modify_date: element?.modify_date,
        create_by: buildAuditUser(userMap, element?.create_by, mappingTypeMap),
        modify_by: buildAuditUser(userMap, element?.modify_by, mappingTypeMap),
        permissions: permissionsMap.get(element.permission_id) || emptyPermissionOptions(),
    }));

    return res.status(200).json({ data: res_data, count: res_data.length, msg: 'Permission list fetched successfully' })

});


const UpdateStatus = async (permission_id, permission, status) => {
    const [check_row] = await pool.query("SELECT id FROM permission_options WHERE permission_id = ? AND permission = ? LIMIT 1", [permission_id, permission]);
    if (check_row.length > 0) {
        await pool.query("UPDATE `permission_options` SET `status`= ? WHERE permission_id = ? AND permission = ?", [status, permission_id, permission]);
    } else {
        await pool.query("INSERT INTO `permission_options`(`permission_id`, `permission`, `status`) VALUES (?,?,?)", [permission_id, permission, status]);
    }
}

router.post("/set-access", auth, async (req, res) => {
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
    const permission_id = decrypt.permission_id;
    const contact_create = decrypt.contact_create;
    const contact_edit = decrypt.contact_edit;
    const contact_delete = decrypt.contact_delete;
    const contact_view = decrypt.contact_view;
    const all_chat_view = decrypt.all_chat_view;
    const template_create = decrypt.template_create;
    const template_edit = decrypt.template_edit;
    const template_delete = decrypt.template_delete;
    const broadcast_access = decrypt.broadcast_access;
    const setting_access = decrypt.setting_access;
    const chat_assign_access = decrypt.chat_assign_access;

    if (
        project_id == null || project_id === '' ||
        permission_id == null || permission_id === '' ||
        contact_create == null || contact_create === '' ||
        contact_edit == null || contact_edit === '' ||
        contact_delete == null || contact_delete === '' ||
        contact_view == null || contact_view === '' ||
        all_chat_view == null || all_chat_view === '' ||
        template_create == null || template_create === '' ||
        template_edit == null || template_edit === '' ||
        template_delete == null || template_delete === '' ||
        broadcast_access == null || broadcast_access === '' ||
        setting_access == null || setting_access === '' ||
        chat_assign_access == null || chat_assign_access === ''
    ) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const permissionUpdates = [
        ["create contact", contact_create == true ? '1' : '0'],
        ["edit contact", contact_edit == true ? '1' : '0'],
        ["delete contact", contact_delete == true ? '1' : '0'],
        ["view contact", contact_view == true ? '1' : '0'],
        ["create template", template_create == true ? '1' : '0'],
        ["edit template", template_edit == true ? '1' : '0'],
        ["delete template", template_delete == true ? '1' : '0'],
        ["view all chat", all_chat_view == true ? '1' : '0'],
        ["broadcast access", broadcast_access == true ? '1' : '0'],
        ["setting access", setting_access == true ? '1' : '0'],
        ["chat assign access", chat_assign_access == true ? '1' : '0'],
    ];

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        for (const [permission, status] of permissionUpdates) {
            const [check_row] = await connection.query(
                "SELECT id FROM permission_options WHERE permission_id = ? AND permission = ? LIMIT 1",
                [permission_id, permission]
            );
            if (check_row.length > 0) {
                await connection.query(
                    "UPDATE `permission_options` SET `status`= ? WHERE permission_id = ? AND permission = ?",
                    [status, permission_id, permission]
                );
            } else {
                await connection.query(
                    "INSERT INTO `permission_options`(`permission_id`, `permission`, `status`) VALUES (?,?,?)",
                    [permission_id, permission, status]
                );
            }
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        return res.status(200).json({ error: 'Failed to set permission access', e: error?.message || error });
    } finally {
        connection.release();
    }

    return res.status(200).json({
        msg: 'Permission set successfully'
    });



});

export default router;
