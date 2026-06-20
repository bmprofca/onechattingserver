import express from "express";
import pool from "../db.js";
import { auth, CheckUserProjectMaping } from "../middleware/auth.js";
import { RANDOM_STRING, TIMESTAMP, USER_DATA } from "../helpers/function.js";
import { Decrypt } from "../helpers/Decrypt.js";
import { BASE_DOMAIN } from "../helpers/Config.js";
import * as XLSX from "xlsx";
import fs from "node:fs";
import path from "node:path";


const router = express.Router();

router.post("/contact-list", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) { var data = req.body?.data || ""; var key = req.body?.key || ""; }
    const decrypt = Decrypt(data, key);
    if (!decrypt) return res.status(200).json({ error: "Failed to decrypt data" });

    const username = req.headers["username"] ? req.headers["username"] : "";
    const project_id = decrypt?.project_id;
    const query = decrypt?.query || "";
    const last_id = decrypt?.last_id !== undefined && decrypt?.last_id !== null ? Number(decrypt?.last_id) : null;
    const first_id = decrypt?.first_id !== undefined && decrypt?.first_id !== null ? Number(decrypt?.first_id) : null;
    const page_no = decrypt?.page_no !== undefined && decrypt?.page_no !== null ? Number(decrypt?.page_no) : null;
    const is_favorite_only = decrypt?.is_favorite_only ? true : false;
    let limit = Number(decrypt?.limit) || 20;

    // Ensure limit doesn't exceed 100
    if (limit > 100) {
        limit = 100;
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) return res.status(200).json({ error: "User is not assigned on the project" });

    const search = `%${query}%`;

    // Determine pagination mode: 
    // - first_id provided: scroll up (backward)
    // - last_id provided: scroll down (forward)
    // - page_no provided: jump to page
    const useScrollUp = first_id !== null;
    const useScrollDown = last_id !== null && first_id === null;
    const useCursorPagination = useScrollUp || useScrollDown;
    const finalPageNo = page_no || 1;
    const offset = useCursorPagination ? 0 : (finalPageNo - 1) * limit;
    const finalLastId = useScrollDown ? (last_id || 0) : 0;
    const finalFirstId = useScrollUp ? (first_id || 0) : 0;

    let countSql, countParams, sql, sqlParams;

    if (is_favorite_only) {
        // When filtering by favorites, use JOIN with favorite_contacts
        countSql = `SELECT COUNT(DISTINCT c.contact_id) as total 
                    FROM contacts c 
                    INNER JOIN favorite_contacts fc ON c.project_id = fc.project_id 
                        AND c.number = fc.number 
                        AND fc.username = ? 
                        AND fc.status = '1' 
                    WHERE c.project_id = ? 
                        AND c.is_deleted = '0' 
                        AND (c.name LIKE ? OR c.number LIKE ? OR c.email LIKE ? OR c.firm_name LIKE ? OR c.website LIKE ? OR c.remark LIKE ?)`;
        countParams = [username, project_id, search, search, search, search, search, search];

        if (useScrollUp) {
            // Scroll up: get previous contacts (id < first_id, ordered DESC, then reversed)
            sql = `SELECT DISTINCT c.*, 
                    CASE WHEN EXISTS (SELECT 1 FROM favorite_contacts fc_check WHERE fc_check.project_id = c.project_id AND fc_check.number = c.number AND fc_check.username = ? AND fc_check.status = '1') THEN 'yes' ELSE 'no' END AS is_favorite 
                   FROM contacts c 
                   INNER JOIN favorite_contacts fc ON c.project_id = fc.project_id 
                       AND c.number = fc.number 
                       AND fc.username = ? 
                       AND fc.status = '1' 
                   WHERE c.project_id = ? 
                       AND c.is_deleted = '0' 
                       AND c.id < ?
                       AND (c.name LIKE ? OR c.number LIKE ? OR c.email LIKE ? OR c.firm_name LIKE ? OR c.website LIKE ? OR c.remark LIKE ?) 
                   ORDER BY c.name DESC, c.id DESC 
                   LIMIT ?`;
            sqlParams = [username, username, project_id, finalFirstId, search, search, search, search, search, search, limit];
        } else if (useScrollDown) {
            // Scroll down: get next contacts (id > last_id)
            sql = `SELECT DISTINCT c.*, 
                    CASE WHEN EXISTS (SELECT 1 FROM favorite_contacts fc_check WHERE fc_check.project_id = c.project_id AND fc_check.number = c.number AND fc_check.username = ? AND fc_check.status = '1') THEN 'yes' ELSE 'no' END AS is_favorite 
                   FROM contacts c 
                   INNER JOIN favorite_contacts fc ON c.project_id = fc.project_id 
                       AND c.number = fc.number 
                       AND fc.username = ? 
                       AND fc.status = '1' 
                   WHERE c.project_id = ? 
                       AND c.is_deleted = '0' 
                       AND c.id > ?
                       AND (c.name LIKE ? OR c.number LIKE ? OR c.email LIKE ? OR c.firm_name LIKE ? OR c.website LIKE ? OR c.remark LIKE ?) 
                   ORDER BY c.name ASC, c.id ASC 
                   LIMIT ?`;
            sqlParams = [username, username, project_id, finalLastId, search, search, search, search, search, search, limit];
        } else {
            sql = `SELECT DISTINCT c.*, 
                    CASE WHEN EXISTS (SELECT 1 FROM favorite_contacts fc_check WHERE fc_check.project_id = c.project_id AND fc_check.number = c.number AND fc_check.username = ? AND fc_check.status = '1') THEN 'yes' ELSE 'no' END AS is_favorite 
                   FROM contacts c 
                   INNER JOIN favorite_contacts fc ON c.project_id = fc.project_id 
                       AND c.number = fc.number 
                       AND fc.username = ? 
                       AND fc.status = '1' 
                   WHERE c.project_id = ? 
                       AND c.is_deleted = '0' 
                       AND (c.name LIKE ? OR c.number LIKE ? OR c.email LIKE ? OR c.firm_name LIKE ? OR c.website LIKE ? OR c.remark LIKE ?) 
                   ORDER BY c.name ASC 
                   LIMIT ? OFFSET ?`;
            sqlParams = [username, username, project_id, search, search, search, search, search, search, limit, offset];
        }
    } else {
        // When not filtering by favorites, just check if contact is favorite
        countSql = `SELECT COUNT(*) as total 
                    FROM contacts c 
                    WHERE c.project_id = ? 
                        AND c.is_deleted = '0' 
                        AND (c.name LIKE ? OR c.number LIKE ? OR c.email LIKE ? OR c.firm_name LIKE ? OR c.website LIKE ? OR c.remark LIKE ?)`;
        countParams = [project_id, search, search, search, search, search, search];

        if (useScrollUp) {
            // Scroll up: get previous contacts (id < first_id, ordered DESC, then reversed)
            sql = `SELECT c.*, 
                    CASE WHEN EXISTS (SELECT 1 FROM favorite_contacts fc WHERE fc.project_id = c.project_id AND fc.number = c.number AND fc.username = ? AND fc.status = '1') THEN 'yes' ELSE 'no' END AS is_favorite 
                   FROM contacts c 
                   WHERE c.project_id = ? 
                       AND c.is_deleted = '0' 
                       AND c.id < ?
                       AND (c.name LIKE ? OR c.number LIKE ? OR c.email LIKE ? OR c.firm_name LIKE ? OR c.website LIKE ? OR c.remark LIKE ?) 
                   ORDER BY c.name DESC, c.id DESC 
                   LIMIT ?`;
            sqlParams = [username, project_id, finalFirstId, search, search, search, search, search, search, limit];
        } else if (useScrollDown) {
            // Scroll down: get next contacts (id > last_id)
            sql = `SELECT c.*, 
                    CASE WHEN EXISTS (SELECT 1 FROM favorite_contacts fc WHERE fc.project_id = c.project_id AND fc.number = c.number AND fc.username = ? AND fc.status = '1') THEN 'yes' ELSE 'no' END AS is_favorite 
                   FROM contacts c 
                   WHERE c.project_id = ? 
                       AND c.is_deleted = '0' 
                       AND c.id > ?
                       AND (c.name LIKE ? OR c.number LIKE ? OR c.email LIKE ? OR c.firm_name LIKE ? OR c.website LIKE ? OR c.remark LIKE ?) 
                   ORDER BY c.name ASC, c.id ASC 
                   LIMIT ?`;
            sqlParams = [username, project_id, finalLastId, search, search, search, search, search, search, limit];
        } else {
            sql = `SELECT c.*, 
                    CASE WHEN EXISTS (SELECT 1 FROM favorite_contacts fc WHERE fc.project_id = c.project_id AND fc.number = c.number AND fc.username = ? AND fc.status = '1') THEN 'yes' ELSE 'no' END AS is_favorite 
                   FROM contacts c 
                   WHERE c.project_id = ? 
                       AND c.is_deleted = '0' 
                       AND (c.name LIKE ? OR c.number LIKE ? OR c.email LIKE ? OR c.firm_name LIKE ? OR c.website LIKE ? OR c.remark LIKE ?) 
                   ORDER BY c.name ASC 
                   LIMIT ? OFFSET ?`;
            sqlParams = [username, project_id, search, search, search, search, search, search, limit, offset];
        }
    }

    // Get total count for pagination meta (always needed for scrollbar positioning)
    const [total_count_result] = await pool.query(countSql, countParams);
    const total_records = total_count_result[0]?.total || 0;
    const total_pages = Math.ceil(total_records / limit);

    var [rows] = await pool.query(sql, sqlParams);

    // Reverse rows if scrolling up (we queried DESC but need ASC order)
    if (useScrollUp && rows.length > 0) {
        rows = rows.reverse();
    }

    var out = [];
    let lastItemId = finalLastId;
    let firstItemId = finalFirstId;
    if (rows.length > 0) {
        for (let i = 0; i < rows.length; i++) {
            let element = rows[i];
            let contact_id = element.contact_id;
            let name = element.name;
            let number = element.number;
            let email = element.email;
            let website = element.website;
            let firm_name = element.firm_name;
            let remark = element.remark;
            let is_favorite = element?.is_favorite == "yes" ? true : false;

            const [assigned_row] = await pool.query("SELECT * FROM `chat_assigned` WHERE number = ? AND project_id = ? ORDER BY id DESC LIMIT 1", [number, project_id]);
            const agent_id = assigned_row[0]?.username;

            out.push({ name, number, email, assign_to_me: agent_id == username ? true : false, website, firm_name, remark, contact_id, is_favorite });

            // Track the first and last item's id for cursor-based pagination
            if (i === 0) {
                firstItemId = element.id;
            }
            lastItemId = element.id;
        }
    }

    // await new Promise(r => setTimeout(r, 3000));

    // Return response with both pagination methods
    const response = {
        data: out,
        count: rows.length,
        total_records,
        total_pages
    };

    // Add cursor-based pagination info (always included)
    response.last_id = lastItemId;
    response.first_id = firstItemId;

    // has_more logic:
    // - Scroll down: has more if we got full limit
    // - Scroll up: has more if we got full limit (means there might be more before)
    // - Page jump: has more if page < total_pages
    if (useScrollUp) {
        response.has_more = rows.length === limit;
        response.has_more_previous = response.has_more;
    } else if (useScrollDown) {
        response.has_more = rows.length === limit;
        response.has_more_next = response.has_more;
    } else {
        response.has_more = rows.length === limit;
        response.has_more_next = finalPageNo < total_pages;
    }

    // Add traditional pagination meta (always included for scrollbar positioning)
    response.meta = {
        page_no: finalPageNo,
        limit,
        total_records,
        total_pages,
        has_more: finalPageNo < total_pages
    };

    return res.json(response);
});

router.post("/favorite-contact-list", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const query = decrypt?.query;
    const page_no = Number(decrypt?.page_no) || 1;

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const search = `%${query}%`;

    const limit = 20;
    const offset = (page_no - 1) * limit;

    var [rows] = await pool.query(`SELECT favorite_contacts.*, contacts.name, contacts.email, contacts.firm_name, contacts.website, contacts.remark, contacts.number AS contact_number FROM favorite_contacts LEFT JOIN contacts ON contacts.number = favorite_contacts.number AND contacts.project_id = favorite_contacts.project_id AND contacts.is_deleted = '0' WHERE favorite_contacts.project_id = ? AND favorite_contacts.username = ? AND favorite_contacts.status = '1' AND (contacts.name LIKE ? OR contacts.number LIKE ? OR contacts.email LIKE ? OR contacts.firm_name LIKE ? OR contacts.website LIKE ? OR contacts.remark LIKE ? OR favorite_contacts.number LIKE ?) ORDER BY COALESCE(contacts.name, favorite_contacts.number) ASC LIMIT ?, ?`, [project_id, username, search, search, search, search, search, search, search, offset, limit]);


    var data = [];

    if (rows.length > 0) {
        for (let i = 0; i < rows.length; i++) {
            let element = rows[i];

            let contact_id = element.contact_id;
            let name = element.name;
            let number = element.number;
            let email = element.email;
            let website = element.website;
            let firm_name = element.firm_name;
            let remark = element.remark;


            const [assigned_row] = await pool.query(
                "SELECT * FROM `chat_assigned` WHERE number = ? AND project_id = ? ORDER BY id DESC LIMIT 1",
                [number, project_id]
            );

            const agent_id = assigned_row[0]?.username;

            let obj = {
                name,
                number,
                email,
                assign_to_me: agent_id == username ? true : false,
                website,
                firm_name,
                remark,
                contact_id,
                is_favorite: true
            };

            data.push(obj);
        }

    }

    res.json({
        data: data,
        count: rows.length,
        page_no,
        is_last_page: rows.length < limit ? true : false
    });
});

router.post("/create-contact", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const name = decrypt?.name;
    const number = parseInt(decrypt?.number);
    const email = decrypt?.email;
    const firm_name = decrypt?.firm_name;
    const website = decrypt?.website;
    const remark = decrypt?.remark;

    if (!project_id || !name || !number) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const [check_row] = await pool.query("SELECT * FROM `contacts` WHERE project_id = ? AND number = ? AND is_deleted = ?", [project_id, number, '0']);

    if (check_row.length !== 0) {
        return res.status(200).json({ error: 'This contact already exists. You may try to update it.' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }


    try {
        await pool.query("INSERT INTO `contacts`(`contact_id`, `project_id`, `name`, `number`, `email`, `firm_name`, `website`, `remark`, `create_date`, `create_by`, `modify_date`, `modify_by`, `is_deleted`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)", [RANDOM_STRING(20), project_id, name, number, email, firm_name, website, remark, TIMESTAMP(), username, TIMESTAMP(), username, '0']);
        await pool.query("INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)", [project_id, number, username, TIMESTAMP(), username]);
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to create contact',
        });
    }


    const [new_row] = await pool.query("SELECT * FROM `contacts` WHERE project_id = ? AND number = ? AND is_deleted = '0'", [project_id, number]);

    const [assigned_row] = await pool.query("SELECT * FROM `chat_assigned` WHERE number = ? AND project_id = ? ORDER BY id DESC LIMIT 1", [number, project_id]);
    const agent_id = assigned_row[0]?.username;


    if (new_row.length == 1) {
        var new_data = new_row[0];
        var data = {
            name: new_data?.name,
            number: new_data?.number,
            email: new_data?.email,
            assign_to_me: agent_id == username ? true : false,
            website: new_data?.website,
            firm_name: new_data?.firm_name,
            remark: new_data?.remark,
            contact_id: new_data?.contact_id
        }
    }



    return res.status(200).json({
        error: false,
        msg: 'Contact created successfully',
        data: data || []
    });


});

router.post("/contact-details", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const full_number = decrypt?.number;

    if (!project_id || !full_number) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const [check_row] = await pool.query("SELECT * FROM `contacts` WHERE project_id = ? AND number = ? AND is_deleted = '0'", [project_id, full_number]);


    var object = {};

    if (check_row.length > 0) {
        object.has_contact = true;
        const contact_data = check_row[0];
        const create_by = contact_data?.create_by;
        const modify_by = contact_data?.modify_by;
        const create_by_data = await USER_DATA(create_by);
        const modify_by_data = await USER_DATA(modify_by);
        const contact_id = contact_data?.contact_id;

        const contact = {
            name: contact_data?.name,
            number: contact_data?.number,
            email: contact_data?.email,
            firm_name: contact_data?.firm_name,
            website: contact_data?.website,
            remark: contact_data?.remark,
            create_date: contact_data?.create_date,
            modify_date: contact_data?.modify_date,
            contact_id: contact_id,
            modify_by: {
                name: modify_by_data?.name,
                mobile: modify_by_data?.mobile,
                email: modify_by_data?.email,
                status: modify_by_data?.status == '1' ? true : false,
            },
            create_by: {
                name: create_by_data?.name,
                mobile: create_by_data?.mobile,
                email: create_by_data?.email,
                status: create_by_data?.status == '1' ? true : false,
            },
        };

        object.contact = contact;
    } else {
        object.has_contact = false;
    }

    return res.status(200).json(object)
});

router.post("/update-contact", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const contact_id = decrypt?.contact_id;
    const project_id = decrypt?.project_id;
    const name = decrypt?.name;
    const number = decrypt?.number;
    const email = decrypt?.email;
    const firm_name = decrypt?.firm_name;
    const website = decrypt?.website;
    const remark = decrypt?.remark;

    if (!project_id || !name || !number || !contact_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }


    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const [check_row] = await pool.query("SELECT * FROM `contacts` WHERE project_id = ? AND contact_id = ? AND is_deleted = ?", [project_id, contact_id, '0']);

    if (check_row.length == 0) {
        return res.status(200).json({ error: 'Invalid contact id' })
    }

    try {
        await pool.query("UPDATE `contacts` SET `contact_id`=?,`name`=?,`number`=?,`email`=?,`firm_name`=?,`website`=?,`remark`=?,`modify_date`=?,`modify_by`=? WHERE project_id = ? AND contact_id = ?", [contact_id, name, number, email, firm_name, website, remark, TIMESTAMP(), username, project_id, contact_id]);

        return res.status(200).json({
            error: false,
            msg: 'Contact updated successfully'
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to update contact',
        });
    }

});

router.post("/delete-contact", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const all_contact_delete =
        decrypt?.all_contact_delete === true ||
        decrypt?.all_contact_delete === 'true' ||
        decrypt?.all_contact_delete === 1 ||
        decrypt?.all_contact_delete === '1';

    const contact_ids = decrypt?.contact_ids || [];
    const numbers = decrypt?.numbers || [];
    const project_id = decrypt?.project_id;

    if (!project_id) {
        return res.status(200).json({ error: 'project_id is required' });
    }

    // Only validate contact_ids/numbers if all_contact_delete is false
    if (!all_contact_delete) {
        const hasIds = Array.isArray(contact_ids) && contact_ids.length > 0;
        const hasNumbers = Array.isArray(numbers) && numbers.length > 0;

        if (!hasIds && !hasNumbers) {
            return res.status(200).json({ error: 'Provide contact_ids or numbers array (or both)' });
        }
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        // ---------------------------
        // Build WHERE once, reuse it
        // ---------------------------
        let whereSql = '';
        let whereParams = [];

        if (all_contact_delete) {
            whereSql = 'project_id = ? AND is_deleted = ?';
            whereParams = [project_id, '0'];
        } else {
            const conditions = [];
            const filterParams = [];

            if (Array.isArray(contact_ids) && contact_ids.length > 0) {
                conditions.push(`contact_id IN (${contact_ids.map(() => '?').join(',')})`);
                filterParams.push(...contact_ids);
            }

            if (Array.isArray(numbers) && numbers.length > 0) {
                conditions.push(`number IN (${numbers.map(() => '?').join(',')})`);
                filterParams.push(...numbers);
            }

            // conditions will not be empty due to validation above
            whereSql = `project_id = ? AND is_deleted = ? AND (${conditions.join(' OR ')})`;
            whereParams = [project_id, '0', ...filterParams];
        }

        // Check if any contacts exist before deleting
        const [check_rows] = await pool.query(
            `SELECT COUNT(*) as count FROM \`contacts\` WHERE ${whereSql}`,
            whereParams
        );

        if (check_rows[0].count === 0) {
            return res.status(200).json({ error: 'No valid contacts found to delete' });
        }

        // IMPORTANT: update params must follow placeholder order
        // SET params first, then WHERE params (which start with project_id, '0')
        const updateParams = ['1', username, TIMESTAMP(), username, ...whereParams];

        const [result] = await pool.query(
            `UPDATE \`contacts\`
             SET \`is_deleted\`=?, \`delete_by\`=?, \`modify_date\`=?, \`modify_by\`=?
             WHERE ${whereSql}`,
            updateParams
        );

        return res.status(200).json({
            error: false,
            msg: `${result.affectedRows} contact(s) deleted successfully`,
            deleted_count: result.affectedRows
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to delete contact(s)',
            e: error.message || error
        });
    }
});


router.post("/mark-as-favorite", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const number = decrypt?.number;
    const action = decrypt?.action;

    if (!project_id || !number || !action) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    if (action != 'add' && action != 'delete') {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    try {
        const [check_row] = await pool.query("SELECT * FROM `favorite_contacts` WHERE project_id = ? AND username = ? AND number = ?", [project_id, username, number]);

        if (check_row.length == 0) {
            // INSERT
            if (action == 'add') {
                await pool.query("INSERT INTO `favorite_contacts`(`favorite_id`, `username`, `number`, `project_id`, `create_date`, `create_by`, `modify_date`, `modify_by`, `status`) VALUES (?,?,?,?,?,?,?,?,?)", [RANDOM_STRING(30), username, number, project_id, TIMESTAMP(), username, TIMESTAMP(), username, '1']);
            }
        } else {
            // UPDATE
            var status = action == 'add' ? '1' : '0';
            await pool.query("UPDATE `favorite_contacts` SET `modify_date`=?,`modify_by`=?,`status`=? WHERE project_id = ? AND username = ? AND number = ?", [TIMESTAMP(), username, status, project_id, username, number]);
        }


        const [new_row] = await pool.query("SELECT * FROM `favorite_contacts` WHERE project_id = ? AND username = ? AND number = ?", [project_id, username, number]);

        const new_data = new_row[0];

        return res.status(200).json({
            error: false,
            is_favorite: new_data?.status == '1' ? true : false,
        });
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to change favorite',
        });
    }

});

router.post("/create-group", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const name = decrypt?.name;
    const remark = decrypt?.remark;

    if (!project_id || !name) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }


    try {
        const group_id = RANDOM_STRING(30);
        await pool.query("INSERT INTO `contact_groups`(`group_id`, `name`, `remark`, `create_date`, `create_by`, `modify_date`, `modify_by`, `is_deleted`,`project_id`) VALUES (?,?,?,?,?,?,?,?,?)", [group_id, name, remark, TIMESTAMP(), username, TIMESTAMP(), username, '0', project_id]);

        const creator_data = await USER_DATA(username);

        return res.status(200).json({
            error: false,
            msg: 'Group created successfully',
            data: {
                group_id,
                name,
                remark,
                create_by: {
                    username: creator_data?.username,
                    name: creator_data?.name,
                    mobile: creator_data?.mobile,
                    email: creator_data?.email,
                    status: creator_data?.status == '1' ? true : false,
                },
            }
        });

    } catch (error) {
        return res.status(200).json({ error: 'Failed to create group', e: error });
    }

});

router.post("/delete-group", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const group_id = decrypt?.group_id;

    if (!project_id || !group_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }


    const [check_row] = await pool.query("SELECT * FROM contact_groups WHERE group_id = ? AND project_id = ? AND is_deleted = ?", [group_id, project_id, '0']);

    if (check_row.length == 0) {
        return res.status(200).json({ error: 'Invalid group id' });
    }


    try {
        await pool.query("UPDATE `contact_groups` SET `modify_date`=?,`modify_by`=?,`is_deleted`=?,`delete_by`=? WHERE group_id = ? AND project_id = ?", [TIMESTAMP(), username, '1', username, group_id, project_id]);

        return res.status(200).json({ error: false, msg: 'Group deleted successfully' });

    } catch (error) {
        return res.status(200).json({ error: 'Failed to create group', e: error });
    }

});

router.post("/edit-group", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const group_id = decrypt?.group_id;
    const name = decrypt?.name;
    const remark = decrypt?.remark;

    if (!project_id || !group_id || !name) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }


    const [check_row] = await pool.query("SELECT * FROM contact_groups WHERE group_id = ? AND project_id = ? AND is_deleted = ?", [group_id, project_id, '0']);

    if (check_row.length == 0) {
        return res.status(200).json({ error: 'Invalid group id' });
    }


    try {
        await pool.query("UPDATE `contact_groups` SET `name`=?,`remark`=?,`modify_date`=?,`modify_by`=? WHERE project_id = ? AND group_id = ?", [name, remark, TIMESTAMP(), username, project_id, group_id]);

        return res.status(200).json({ error: false, msg: 'Group edited successfully' });

    } catch (error) {
        return res.status(200).json({ error: 'Failed to edit group', e: error });
    }

});

router.post("/group-contact-add", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const group_id = decrypt?.group_id;
    const contact_id = decrypt?.contact_id;

    if (!project_id || !group_id || !contact_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    const [check_row] = await pool.query("SELECT * FROM `contact_group_mapping` WHERE `group_id` = ? AND `contact_id` = ? AND `is_deleted` = ?", [group_id, contact_id, '0']);

    if (check_row.length > 0) {
        return res.status(200).json({
            error: 'Contact already exist in the group'
        })
    }

    const [contact_check] = await pool.query("SELECT * FROM `contacts` WHERE `project_id` = ? AND `contact_id` = ? AND `is_deleted` = ?", [project_id, contact_id, '0']);

    if (contact_check.length === 0) {
        return res.status(200).json({
            error: 'Invalid contact id'
        })
    }

    const [group_check] = await pool.query("SELECT * FROM `contact_groups` WHERE `project_id` = ? AND `group_id` = ? AND `is_deleted` = ?", [project_id, group_id, '0']);

    if (group_check.length === 0) {
        return res.status(200).json({
            error: 'Invalid group id'
        })
    }

    try {
        const unique_id = RANDOM_STRING(30);
        await pool.query("INSERT INTO `contact_group_mapping`(`unique_id`, `contact_id`, `group_id`, `create_date`, `create_by`, `modify_date`, `modify_by`, `is_deleted`) VALUES (?,?,?,?,?,?,?,?)", [unique_id, contact_id, group_id, TIMESTAMP(), username, TIMESTAMP(), username, '0'])

        const contact_data = contact_check[0];
        const name = contact_data?.name;
        const number = contact_data?.number;

        const creator_data = await USER_DATA(username);

        return res.status(200).json({
            error: false,
            msg: 'Contact added successfully',
            data: {
                unique_id,
                name,
                number,
                contact_id,
                group_id,
                create_by: {
                    name: creator_data?.name,
                    username: creator_data?.username,
                    mobile: creator_data?.mobile,
                    email: creator_data?.email,
                    status: creator_data?.status == '1' ? true : false,
                }
            }
        })
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to add contact',
            e: error
        })
    }



});

router.post("/group-contact-delete", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    console.log(decrypt);


    const username = req.headers["username"] ? req.headers["username"] : '';
    const all_contact_delete = decrypt?.all_contact_delete === true || decrypt?.all_contact_delete === 'true' || decrypt?.all_contact_delete === 1;
    const project_id = decrypt?.project_id;
    const group_id = decrypt?.group_id;
    const unique_ids = Array.isArray(decrypt?.unique_ids) ? decrypt.unique_ids : [];
    const contact_ids = Array.isArray(decrypt?.contact_ids) ? decrypt.contact_ids : [];

    if (!project_id || !group_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    // Only validate unique_ids/contact_ids if all_contact_delete is false
    if (!all_contact_delete) {
        if (unique_ids.length === 0 && contact_ids.length === 0) {
            return res.status(200).json({ error: 'Provide at least one of unique_ids or contact_ids' });
        }
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    // Validate group_id exists in contact_groups for the given project_id and is not deleted
    const [group_check] = await pool.query("SELECT * FROM `contact_groups` WHERE `project_id` = ? AND `group_id` = ? AND `is_deleted` = ?", [project_id, group_id, '0']);

    if (group_check.length === 0) {
        return res.status(200).json({
            error: 'Invalid group id'
        })
    }

    // Build WHERE clause dynamically
    const whereConditions = [];
    const whereParams = [];

    if (all_contact_delete) {
        // Delete all contacts from the group where is_deleted = '0'
        whereConditions.push('group_id = ?');
        whereParams.push(group_id);
        whereConditions.push('is_deleted = ?');
        whereParams.push('0');
    } else {
        // Existing logic for specific unique_ids or contact_ids
        if (unique_ids.length > 0 && contact_ids.length > 0) {
            // Both arrays provided - use OR
            const uniquePlaceholders = unique_ids.map(() => '?').join(',');
            const contactPlaceholders = contact_ids.map(() => '?').join(',');
            whereConditions.push(`(unique_id IN (${uniquePlaceholders}) OR contact_id IN (${contactPlaceholders}))`);
            whereParams.push(...unique_ids, ...contact_ids);
        } else if (unique_ids.length > 0) {
            // Only unique_ids provided
            const placeholders = unique_ids.map(() => '?').join(',');
            whereConditions.push(`unique_id IN (${placeholders})`);
            whereParams.push(...unique_ids);
        } else if (contact_ids.length > 0) {
            // Only contact_ids provided
            const placeholders = contact_ids.map(() => '?').join(',');
            whereConditions.push(`contact_id IN (${placeholders})`);
            whereParams.push(...contact_ids);
        }

        // Always add group_id and is_deleted conditions
        whereConditions.push('group_id = ?');
        whereParams.push(group_id);
        whereConditions.push('is_deleted = ?');
        whereParams.push('0');
    }

    const whereClause = whereConditions.join(' AND ');

    // Check if any valid (non-deleted) mappings exist
    const checkSql = `SELECT * FROM \`contact_group_mapping\` WHERE ${whereClause}`;
    const [check_row] = await pool.query(checkSql, whereParams);

    if (check_row.length === 0) {
        return res.status(200).json({
            error: 'No valid contact mappings found'
        })
    }

    try {
        // Update all matching records
        // Build params: [modify_date, modify_by, is_deleted, delete_by, ...whereParams]
        const updateParams = [TIMESTAMP(), username, '1', username, ...whereParams];
        const updateSql = `UPDATE \`contact_group_mapping\` SET \`modify_date\`=?, \`modify_by\`=?, \`is_deleted\`=?, \`delete_by\`=? WHERE ${whereClause}`;
        await pool.query(updateSql, updateParams);

        return res.status(200).json({
            error: false,
            msg: 'Contacts deleted successfully from group',
            deleted_count: check_row.length
        })
    } catch (error) {
        return res.status(200).json({
            error: 'Failed to delete contact from group',
            e: error
        })
    }



});

router.post("/export-contacts", auth, async (req, res) => {
    try {
        const body = req.body || {};
        const data = body?.data || "";
        const key = body?.key || "";

        const decrypt = Decrypt(data, key);

        if (!decrypt) {
            return res.status(200).json({ error: "Failed to decrypt data" });
        }

        const username = req.headers["username"] ? String(req.headers["username"]) : "";
        const project_id = decrypt?.project_id;
        const type = decrypt?.type;

        if (!project_id || !type) {
            return res.status(200).json({ error: "Provide all mandetory fields" });
        }

        if (type == 'excel') {
            const check_project_mapping = await CheckUserProjectMaping(username, project_id);
            if (!check_project_mapping) {
                return res.status(200).json({ error: "User is not assigned on the project" });
            }

            const [rows] = await pool.query(
                "SELECT * FROM contacts WHERE project_id = ? AND is_deleted = ? ORDER BY name ASC",
                [project_id, "0"]
            );

            const contacts = rows.map((e) => ({
                Name: e?.name || "",
                Number: e?.number || "",
                Email: e?.email || "",
                "Firm Name": e?.firm_name || "",
                Website: e?.website || "",
                Remark: e?.remark || "",
                "Create Date": e?.create_date || "",
            }));

            const wb = XLSX.utils.book_new();
            const ws = XLSX.utils.json_to_sheet(contacts, { skipHeader: false });

            ws["!cols"] = [
                { wch: 25 }, // Name
                { wch: 18 }, // Number
                { wch: 28 }, // Email
                { wch: 28 }, // Firm Name
                { wch: 25 }, // Website
                { wch: 30 }, // Remark
                { wch: 22 }, // Create Date
            ];

            XLSX.utils.book_append_sheet(wb, ws, "Contacts");

            const exportDir = path.join(process.cwd(), "media", "export");
            if (!fs.existsSync(exportDir)) fs.mkdirSync(exportDir, { recursive: true });

            const filename = `${RANDOM_STRING(30)}.xlsx`;
            const filePath = path.join(exportDir, filename);

            XLSX.writeFile(wb, filePath);

            const url = `${BASE_DOMAIN}/export/${filename}`;

            return res.status(200).json({
                error: false,
                msg: "Contacts exported successfully",
                type,
                url
            });
        } else {
            return res.status(200).json({
                error: "Not a valid type",
            });
        }
    } catch (err) {
        return res.status(200).json({
            error: "Server error while exporting contacts",
        });
    }
});

router.post("/import-contacts", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    // Decrypt if data and key are provided, otherwise use req.body directly
    let decrypt;
    if (data && key) {
        decrypt = Decrypt(data, key);
        if (!decrypt) {
            return res.status(200).json({ error: 'Failed to decrypt data' });
        }
    } else {
        decrypt = req.body;
    }

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const url = decrypt?.url;
    const name_index = Number(decrypt?.name_index);
    const number_index = Number(decrypt?.number_index);
    const start_row = Number(decrypt?.start_row) || 1;
    const end_row = decrypt?.end_row !== undefined && decrypt?.end_row !== null ? Number(decrypt?.end_row) : null;
    const email_index = decrypt?.email_index !== undefined && decrypt?.email_index !== null ? Number(decrypt?.email_index) : null;
    const firm_name_index = decrypt?.firm_name_index !== undefined && decrypt?.firm_name_index !== null ? Number(decrypt?.firm_name_index) : null;
    const website_index = decrypt?.website_index !== undefined && decrypt?.website_index !== null ? Number(decrypt?.website_index) : null;
    const remark_index = decrypt?.remark_index !== undefined && decrypt?.remark_index !== null ? Number(decrypt?.remark_index) : null;

    // Validate mandatory fields
    if (!project_id || !url) {
        return res.status(200).json({ error: 'Provide all mandatory fields: project_id, url' });
    }

    // Validate indices - number_index is required, name_index defaults to 0
    const final_name_index = isNaN(name_index) ? 0 : name_index;
    const final_number_index = isNaN(number_index) ? null : number_index;

    if (final_number_index === null) {
        return res.status(200).json({ error: 'Provide all mandatory fields: number_index' });
    }

    // Validate indices are non-negative
    if (final_name_index < 0 || final_number_index < 0 ||
        (email_index !== null && email_index < 0) ||
        (firm_name_index !== null && firm_name_index < 0) ||
        (website_index !== null && website_index < 0) ||
        (remark_index !== null && remark_index < 0)) {
        return res.status(200).json({ error: 'All column indices must be non-negative numbers' });
    }

    // Validate start_row is non-negative
    if (start_row < 0) {
        return res.status(200).json({ error: 'start_row must be a non-negative number' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' });
    }

    try {
        // Handle Google Sheets URL conversion
        let finalUrl = url;
        const gsMatch = String(url || "").match(/https:\/\/docs\.google\.com\/spreadsheets\/d\/([^/]+)/i);
        if (gsMatch && gsMatch[1]) {
            const sheetId = gsMatch[1];
            const gidMatch = String(url || "").match(/gid=(\d+)/i);
            const gid = gidMatch ? gidMatch[1] : null;

            finalUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=xlsx`;
            if (gid) finalUrl += `&gid=${gid}`;
        }

        // Download and parse Excel file
        const fileResp = await fetch(finalUrl, { redirect: "follow" });

        if (!fileResp.ok) {
            const status = fileResp.status;
            let msg = `File not readable. HTTP ${status}`;
            if (status === 401) msg = "File not readable: Unauthorized (401) — link requires login/token.";
            if (status === 403) msg = "File not readable: Forbidden (403) — file is restricted / no permission.";
            if (status === 404) msg = "File not readable: Not found (404) — wrong/expired link or not shared.";
            return res.status(200).json({ error: msg });
        }

        const arrayBuffer = await fileResp.arrayBuffer();
        const buf = Buffer.from(arrayBuffer);

        const contentType = String(fileResp.headers.get("content-type") || "").toLowerCase();
        const head = buf.slice(0, 200).toString("utf8").trim().toLowerCase();
        const looksLikeHtml =
            contentType.includes("text/html") ||
            head.startsWith("<!doctype") ||
            head.startsWith("<html") ||
            head.startsWith("<");

        if (looksLikeHtml) {
            return res.status(200).json({
                error: "File not readable: link returned an HTML page (usually permission/login page). If this is Google Sheets/Drive, set sharing to 'Anyone with the link can view' or provide a direct downloadable link/export link."
            });
        }

        const workbook = XLSX.read(buf, { type: "buffer" });
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

        // Validate rows array is not empty
        if (!rows || rows.length === 0) {
            return res.status(200).json({ error: 'Excel file is empty or has no data rows' });
        }

        // Calculate actual end row
        const maxRowIndex = rows.length - 1;
        const actualEndRow = end_row !== null && end_row <= maxRowIndex ? end_row : maxRowIndex;

        // Validate start_row is within bounds
        if (start_row > actualEndRow) {
            return res.status(200).json({
                error: `start_row (${start_row}) is greater than end_row (${actualEndRow}). File has ${rows.length} rows (0-indexed).`
            });
        }

        const failedRows = [];
        let successCount = 0;
        let duplicateCount = 0;
        let errorCount = 0;

        // Get existing contacts to check for duplicates
        const [existingContacts] = await pool.query(
            "SELECT number FROM contacts WHERE project_id = ? AND is_deleted = '0'",
            [project_id]
        );
        const existingNumbers = new Set(existingContacts.map(c => String(c.number)));

        // Process rows
        for (let r = start_row; r <= actualEndRow; r++) {
            const row = rows[r] || [];
            const name = String(row[final_name_index] || "").trim();
            const number = String(row[final_number_index] || "").trim().replace(/\D/g, ""); // Remove non-digits
            const email = email_index !== null ? String(row[email_index] || "").trim() : null;
            const firm_name = firm_name_index !== null ? String(row[firm_name_index] || "").trim() : null;
            const website = website_index !== null ? String(row[website_index] || "").trim() : null;
            const remark = remark_index !== null ? String(row[remark_index] || "").trim() : null;

            // Validate required fields - check number after cleaning
            if (!number || number.length === 0 || !name || name.length === 0) {
                failedRows.push([...row, "Missing required fields: name or number"]);
                errorCount++;
                continue;
            }

            // Check for duplicate number
            if (existingNumbers.has(number)) {
                failedRows.push([...row, "Duplicate contact number"]);
                duplicateCount++;
                continue;
            }

            try {
                const contact_id = RANDOM_STRING(20);
                await pool.query(
                    "INSERT INTO `contacts`(`contact_id`, `project_id`, `name`, `number`, `email`, `firm_name`, `website`, `remark`, `create_date`, `create_by`, `modify_date`, `modify_by`, `is_deleted`) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    [contact_id, project_id, name, number, email || null, firm_name || null, website || null, remark || null, TIMESTAMP(), username, TIMESTAMP(), username, '0']
                );

                // Assign contact to user (check if already assigned)
                const [existingAssign] = await pool.query(
                    "SELECT * FROM `chat_assigned` WHERE project_id = ? AND number = ? AND username = ?",
                    [project_id, number, username]
                );
                if (existingAssign.length === 0) {
                    await pool.query(
                        "INSERT INTO `chat_assigned`(`project_id`, `number`, `username`, `create_date`, `create_by`) VALUES (?,?,?,?,?)",
                        [project_id, number, username, TIMESTAMP(), username]
                    );
                }

                existingNumbers.add(number); // Add to set to prevent duplicates in same batch
                successCount++;
            } catch (error) {
                failedRows.push([...row, error.message || "Database error"]);
                errorCount++;
            }
        }

        // Generate error file if there are failures
        let errorFileUrl = null;
        if (failedRows.length > 0) {
            const errorDir = path.join(process.cwd(), "media", "error");
            if (!fs.existsSync(errorDir)) fs.mkdirSync(errorDir, { recursive: true });

            const errorWB = XLSX.utils.book_new();
            const headerRow = rows[0] || [];
            const errorWS = XLSX.utils.aoa_to_sheet([
                [...headerRow, "Error"],
                ...failedRows
            ]);
            XLSX.utils.book_append_sheet(errorWB, errorWS, "FailedRows");
            const filename = `${RANDOM_STRING(30)}.xlsx`;
            const filePath = path.join(errorDir, filename);
            XLSX.writeFile(errorWB, filePath);
            errorFileUrl = `${BASE_DOMAIN}/error/${filename}`;
        }

        return res.status(200).json({
            error: false,
            msg: 'Bulk contact import completed',
            data: {
                total: actualEndRow - start_row + 1,
                success: successCount,
                failed: errorCount,
                duplicates: duplicateCount,
                error_file: errorFileUrl
            }
        });

    } catch (error) {
        return res.status(200).json({
            error: 'Failed to process bulk import',
            e: error.message || error
        });
    }
});

router.post("/group-list", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const page_no = Number(decrypt?.page_no) || 1;
    let limit = Number(decrypt?.limit) || 20;

    // Ensure limit doesn't exceed 100
    if (limit > 100) {
        limit = 100;
    }

    const offset = (page_no - 1) * limit;

    if (!project_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }

    // Get total count for meta
    const [total_count_result] = await pool.query("SELECT COUNT(*) as total FROM `contact_groups` WHERE project_id = ? AND is_deleted = ?", [project_id, '0']);
    const total_records = total_count_result[0]?.total || 0;
    const total_pages = Math.ceil(total_records / limit);

    var [row] = await pool.query("SELECT * FROM `contact_groups` WHERE project_id = ? AND is_deleted = ? ORDER BY id DESC LIMIT ? OFFSET ?", [project_id, '0', limit, offset]);


    const res_data = [];

    for (let index = 0; index < row.length; index++) {
        const element = row[index];


        const creator_data = await USER_DATA(element?.create_by);
        const modifier_data = await USER_DATA(element?.modify_by);

        const group_id = element?.group_id;

        const [contact_count_row] = await pool.query("SELECT `id` FROM `contact_group_mapping` WHERE group_id = ? AND is_deleted = ?", [group_id, '0'])

        const contact_count = contact_count_row.length;

        const object = {
            group_id: element?.group_id,
            name: element?.name,
            remark: element?.remark,
            create_by: {
                username: creator_data?.username,
                name: creator_data?.name,
                mobile: creator_data?.mobile,
                email: creator_data?.email,
                status: creator_data?.status == '1' ? true : false,
            },
            modify_by: {
                username: modifier_data?.username,
                name: modifier_data?.name,
                mobile: modifier_data?.mobile,
                email: modifier_data?.email,
                status: modifier_data?.status == '1' ? true : false,
            },
            contact_count
        };

        res_data.push(object);

    }

    return res.status(200).json({
        data: res_data,
        count: res_data.length,
        meta: {
            page_no,
            limit,
            total_records,
            total_pages,
            has_more: page_no < total_pages
        }
    })
});

router.post("/group-contact-list", auth, async (req, res) => {
    if (req.body && Object.keys(req.body).length > 0) {
        var data = req.body?.data || '';
        var key = req.body?.key || '';
    }

    const decrypt = Decrypt(data, key);

    if (!decrypt) {
        return res.status(200).json({ error: 'Failed to decrypt data' });
    }

    const username = req.headers["username"] ? req.headers["username"] : '';
    const project_id = decrypt?.project_id;
    const group_id = decrypt?.group_id;
    const page_no = Number(decrypt?.page_no) || 1;
    let limit = Number(decrypt?.limit) || 20;
    const search = (decrypt?.search ?? '').toString().trim();

    // Ensure limit doesn't exceed 100
    if (limit > 100) {
        limit = 100;
    }

    const offset = (page_no - 1) * limit;

    if (!project_id || !group_id) {
        return res.status(200).json({ error: 'Provide all mandetory fields' });
    }

    const check_project_mapping = await CheckUserProjectMaping(username, project_id);
    if (!check_project_mapping) {
        return res.status(200).json({ error: 'User is not assigned on the project' })
    }


    const [group_check] = await pool.query("SELECT * FROM `contact_groups` WHERE `project_id` = ? AND `group_id` = ? AND `is_deleted` = ?", [project_id, group_id, '0']);

    if (group_check.length === 0) {
        return res.status(200).json({
            error: 'Invalid group id'
        })
    }

    const hasSearch = !!search;
    const whereSearch = hasSearch
        ? ` AND (
                c.name LIKE ? OR
                c.number LIKE ? OR
                c.email LIKE ? OR
                c.firm_name LIKE ? OR
                c.website LIKE ? OR
                c.remark LIKE ?
            )`
        : '';

    const countParams = [group_id, '0'];
    if (hasSearch) {
        const like = `%${search}%`;
        countParams.push(like, like, like, like, like, like);
    }

    // Get total count for meta (search-aware)
    const [total_count_result] = await pool.query(
        `SELECT COUNT(*) as total
         FROM contact_group_mapping cgm
         INNER JOIN contacts c ON c.contact_id = cgm.contact_id AND c.is_deleted = '0'
         WHERE cgm.group_id = ? AND cgm.is_deleted = ?${whereSearch}`,
        countParams
    );
    const total_records = total_count_result[0]?.total || 0;
    const total_pages = Math.ceil(total_records / limit);

    const listParams = [group_id, '0'];
    if (hasSearch) {
        const like = `%${search}%`;
        listParams.push(like, like, like, like, like, like);
    }
    listParams.push(limit, offset);

    // Fetch mappings + contact fields in one query (search-aware)
    var [row] = await pool.query(
        `SELECT cgm.*, c.name AS contact_name, c.number AS contact_number
         FROM contact_group_mapping cgm
         INNER JOIN contacts c ON c.contact_id = cgm.contact_id AND c.is_deleted = '0'
         WHERE cgm.group_id = ? AND cgm.is_deleted = ?${whereSearch}
         ORDER BY cgm.id DESC
         LIMIT ? OFFSET ?`,
        listParams
    );


    const res_data = [];

    for (let index = 0; index < row.length; index++) {
        const element = row[index];

        const unique_id = element?.unique_id;
        const contact_id = element?.contact_id;

        const creator_data = await USER_DATA(element?.create_by);

        const group_id = element?.group_id;

        const object = {
            unique_id,
            name: element?.contact_name,
            number: element?.contact_number,
            contact_id,
            group_id,
            create_by: {
                name: creator_data?.name,
                username: creator_data?.username,
                mobile: creator_data?.mobile,
                email: creator_data?.email,
                status: creator_data?.status == '1' ? true : false,
            }
        };

        res_data.push(object);

    }

    return res.status(200).json({
        data: res_data,
        count: res_data.length,
        meta: {
            page_no,
            limit,
            total_records,
            total_pages,
            has_more: page_no < total_pages
        }
    })

});

export default router;
