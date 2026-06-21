import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP, USER_DATA, USER_DATA_MAP } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";

const router = express.Router();

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
    const email = decrypt.email;
    const permission_id = decrypt.permission_id;

    if (!project_id || !email || !permission_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const [email_check_row] = await pool.query("SELECT * FROM users WHERE email = ? AND status = ?", [email, '1']);

    if (email_check_row.length !== 1) {
        return res.status(200).json({ error: 'User not registered on given email' })
    }

    const agent_data = email_check_row[0];
    const agent_username = agent_data?.username;
    const [check_already_exist] = await pool.query("SELECT * FROM project_mapping WHERE project_id = ? AND username = ? AND is_deleted = ?", [project_id, agent_username, '0']);

    if (check_already_exist.length > 0) {
        return res.status(200).json({ error: 'Agent already added' })
    }

    try {
        const unique_id = RANDOM_STRING(30);
        await pool.query("INSERT INTO `project_mapping`(`unique_id`, `project_id`, `username`, `type`, `create_by`, `create_date`, `modify_by`, `modify_date`, `is_deleted`,`permission_id`) VALUES (?,?,?,?,?,?,?,?,?,?)", [unique_id, project_id, agent_username, 'agent', username, TIMESTAMP(), username, TIMESTAMP(), '0', permission_id]);

        return res.status(200).json({ msg: 'Agent added successfully' })
    } catch (error) {
        res.json({
            error: 'Failed to add agent',
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

    const [row] = await pool.query("SELECT project_mapping.*,users.name,users.email, users.mobile, users.status,permission_list.name AS permission_name FROM `project_mapping` JOIN users ON users.username = project_mapping.username JOIN permission_list ON permission_list.permission_id = project_mapping.permission_id WHERE project_mapping.project_id = ? AND project_mapping.type = ? AND project_mapping.is_deleted = ? ORDER BY users.name ASC", [project_id, 'agent', '0']);

    const auditUsernames = row.flatMap((element) => [element.create_by, element.modify_by]);
    const userMap = await USER_DATA_MAP(auditUsernames);

    const res_data = [];

    for (let index = 0; index < row.length; index++) {
        const element = row[index];

        const name = element?.name;
        const mobile = element?.mobile;
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
            }
        };

        res_data.push(object);

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
    const email = decrypt.email;


    if (!project_id || !email) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    // CHECK USER REGISTERED
    const [checo_user] = await pool.query("SELECT * FROM users WHERE email = ? AND status = ?", [email, '1']);
    if (checo_user.length !== 1) {
        return res.status(200).json({ error: 'User not registered of given email', agent_exist: false });
    }

    const agent_data = checo_user[0];
    const agent_username = agent_data?.username;

    const [check_agent_exist] = await pool.query("SELECT * FROM project_mapping WHERE username = ? AND project_id = ? AND is_deleted = ?", [agent_username, project_id, '0']);

    if (check_agent_exist.length > 0) {
        return res.status(200).json({ error: 'User already added', agent_exist: false })
    }


    return res.status(200).json({
        agent_exist: true,
        data: {
            name: agent_data?.name,
            email: agent_data?.email,
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

export default router;
