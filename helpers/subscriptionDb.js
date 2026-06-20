import pool from "../db.js";
import crypto from "crypto";
import { TIMESTAMP, RANDOM_STRING } from "./function.js";

// Generate unique ID without external dependencies
const generateUniqueId = () => {
    return crypto.randomBytes(16).toString('hex').toUpperCase();
};

/**
 * Get user wallet balance
 * @param {string} username - Username
 */
export const getUserWalletBalance = async (username) => {
    try {
        const [rows] = await pool.query(
            `SELECT 
                SUM(CASE WHEN type = '1' THEN amount ELSE 0 END) AS total_credit,
                SUM(CASE WHEN type = '0' THEN amount ELSE 0 END) AS total_debit
             FROM transactions 
             WHERE username = ?`,
            [username]
        );

        const total_credit = Number(rows[0]?.total_credit || 0);
        const total_debit = Number(rows[0]?.total_debit || 0);
        const balance = total_credit - total_debit;

        return balance;
    } catch (error) {
        return 0;
    }
};

// ============================================
// CUSTOM PRICING MANAGEMENT
// ============================================

/**
 * Get custom pricing for user and pack
 * @param {string} username - Username
 * @param {string} packId - Pack ID
 */
const getCustomPricing = async (username, packId) => {
    try {
        const [rows] = await pool.query(
            "SELECT * FROM user_pack_pricing WHERE username = ? AND pack_id = ? AND is_active = '1' LIMIT 1",
            [username, packId]
        );
        return rows.length > 0 ? rows[0] : null;
    } catch (error) {
        return null;
    }
};

/**
 * Set custom pricing for user (Admin only)
 * @param {object} pricingData - Pricing details
 */
export const setUserPackPricing = async (pricingData) => {
    const {
        username,
        pack_id,
        custom_amount,
        is_active = '1',
        created_by
    } = pricingData;

    try {
        if (!username || !pack_id || custom_amount === undefined) {
            return { success: false, error: "Username, pack_id, and custom_amount are required" };
        }

        // Check if pack exists
        const packResult = await getPackById(pack_id);
        if (!packResult.success) {
            return { success: false, error: "Invalid pack" };
        }

        const customAmount = Number(custom_amount);
        if (isNaN(customAmount) || customAmount < 0) {
            return { success: false, error: "Invalid custom amount" };
        }

        // Check if custom pricing already exists
        const [existing] = await pool.query(
            "SELECT * FROM user_pack_pricing WHERE username = ? AND pack_id = ?",
            [username, pack_id]
        );

        if (existing.length > 0) {
            // Update existing
            await pool.query(
                `UPDATE user_pack_pricing 
                 SET custom_amount = ?, is_active = ?, updated_at = NOW()
                 WHERE username = ? AND pack_id = ?`,
                [customAmount, is_active, username, pack_id]
            );
        } else {
            // Insert new
            await pool.query(
                `INSERT INTO user_pack_pricing 
                (username, pack_id, custom_amount, is_active, created_by) 
                VALUES (?, ?, ?, ?, ?)`,
                [username, pack_id, customAmount, is_active, created_by]
            );
        }

        return {
            success: true,
            message: "Custom pricing set successfully",
            username,
            pack_id,
            custom_amount: customAmount
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Remove custom pricing for user (Admin only)
 * @param {string} username - Username
 * @param {string} packId - Pack ID
 */
export const removeUserPackPricing = async (username, packId) => {
    try {
        const [result] = await pool.query(
            "UPDATE user_pack_pricing SET is_active = '0' WHERE username = ? AND pack_id = ?",
            [username, packId]
        );

        if (result.affectedRows === 0) {
            return { success: false, error: "Custom pricing not found" };
        }

        return { success: true, message: "Custom pricing removed successfully" };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Get all custom pricing for a user
 * @param {string} username - Username
 */
export const getUserCustomPricing = async (username) => {
    try {
        const [rows] = await pool.query(
            `SELECT upp.*, sp.pack_name, sp.pack_type, sp.amount as default_amount
             FROM user_pack_pricing upp
             JOIN subscription_packs sp ON upp.pack_id = sp.pack_id
             WHERE upp.username = ? AND upp.is_active = '1'`,
            [username]
        );

        return { success: true, data: rows };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Get all custom pricing (Admin view)
 * @param {object} filters - Filter options
 */
export const getAllCustomPricing = async (filters = {}) => {
    try {
        let query = `
            SELECT upp.*, sp.pack_name, sp.pack_type, sp.amount as default_amount, u.name as user_name, u.email
            FROM user_pack_pricing upp
            JOIN subscription_packs sp ON upp.pack_id = sp.pack_id
            LEFT JOIN users u ON upp.username = u.username
            WHERE upp.is_active = '1'
        `;

        const params = [];

        if (filters.username) {
            query += " AND upp.username = ?";
            params.push(filters.username);
        }

        if (filters.pack_id) {
            query += " AND upp.pack_id = ?";
            params.push(filters.pack_id);
        }

        query += " ORDER BY upp.updated_at DESC";

        const [rows] = await pool.query(query, params);
        return { success: true, data: rows };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Get user's subscription packs with pricing (custom or default)
 * Shows all available packs with user's custom pricing if exists, otherwise default
 * Also includes user's current subscriptions
 * @param {string} username - Username
 * @param {boolean} includeExpired - Include expired subscriptions
 */
export const getUserPacksWithPricing = async (username, includeExpired = false) => {
    try {
        // Get all active subscription packs
        const [allPacks] = await pool.query(
            `SELECT * FROM subscription_packs 
             WHERE is_deleted = '0' AND is_active = '1' 
             ORDER BY pack_type DESC, amount ASC`
        );

        // Get user's custom pricing
        const [customPricing] = await pool.query(
            `SELECT * FROM user_pack_pricing 
             WHERE username = ? AND is_active = '1'`,
            [username]
        );

        // Create a map of custom pricing by pack_id
        const customPricingMap = {};
        customPricing.forEach(cp => {
            customPricingMap[cp.pack_id] = cp;
        });

        // Get user's current subscriptions
        let subscriptionQuery = `
            SELECT us.*, sp.pack_name, sp.pack_type, sp.description, sp.features
            FROM user_subscriptions us
            JOIN subscription_packs sp ON us.pack_id = sp.pack_id
            WHERE us.username = ?
        `;
        
        if (!includeExpired) {
            subscriptionQuery += " AND us.status = 'active'";
        }
        
        subscriptionQuery += " ORDER BY sp.pack_type DESC, us.start_date DESC";
        
        const [userSubscriptions] = await pool.query(subscriptionQuery, [username]);

        // Create a map of subscriptions by pack_id
        const subscriptionMap = {};
        userSubscriptions.forEach(sub => {
            if (!subscriptionMap[sub.pack_id]) {
                subscriptionMap[sub.pack_id] = [];
            }
            subscriptionMap[sub.pack_id].push(sub);
        });

        // Combine packs with pricing and subscription status
        const packsWithPricing = allPacks.map(pack => {
            const customPrice = customPricingMap[pack.pack_id];
            const userSubs = subscriptionMap[pack.pack_id] || [];
            
            // Check if user has any active subscription for this pack
            const hasActiveSubscription = userSubs.some(sub => sub.status === 'active');

            return {
                pack_id: pack.pack_id,
                pack_name: pack.pack_name,
                pack_type: pack.pack_type,
                default_amount: Number(pack.amount),
                custom_amount: customPrice ? Number(customPrice.custom_amount) : null,
                final_amount: customPrice && customPrice.is_active === '1' 
                    ? Number(customPrice.custom_amount) 
                    : Number(pack.amount),
                has_custom_pricing: customPrice ? true : false,
                description: pack.description,
                billing_cycle: pack.billing_cycle,
                features: pack.features,
                is_active: hasActiveSubscription ? "1" : "0", // User currently owns this pack (not expired)
                is_available: pack.is_active, // Pack is available for purchase
                subscriptions: userSubs.map(sub => ({
                    subscription_id: sub.subscription_id,
                    status: sub.status,
                    start_date: sub.start_date,
                    end_date: sub.end_date,
                    amount_paid: Number(sub.amount_paid),
                    wallet_amount: Number(sub.wallet_amount || 0),
                    gateway_amount: Number(sub.gateway_amount || 0),
                    auto_renew: sub.auto_renew === '1'
                }))
            };
        });

        return {
            success: true,
            username: username,
            data: packsWithPricing,
            total_packs: packsWithPricing.length,
            active_subscriptions: userSubscriptions.filter(s => s.status === 'active').length
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

// ============================================
// SUBSCRIPTION PACKS MANAGEMENT
// ============================================

/**
 * Get all subscription packs
 * @param {boolean} includeDeleted - Include deleted packs
 * @param {boolean} activeOnly - Only active packs
 */
export const getAllPacks = async (includeDeleted = false, activeOnly = false) => {
    try {
        let query = "SELECT * FROM subscription_packs WHERE 1=1";
        
        if (!includeDeleted) {
            query += " AND is_deleted = '0'";
        }
        
        if (activeOnly) {
            query += " AND is_active = '1'";
        }
        
        query += " ORDER BY pack_type DESC, amount ASC";
        
        const [rows] = await pool.query(query);
        return { success: true, data: rows };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Get pack by ID
 * @param {string} packId - Pack ID
 */
export const getPackById = async (packId) => {
    try {
        const [rows] = await pool.query(
            "SELECT * FROM subscription_packs WHERE pack_id = ? AND is_deleted = '0'",
            [packId]
        );
        
        if (rows.length === 0) {
            return { success: false, error: "Pack not found" };
        }
        
        return { success: true, data: rows[0] };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Get platform charge pack
 */
export const getPlatformChargePack = async () => {
    try {
        const [rows] = await pool.query(
            "SELECT * FROM subscription_packs WHERE pack_type = 'platform' AND is_deleted = '0' AND is_active = '1' LIMIT 1"
        );
        
        if (rows.length === 0) {
            return { success: false, error: "Platform charge pack not found" };
        }
        
        return { success: true, data: rows[0] };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Create new subscription pack (Admin only)
 * @param {object} packData - Pack details
 */
export const createPack = async (packData) => {
    const {
        pack_name,
        pack_type = 'addon',
        amount,
        description = null,
        billing_cycle = 'monthly',
        features = null,
        is_active = '1'
    } = packData;

    try {
        // Validate required fields
        if (!pack_name || !amount) {
            return { success: false, error: "Pack name and amount are required" };
        }

        // Generate unique pack_id
        const pack_id = `PACK_${pack_type.toUpperCase()}_${generateUniqueId().substring(0, 10)}`;

        const [result] = await pool.query(
            `INSERT INTO subscription_packs 
            (pack_id, pack_name, pack_type, amount, description, billing_cycle, features, is_active) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [pack_id, pack_name, pack_type, amount, description, billing_cycle, features, is_active]
        );

        return { 
            success: true, 
            message: "Pack created successfully",
            pack_id: pack_id,
            insertId: result.insertId 
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Update subscription pack (Admin only)
 * @param {string} packId - Pack ID to update
 * @param {object} updateData - Fields to update
 */
export const updatePack = async (packId, updateData) => {
    try {
        const allowedFields = ['pack_name', 'amount', 'description', 'billing_cycle', 'features', 'is_active'];
        const updates = [];
        const values = [];

        // Build dynamic update query
        for (const [key, value] of Object.entries(updateData)) {
            if (allowedFields.includes(key)) {
                updates.push(`${key} = ?`);
                values.push(value);
            }
        }

        if (updates.length === 0) {
            return { success: false, error: "No valid fields to update" };
        }

        values.push(packId);

        const [result] = await pool.query(
            `UPDATE subscription_packs SET ${updates.join(', ')} WHERE pack_id = ? AND is_deleted = '0'`,
            values
        );

        if (result.affectedRows === 0) {
            return { success: false, error: "Pack not found or already deleted" };
        }

        return { success: true, message: "Pack updated successfully" };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Soft delete subscription pack (Admin only)
 * @param {string} packId - Pack ID to delete
 * @param {string} deletedBy - Username of admin
 */
export const deletePack = async (packId, deletedBy) => {
    try {
        // Check if it's platform pack (cannot be deleted)
        const [pack] = await pool.query(
            "SELECT pack_type FROM subscription_packs WHERE pack_id = ?",
            [packId]
        );

        if (pack.length === 0) {
            return { success: false, error: "Pack not found" };
        }

        if (pack[0].pack_type === 'platform') {
            return { success: false, error: "Platform charge pack cannot be deleted" };
        }

        const [result] = await pool.query(
            "UPDATE subscription_packs SET is_deleted = '1', deleted_by = ? WHERE pack_id = ?",
            [deletedBy, packId]
        );

        if (result.affectedRows === 0) {
            return { success: false, error: "Failed to delete pack" };
        }

        return { success: true, message: "Pack deleted successfully" };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

// ============================================
// USER SUBSCRIPTIONS MANAGEMENT
// ============================================

/**
 * Subscribe user to a pack with hybrid payment (wallet + gateway)
 * @param {object} subscriptionData - Subscription details
 */
export const subscribeUserWithPayment = async (subscriptionData) => {
    const {
        username,
        pack_id,
        billing_cycle = 'monthly',
        use_wallet = false, // Default false - user must explicitly select wallet
        auto_renew = '1'
    } = subscriptionData;

    try {
        // Check if pack exists
        const packResult = await getPackById(pack_id);
        if (!packResult.success) {
            return { success: false, error: "Invalid pack" };
        }

        const pack = packResult.data;
        
        // Check for custom pricing for this user
        let totalAmount = Number(pack.amount);
        const customPricing = await getCustomPricing(username, pack_id);
        if (customPricing && customPricing.is_active === '1') {
            totalAmount = Number(customPricing.custom_amount);
        }

        // If subscribing to addon, check if user has active platform subscription
        let platformSubscription = null;
        if (pack.pack_type === 'addon') {
            const [platformSubs] = await pool.query(
                `SELECT us.* FROM user_subscriptions us
                 JOIN subscription_packs sp ON us.pack_id = sp.pack_id
                 WHERE us.username = ? AND sp.pack_type = 'platform' AND us.status = 'active'
                 ORDER BY us.start_date DESC LIMIT 1`,
                [username]
            );

            if (platformSubs.length === 0) {
                return { 
                    success: false, 
                    error: "Platform subscription required before purchasing add-ons" 
                };
            }
            platformSubscription = platformSubs[0];
        }

        // Check if user already has active subscription for this pack
        const [existing] = await pool.query(
            "SELECT * FROM user_subscriptions WHERE username = ? AND pack_id = ? AND status = 'active'",
            [username, pack_id]
        );

        if (existing.length > 0) {
            return { success: false, error: "User already has an active subscription for this pack" };
        }

        // Initialize payment amounts
        let walletAmount = 0;
        let gatewayAmount = totalAmount;
        let walletTransactionId = null;

        // Only use wallet if user explicitly selected it
        if (use_wallet === true) {
            const walletBalance = await getUserWalletBalance(username);
            
            if (walletBalance > 0) {
                // Use wallet balance (up to total amount)
                walletAmount = Math.min(walletBalance, totalAmount);
                gatewayAmount = totalAmount - walletAmount;

                // Deduct wallet amount immediately
                walletTransactionId = RANDOM_STRING(30);
                await pool.query(
                    `INSERT INTO transactions 
                    (transaction_id, username, create_date, create_by, type, transaction_type, amount, value_1, value_2) 
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [
                        walletTransactionId,
                        username,
                        TIMESTAMP(),
                        username,
                        '0', // Debit
                        'subscription payment',
                        walletAmount,
                        pack_id,
                        'wallet'
                    ]
                );
            }
        }

        // Calculate end date based on requirement:
        // - Platform pack: From purchase date + billing cycle (monthly/quarterly/yearly)
        // - Addon pack: 
        //   - If purchased same day as platform: Use platform's end_date
        //   - If purchased later: Always use purchase date + 30 days (monthly)
        let end_date;
        if (pack.pack_type === 'platform') {
            // Platform: Calculate from purchase date based on billing cycle
            end_date = calculateEndDate(billing_cycle);
        } else {
            // Addon: Check if purchased same day as platform
            if (platformSubscription) {
                const platformStartDate = new Date(platformSubscription.start_date);
                const now = new Date();
                
                // Check if same day (same year, month, and day)
                const isSameDay = 
                    platformStartDate.getFullYear() === now.getFullYear() &&
                    platformStartDate.getMonth() === now.getMonth() &&
                    platformStartDate.getDate() === now.getDate();
                
                if (isSameDay) {
                    // Same day as platform purchase: Use platform's end_date
                    // This means addon expires when platform expires (same month)
                    end_date = platformSubscription.end_date;
                } else {
                    // Different day: Calculate from purchase date + 30 days
                    // Addons always use 30-day period regardless of platform's billing cycle
                    end_date = calculateEndDate('monthly');
                }
            } else {
                // Fallback (shouldn't happen due to validation above)
                end_date = calculateEndDate('monthly');
            }
        }
        const subscription_id = `SUB_${generateUniqueId().substring(0, 20)}`;

        // If full amount paid from wallet, activate subscription immediately
        if (gatewayAmount === 0) {
            await pool.query(
                `INSERT INTO user_subscriptions 
                (subscription_id, username, pack_id, end_date, amount_paid, wallet_amount, gateway_amount, status, auto_renew, payment_order_id) 
                VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
                [
                    subscription_id,
                    username,
                    pack_id,
                    end_date,
                    totalAmount,
                    walletAmount,
                    gatewayAmount,
                    auto_renew,
                    null
                ]
            );

            return { 
                success: true, 
                message: "Subscription activated successfully",
                subscription_id: subscription_id,
                end_date: end_date,
                wallet_amount: walletAmount,
                gateway_amount: gatewayAmount,
                payment_required: false
            };
        }

        // Gateway payment required (partial or full) - create pending subscription
        await pool.query(
            `INSERT INTO user_subscriptions 
            (subscription_id, username, pack_id, end_date, amount_paid, wallet_amount, gateway_amount, status, auto_renew, payment_order_id) 
            VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
            [
                subscription_id,
                username,
                pack_id,
                end_date,
                totalAmount,
                walletAmount,
                gatewayAmount,
                auto_renew,
                null
            ]
        );

        return { 
            success: true, 
            message: "Subscription created, gateway payment required",
            subscription_id: subscription_id,
            end_date: end_date,
            wallet_amount: walletAmount,
            gateway_amount: gatewayAmount,
            payment_required: true,
            wallet_transaction_id: walletTransactionId
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Subscribe user to a pack (legacy function - for backward compatibility)
 * @param {object} subscriptionData - Subscription details
 */
export const subscribeUser = async (subscriptionData) => {
    const {
        username,
        pack_id,
        amount_paid,
        billing_cycle = 'monthly',
        payment_order_id = null,
        auto_renew = '1'
    } = subscriptionData;

    try {
        // Check if pack exists
        const packResult = await getPackById(pack_id);
        if (!packResult.success) {
            return { success: false, error: "Invalid pack" };
        }

        const pack = packResult.data;
        
        // Check for custom pricing for this user
        let totalAmount = Number(pack.amount);
        const customPricing = await getCustomPricing(username, pack_id);
        if (customPricing && customPricing.is_active === '1') {
            totalAmount = Number(customPricing.custom_amount);
        }

        // If subscribing to addon, check if user has active platform subscription
        let platformSubscription = null;
        if (pack.pack_type === 'addon') {
            const [platformSubs] = await pool.query(
                `SELECT us.* FROM user_subscriptions us
                 JOIN subscription_packs sp ON us.pack_id = sp.pack_id
                 WHERE us.username = ? AND sp.pack_type = 'platform' AND us.status = 'active'
                 ORDER BY us.start_date DESC LIMIT 1`,
                [username]
            );

            if (platformSubs.length === 0) {
                return { 
                    success: false, 
                    error: "Platform subscription required before purchasing add-ons" 
                };
            }
            platformSubscription = platformSubs[0];
        }

        // Check if user already has active subscription for this pack
        const [existing] = await pool.query(
            "SELECT * FROM user_subscriptions WHERE username = ? AND pack_id = ? AND status = 'active'",
            [username, pack_id]
        );

        if (existing.length > 0) {
            return { success: false, error: "User already has an active subscription for this pack" };
        }

        // Calculate end date based on requirement:
        // - Platform pack: From purchase date + billing cycle (monthly/quarterly/yearly)
        // - Addon pack: 
        //   - If purchased same day as platform: Use platform's end_date
        //   - If purchased later: Always use purchase date + 30 days (monthly)
        let end_date;
        if (pack.pack_type === 'platform') {
            // Platform: Calculate from purchase date based on billing cycle
            end_date = calculateEndDate(billing_cycle);
        } else {
            // Addon: Check if purchased same day as platform
            if (platformSubscription) {
                const platformStartDate = new Date(platformSubscription.start_date);
                const now = new Date();
                
                // Check if same day (same year, month, and day)
                const isSameDay = 
                    platformStartDate.getFullYear() === now.getFullYear() &&
                    platformStartDate.getMonth() === now.getMonth() &&
                    platformStartDate.getDate() === now.getDate();
                
                if (isSameDay) {
                    // Same day as platform purchase: Use platform's end_date
                    // This means addon expires when platform expires (same month)
                    end_date = platformSubscription.end_date;
                } else {
                    // Different day: Calculate from purchase date + 30 days
                    // Addons always use 30-day period regardless of platform's billing cycle
                    end_date = calculateEndDate('monthly');
                }
            } else {
                // Fallback (shouldn't happen due to validation above)
                end_date = calculateEndDate('monthly');
            }
        }
        const subscription_id = `SUB_${generateUniqueId().substring(0, 20)}`;

        const [result] = await pool.query(
            `INSERT INTO user_subscriptions 
            (subscription_id, username, pack_id, end_date, amount_paid, wallet_amount, gateway_amount, status, auto_renew, payment_order_id) 
            VALUES (?, ?, ?, ?, ?, 0, ?, 'active', ?, ?)`,
            [subscription_id, username, pack_id, end_date, amount_paid, amount_paid, auto_renew, payment_order_id]
        );

        return { 
            success: true, 
            message: "Subscription created successfully",
            subscription_id: subscription_id,
            end_date: end_date
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Get user's active subscriptions
 * @param {string} username - Username
 */
export const getUserSubscriptions = async (username, includeExpired = false) => {
    try {
        let query = `
            SELECT us.*, sp.pack_name, sp.pack_type, sp.description, sp.features
            FROM user_subscriptions us
            JOIN subscription_packs sp ON us.pack_id = sp.pack_id
            WHERE us.username = ?
        `;

        if (!includeExpired) {
            query += " AND us.status = 'active'";
        }

        query += " ORDER BY sp.pack_type DESC, us.start_date DESC";

        const [rows] = await pool.query(query, [username]);
        return { success: true, data: rows };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Check if user has active platform subscription
 * @param {string} username - Username
 */
export const hasActivePlatformSubscription = async (username) => {
    try {
        const [rows] = await pool.query(
            `SELECT us.* FROM user_subscriptions us
             JOIN subscription_packs sp ON us.pack_id = sp.pack_id
             WHERE us.username = ? AND sp.pack_type = 'platform' AND us.status = 'active'
             LIMIT 1`,
            [username]
        );

        return { success: true, data: rows.length > 0 };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Activate subscription after gateway payment success
 * @param {string} subscriptionId - Subscription ID
 * @param {string} paymentOrderId - Payment order ID
 * @param {string} gatewayOrderId - Gateway order ID (optional)
 */
export const activateSubscription = async (subscriptionId, paymentOrderId, gatewayOrderId = null) => {
    try {
        const [result] = await pool.query(
            `UPDATE user_subscriptions 
             SET status = 'active', payment_order_id = ?, gateway_order_id = ?
             WHERE subscription_id = ? AND status = 'pending'`,
            [paymentOrderId, gatewayOrderId, subscriptionId]
        );

        if (result.affectedRows === 0) {
            return { success: false, error: "Subscription not found or already activated" };
        }

        return { success: true, message: "Subscription activated successfully" };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Cancel subscription
 * @param {string} subscriptionId - Subscription ID
 * @param {string} cancelledBy - Username who cancelled
 */
export const cancelSubscription = async (subscriptionId, cancelledBy) => {
    try {
        const [result] = await pool.query(
            `UPDATE user_subscriptions 
             SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = ?, auto_renew = '0'
             WHERE subscription_id = ? AND status = 'active'`,
            [cancelledBy, subscriptionId]
        );

        if (result.affectedRows === 0) {
            return { success: false, error: "Subscription not found or already cancelled" };
        }

        return { success: true, message: "Subscription cancelled successfully" };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Get all subscriptions (Admin view)
 * @param {object} filters - Filter options
 */
export const getAllSubscriptions = async (filters = {}) => {
    try {
        let query = `
            SELECT us.*, sp.pack_name, sp.pack_type, u.name, u.email
            FROM user_subscriptions us
            JOIN subscription_packs sp ON us.pack_id = sp.pack_id
            LEFT JOIN users u ON us.username = u.username
            WHERE 1=1
        `;

        const params = [];

        if (filters.status) {
            query += " AND us.status = ?";
            params.push(filters.status);
        }

        if (filters.pack_type) {
            query += " AND sp.pack_type = ?";
            params.push(filters.pack_type);
        }

        if (filters.username) {
            query += " AND us.username = ?";
            params.push(filters.username);
        }

        query += " ORDER BY us.created_at DESC";

        const [rows] = await pool.query(query, params);
        return { success: true, data: rows };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Calculate subscription end date based on billing cycle
 * Adds exact number of days to avoid date overflow issues
 * @param {string} billingCycle - monthly, quarterly, yearly
 * @param {Date} startDate - Optional start date (defaults to now)
 */
const calculateEndDate = (billingCycle, startDate = null) => {
    const now = startDate ? new Date(startDate) : new Date();
    let endDate = new Date(now);

    switch (billingCycle) {
        case 'monthly':
            // Add 30 days for monthly subscription
            endDate.setDate(endDate.getDate() + 30);
            break;
        case 'quarterly':
            // Add 90 days for quarterly subscription
            endDate.setDate(endDate.getDate() + 90);
            break;
        case 'yearly':
            // Add 365 days for yearly subscription
            endDate.setDate(endDate.getDate() + 365);
            break;
        default:
            // Default to 30 days
            endDate.setDate(endDate.getDate() + 30);
    }

    return endDate.toISOString().slice(0, 19).replace('T', ' ');
};

/**
 * Process auto-renewals for subscriptions (INSERT approach - creates new records)
 * This function should be run daily via cron job, preferably 1-2 days before expiry
 * 
 * @param {object} options - Configuration options
 * @param {number} options.daysBeforeExpiry - How many days before expiry to process (default: 1)
 * @param {function} options.paymentProcessor - Optional payment processing function
 * @returns {object} Result with processed renewals
 */
export const processAutoRenewals = async (options = {}) => {
    const { daysBeforeExpiry = 1, paymentProcessor = null } = options;
    
    try {
        // Find subscriptions that:
        // 1. Are currently active
        // 2. Have auto_renew = '1'
        // 3. Are expiring within the specified days
        // 4. Don't already have a renewal in progress
        const [expiringSubs] = await pool.query(
            `SELECT us.*, sp.amount, sp.billing_cycle, sp.pack_name, sp.pack_type
             FROM user_subscriptions us
             JOIN subscription_packs sp ON us.pack_id = sp.pack_id
             WHERE us.status = 'active'
             AND us.auto_renew = '1'
             AND us.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL ? DAY)
             AND NOT EXISTS (
                 SELECT 1 FROM user_subscriptions us2
                 WHERE us2.username = us.username
                 AND us2.pack_id = us.pack_id
                 AND us2.status = 'pending'
                 AND us2.start_date > us.end_date
             )
             ORDER BY us.end_date ASC`,
            [daysBeforeExpiry]
        );

        if (expiringSubs.length === 0) {
            return {
                success: true,
                message: "No subscriptions to renew",
                processed: 0,
                failed: 0
            };
        }

        let processed = 0;
        let failed = 0;
        const results = [];

        for (const oldSubscription of expiringSubs) {
            try {
                // Step 1: Process payment (if payment processor provided)
                let paymentOrderId = null;
                let paymentSuccess = true;

                if (paymentProcessor && typeof paymentProcessor === 'function') {
                    const paymentResult = await paymentProcessor({
                        username: oldSubscription.username,
                        pack_id: oldSubscription.pack_id,
                        amount: oldSubscription.amount,
                        subscription_id: oldSubscription.subscription_id
                    });

                    if (!paymentResult.success) {
                        paymentSuccess = false;
                        // Mark old subscription as expired and disable auto-renew
                        await pool.query(
                            `UPDATE user_subscriptions 
                             SET status = 'expired', auto_renew = '0'
                             WHERE subscription_id = ?`,
                            [oldSubscription.subscription_id]
                        );
                        failed++;
                        results.push({
                            subscription_id: oldSubscription.subscription_id,
                            username: oldSubscription.username,
                            pack_name: oldSubscription.pack_name,
                            status: 'failed',
                            reason: paymentResult.error || 'Payment failed'
                        });
                        continue;
                    }
                    paymentOrderId = paymentResult.payment_order_id;
                }

                // Step 2: Calculate new end date based on billing cycle
                const newEndDate = calculateEndDate(oldSubscription.billing_cycle);
                
                // Step 3: Generate new subscription ID
                const newSubscriptionId = `SUB_${generateUniqueId().substring(0, 20)}`;

                // Step 4: INSERT new subscription record (new billing period)
                await pool.query(
                    `INSERT INTO user_subscriptions 
                    (subscription_id, username, pack_id, start_date, end_date, 
                     amount_paid, status, auto_renew, payment_order_id)
                    VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
                    [
                        newSubscriptionId,
                        oldSubscription.username,
                        oldSubscription.pack_id,
                        oldSubscription.end_date, // Start from where old one ended
                        newEndDate,
                        oldSubscription.amount,
                        oldSubscription.auto_renew,
                        paymentOrderId
                    ]
                );

                // Step 5: Mark old subscription as expired
                await pool.query(
                    `UPDATE user_subscriptions 
                     SET status = 'expired'
                     WHERE subscription_id = ?`,
                    [oldSubscription.subscription_id]
                );

                processed++;
                results.push({
                    old_subscription_id: oldSubscription.subscription_id,
                    new_subscription_id: newSubscriptionId,
                    username: oldSubscription.username,
                    pack_name: oldSubscription.pack_name,
                    status: 'renewed',
                    new_end_date: newEndDate
                });

            } catch (error) {
                failed++;
                results.push({
                    subscription_id: oldSubscription.subscription_id,
                    username: oldSubscription.username,
                    pack_name: oldSubscription.pack_name,
                    status: 'error',
                    reason: error.message
                });
            }
        }

        return {
            success: true,
            message: `Processed ${processed} renewals, ${failed} failed`,
            processed,
            failed,
            results
        };

    } catch (error) {
        return { success: false, error: error.message };
    }
};

/**
 * Check and update expired subscriptions (Run as cron job)
 * This marks subscriptions as expired if they passed end_date without renewal
 */
export const updateExpiredSubscriptions = async () => {
    try {
        const [result] = await pool.query(
            `UPDATE user_subscriptions 
             SET status = 'expired', auto_renew = '0'
             WHERE status = 'active' 
             AND end_date < NOW()
             AND auto_renew = '0'`
        );

        return { 
            success: true, 
            message: `Updated ${result.affectedRows} expired subscriptions` 
        };
    } catch (error) {
        return { success: false, error: error.message };
    }
};

export default {
    // Pack management
    getAllPacks,
    getPackById,
    getPlatformChargePack,
    createPack,
    updatePack,
    deletePack,
    
    // Subscription management
    subscribeUser,
    subscribeUserWithPayment,
    activateSubscription,
    getUserSubscriptions,
    hasActivePlatformSubscription,
    cancelSubscription,
    getAllSubscriptions,
    
    // Custom pricing management
    setUserPackPricing,
    removeUserPackPricing,
    getUserCustomPricing,
    getAllCustomPricing,
    getUserPacksWithPricing,
    
    // Utilities
    processAutoRenewals,
    updateExpiredSubscriptions,
    getUserWalletBalance
};
