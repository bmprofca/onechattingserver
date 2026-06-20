import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP, USER_DATA } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";

const router = express.Router();

const PermissionOptions = async (permission_id) => {
    const [row] = await pool.query("SELECT * FROM `permission_options` WHERE permission_id = ?", [permission_id]);
    const object = {
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
    };
    row.forEach(element => {
        const permission = element.permission;
        const status = element.status == '1' ? true : false;
        if (permission == 'create contact') {
            if (status) {
                object.contact_create = true;
            }
        } else if (permission == 'edit contact') {
            if (status) {
                object.contact_edit = true;
            }
        } else if (permission == 'delete contact') {
            if (status) {
                object.contact_delete = true;
            }
        } else if (permission == 'view contact') {
            if (status) {
                object.contact_view = true;
            }
        } else if (permission == 'view all chat') {
            if (status) {
                object.all_chat_view = true;
            }
        } else if (permission == 'create template') {
            if (status) {
                object.template_create = true;
            }
        } else if (permission == 'edit template') {
            if (status) {
                object.template_edit = true;
            }
        } else if (permission == 'delete template') {
            if (status) {
                object.template_delete = true;
            }
        } else if (permission == 'broadcast access') {
            if (status) {
                object.broadcast_access = true;
            }
        } else if (permission == 'setting access') {
            if (status) {
                object.setting_access = true;
            }
        } else if (permission == 'chat assign access') {
            if (status) {
                object.chat_assign_access = true;
            }
        }
    });

    return object;
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

        const [project_mapping] = await pool.query("SELECT * FROM project_mapping WHERE project_id = ? AND username = ?", [project_id, username]);

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

    const [check_row] = await pool.query("SELECT * FROM permission_list WHERE permission_id = ?", [permission_id]);

    if (check_row.length == 0) {
        return res.status(200).json({ error: 'Permission not found' })
    }

    try {
        await pool.query("UPDATE `permission_list` SET `name`=?,`modify_date`=?,`modify_by`=?,`remark`=? WHERE permission_id = ?", [name, TIMESTAMP(), username, remark, permission_id]);

        const [agent_count_row] = await pool.query("SELECT * FROM project_mapping WHERE permission_id = ? AND is_deleted = ?", [permission_id, '0']);

        const [new_data] = await pool.query("SELECT * FROM permission_list WHERE permission_id = ?", [permission_id]);

        const create_by_data = await USER_DATA(new_data[0]?.create_by);
        const modify_by_data = await USER_DATA(new_data[0]?.modify_by);

        const [project_mapping1] = await pool.query("SELECT * FROM project_mapping WHERE project_id = ? AND username = ?", [project_id, new_data[0]?.create_by]);
        const [project_mapping2] = await pool.query("SELECT * FROM project_mapping WHERE project_id = ? AND username = ?", [project_id, new_data[0]?.modify_by]);

        res.json({
            msg: 'Permission edited successfully',
            data: {
                permission_id: new_data[0]?.permission_id,
                name: new_data[0]?.name,
                remark: new_data[0]?.remark,
                agent_count: agent_count_row.length,
                create_date: TIMESTAMP(),
                modify_date: TIMESTAMP(),
                create_by: {
                    name: create_by_data?.name,
                    mobile: create_by_data?.mobile,
                    type: project_mapping1[0]?.type,
                },
                modify_by: {
                    name: modify_by_data?.name,
                    mobile: modify_by_data?.mobile,
                    type: project_mapping2[0]?.type,
                }
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

    const res_data = [];

    for (let index = 0; index < row.length; index++) {
        const element = row[index];


        const permission_id = element?.permission_id;

        const [agent_count_row] = await pool.query("SELECT * FROM project_mapping WHERE permission_id = ? AND is_deleted = ?", [permission_id, '0']);

        const create_by_data = await USER_DATA(element?.create_by);
        const modify_by_data = await USER_DATA(element?.modify_by);


        const [project_mapping1] = await pool.query("SELECT * FROM project_mapping WHERE project_id = ? AND username = ?", [project_id, element?.create_by]);
        const [project_mapping2] = await pool.query("SELECT * FROM project_mapping WHERE project_id = ? AND username = ?", [project_id, element?.modify_by]);


        const permissions = await PermissionOptions(element?.permission_id);

        var object = {
            permission_id: element?.permission_id,
            name: element?.name,
            remark: element?.remark,
            agent_count: agent_count_row.length,
            create_date: TIMESTAMP(),
            modify_date: TIMESTAMP(),
            create_by: {
                name: create_by_data?.name,
                mobile: create_by_data?.mobile,
                type: project_mapping1[0]?.type,
            },
            modify_by: {
                name: modify_by_data?.name,
                mobile: modify_by_data?.mobile,
                type: project_mapping2[0]?.type,
            },
            permissions
        };

        res_data.push(object)
    };

    return res.status(200).json({ data: res_data, count: res_data.length, msg: 'Permission list fetched successfully' })

});


const UpdateStatus = async (permission_id, permission, status) => {
    const [check_row] = await pool.query("SELECT * FROM permission_options WHERE permission_id = ?  AND permission = ?", [permission_id, permission, status]);
    if (check_row.length > 0) {
        await pool.query("UPDATE `permission_options` SET `status`= ? WHERE permission_id = ?  AND permission = ?", [status, permission_id, permission]);
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

    await UpdateStatus(permission_id, "create contact", contact_create == true ? '1' : '0');
    await UpdateStatus(permission_id, "edit contact", contact_edit == true ? '1' : '0');
    await UpdateStatus(permission_id, "delete contact", contact_delete == true ? '1' : '0');
    await UpdateStatus(permission_id, "view contact", contact_view == true ? '1' : '0');
    await UpdateStatus(permission_id, "create template", template_create == true ? '1' : '0');
    await UpdateStatus(permission_id, "edit template", template_edit == true ? '1' : '0');
    await UpdateStatus(permission_id, "delete template", template_delete == true ? '1' : '0');
    await UpdateStatus(permission_id, "view all chat", all_chat_view == true ? '1' : '0');
    await UpdateStatus(permission_id, "broadcast access", broadcast_access == true ? '1' : '0');
    await UpdateStatus(permission_id, "setting access", setting_access == true ? '1' : '0');
    await UpdateStatus(permission_id, "chat assign access", chat_assign_access == true ? '1' : '0');


    return res.status(200).json({
        msg: 'Permission set successfully'
    });



});

export default router;
