/**
 * EXAMPLE SUBSCRIPTION API ROUTES
 * This is a reference implementation showing how to create REST API endpoints
 * for the subscription system. Integrate these into your existing Express app.
 */

import express from 'express';
import subscriptionDb from '../helpers/subscriptionDb.js';

const router = express.Router();

// ============================================
// ADMIN ROUTES (Add authentication middleware)
// ============================================

/**
 * GET /api/admin/subscription-packs
 * Get all subscription packs (admin view)
 */
router.get('/admin/subscription-packs', async (req, res) => {
    try {
        const includeDeleted = req.query.includeDeleted === 'true';
        const activeOnly = req.query.activeOnly === 'true';
        
        const result = await subscriptionDb.getAllPacks(includeDeleted, activeOnly);
        
        if (result.success) {
            return res.json({
                success: true,
                data: result.data
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * POST /api/admin/subscription-packs
 * Create a new subscription pack
 */
router.post('/admin/subscription-packs', async (req, res) => {
    try {
        const result = await subscriptionDb.createPack(req.body);
        
        if (result.success) {
            return res.status(201).json({
                success: true,
                message: result.message,
                pack_id: result.pack_id
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * PUT /api/admin/subscription-packs/:packId
 * Update a subscription pack
 */
router.put('/admin/subscription-packs/:packId', async (req, res) => {
    try {
        const { packId } = req.params;
        const result = await subscriptionDb.updatePack(packId, req.body);
        
        if (result.success) {
            return res.json({
                success: true,
                message: result.message
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * DELETE /api/admin/subscription-packs/:packId
 * Soft delete a subscription pack
 */
router.delete('/admin/subscription-packs/:packId', async (req, res) => {
    try {
        const { packId } = req.params;
        const deletedBy = req.user?.username || 'admin'; // Get from auth middleware
        
        const result = await subscriptionDb.deletePack(packId, deletedBy);
        
        if (result.success) {
            return res.json({
                success: true,
                message: result.message
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * GET /api/admin/subscriptions
 * View all user subscriptions with filters
 */
router.get('/admin/subscriptions', async (req, res) => {
    try {
        const filters = {
            status: req.query.status,
            pack_type: req.query.pack_type,
            username: req.query.username
        };
        
        const result = await subscriptionDb.getAllSubscriptions(filters);
        
        if (result.success) {
            return res.json({
                success: true,
                data: result.data
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// ============================================
// USER ROUTES (Add user authentication middleware)
// ============================================

/**
 * GET /api/subscription-packs
 * Get available subscription packs for users
 */
router.get('/subscription-packs', async (req, res) => {
    try {
        const result = await subscriptionDb.getAllPacks(false, true); // Only active, non-deleted
        
        if (result.success) {
            return res.json({
                success: true,
                data: result.data
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * GET /api/subscription-packs/:packId
 * Get single pack details
 */
router.get('/subscription-packs/:packId', async (req, res) => {
    try {
        const { packId } = req.params;
        const result = await subscriptionDb.getPackById(packId);
        
        if (result.success) {
            return res.json({
                success: true,
                data: result.data
            });
        }
        
        return res.status(404).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * POST /api/subscriptions
 * Subscribe to a pack (requires payment processing first)
 */
router.post('/subscriptions', async (req, res) => {
    try {
        const username = req.user?.username; // Get from auth middleware
        
        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });
        }
        
        const subscriptionData = {
            username,
            pack_id: req.body.pack_id,
            amount_paid: req.body.amount_paid,
            billing_cycle: req.body.billing_cycle || 'monthly',
            payment_order_id: req.body.payment_order_id,
            auto_renew: req.body.auto_renew || '1'
        };
        
        const result = await subscriptionDb.subscribeUser(subscriptionData);
        
        if (result.success) {
            return res.status(201).json({
                success: true,
                message: result.message,
                subscription_id: result.subscription_id,
                end_date: result.end_date
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * GET /api/subscriptions/my
 * Get current user's subscriptions
 */
router.get('/subscriptions/my', async (req, res) => {
    try {
        const username = req.user?.username; // Get from auth middleware
        
        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });
        }
        
        const includeExpired = req.query.includeExpired === 'true';
        const result = await subscriptionDb.getUserSubscriptions(username, includeExpired);
        
        if (result.success) {
            return res.json({
                success: true,
                data: result.data
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * GET /api/subscriptions/check-platform
 * Check if user has active platform subscription
 */
router.get('/subscriptions/check-platform', async (req, res) => {
    try {
        const username = req.user?.username; // Get from auth middleware
        
        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });
        }
        
        const result = await subscriptionDb.hasActivePlatformSubscription(username);
        
        if (result.success) {
            return res.json({
                success: true,
                has_platform: result.data
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

/**
 * DELETE /api/subscriptions/:subscriptionId
 * Cancel a subscription
 */
router.delete('/subscriptions/:subscriptionId', async (req, res) => {
    try {
        const username = req.user?.username; // Get from auth middleware
        const { subscriptionId } = req.params;
        
        if (!username) {
            return res.status(401).json({
                success: false,
                message: "Authentication required"
            });
        }
        
        // Optionally: Verify subscription belongs to user before cancelling
        
        const result = await subscriptionDb.cancelSubscription(subscriptionId, username);
        
        if (result.success) {
            return res.json({
                success: true,
                message: result.message
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

// ============================================
// UTILITY ROUTES
// ============================================

/**
 * POST /api/subscriptions/update-expired
 * Manually trigger expired subscription updates (or run via cron)
 */
router.post('/subscriptions/update-expired', async (req, res) => {
    try {
        const result = await subscriptionDb.updateExpiredSubscriptions();
        
        if (result.success) {
            return res.json({
                success: true,
                message: result.message
            });
        }
        
        return res.status(400).json({
            success: false,
            message: result.error
        });
    } catch (error) {
        return res.status(500).json({
            success: false,
            message: error.message
        });
    }
});

export default router;

/**
 * INTEGRATION EXAMPLE:
 * 
 * In your main server.js or app.js:
 * 
 * import subscriptionRoutes from './routes/subscriptionRoutes.example.js';
 * 
 * // Apply authentication middleware where needed
 * app.use('/api', subscriptionRoutes);
 * 
 * NOTE: Make sure to add proper authentication middleware to protect
 * admin routes and user-specific routes!
 */
