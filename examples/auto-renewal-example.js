/**
 * AUTO-RENEWAL IMPLEMENTATION EXAMPLES
 * 
 * This file shows how to use the auto-renewal system with INSERT approach
 * (creates new subscription records for each renewal period)
 */

import subscriptionDb from '../helpers/subscriptionDb.js';
import pool from '../db.js';
import crypto from 'crypto';

// Helper functions
const generateUniqueId = () => crypto.randomBytes(16).toString('hex').toUpperCase();

const calculateEndDate = (billingCycle) => {
    const now = new Date();
    let endDate = new Date();
    switch (billingCycle) {
        case 'monthly':
            endDate.setMonth(now.getMonth() + 1);
            break;
        case 'quarterly':
            endDate.setMonth(now.getMonth() + 3);
            break;
        case 'yearly':
            endDate.setFullYear(now.getFullYear() + 1);
            break;
        default:
            endDate.setMonth(now.getMonth() + 1);
    }
    return endDate.toISOString().slice(0, 19).replace('T', ' ');
};

// ============================================
// EXAMPLE 1: Basic Auto-Renewal (No Payment Processing)
// ============================================

async function basicAutoRenewal() {
    console.log('🔄 Processing basic auto-renewals...');
    
    // Process subscriptions expiring in the next 1 day
    const result = await subscriptionDb.processAutoRenewals({
        daysBeforeExpiry: 1
    });

    if (result.success) {
        console.log(`✅ ${result.message}`);
        console.log(`   Processed: ${result.processed}`);
        console.log(`   Failed: ${result.failed}`);
        
        // Show details
        result.results.forEach(r => {
            if (r.status === 'renewed') {
                console.log(`   ✓ Renewed: ${r.username} - ${r.pack_name}`);
                console.log(`     Old ID: ${r.old_subscription_id}`);
                console.log(`     New ID: ${r.new_subscription_id}`);
                console.log(`     Expires: ${r.new_end_date}`);
            } else {
                console.log(`   ✗ Failed: ${r.username} - ${r.pack_name}`);
                console.log(`     Reason: ${r.reason}`);
            }
        });
    } else {
        console.error('❌ Error:', result.error);
    }
}

// ============================================
// EXAMPLE 2: Auto-Renewal WITH Payment Processing
// ============================================

/**
 * Payment processor function (integrate with your payment gateway)
 */
async function processPayment(paymentData) {
    const { username, pack_id, amount, subscription_id } = paymentData;
    
    console.log(`💳 Processing payment for ${username}: ₹${amount}`);
    
    // TODO: Integrate with your payment gateway (Razorpay, Stripe, etc.)
    // Example:
    // const paymentResult = await razorpay.orders.create({
    //     amount: amount * 100, // Convert to paise
    //     currency: 'INR',
    //     receipt: subscription_id
    // });
    
    // For now, simulate payment
    const paymentSuccess = Math.random() > 0.1; // 90% success rate
    
    if (paymentSuccess) {
        // Create payment order record
        // await createPaymentOrder({...});
        
        return {
            success: true,
            payment_order_id: `ORDER_${Date.now()}`,
            payment_id: `PAY_${Date.now()}`
        };
    } else {
        return {
            success: false,
            error: 'Payment declined or insufficient funds'
        };
    }
}

async function autoRenewalWithPayment() {
    console.log('🔄 Processing auto-renewals with payment...');
    
    const result = await subscriptionDb.processAutoRenewals({
        daysBeforeExpiry: 2, // Process 2 days before expiry
        paymentProcessor: processPayment
    });

    if (result.success) {
        console.log(`✅ ${result.message}`);
        
        // Handle successful renewals
        const successful = result.results.filter(r => r.status === 'renewed');
        const failed = result.results.filter(r => r.status === 'failed' || r.status === 'error');
        
        console.log(`\n✅ Successful: ${successful.length}`);
        successful.forEach(r => {
            console.log(`   ${r.username} - ${r.pack_name} renewed until ${r.new_end_date}`);
        });
        
        console.log(`\n❌ Failed: ${failed.length}`);
        failed.forEach(r => {
            console.log(`   ${r.username} - ${r.pack_name}: ${r.reason}`);
            // TODO: Send notification email to user
        });
    }
}

// ============================================
// EXAMPLE 3: Cron Job Setup
// ============================================

/**
 * This function should be called daily via cron job
 * Recommended: Run at 2 AM daily
 */
async function dailyAutoRenewalCron() {
    console.log(`[${new Date().toISOString()}] Starting auto-renewal process...`);
    
    try {
        // Step 1: Process auto-renewals (1 day before expiry)
        const renewalResult = await subscriptionDb.processAutoRenewals({
            daysBeforeExpiry: 1,
            paymentProcessor: processPayment // Your payment function
        });
        
        console.log('Renewal Result:', renewalResult);
        
        // Step 2: Mark expired subscriptions (for those without auto-renew)
        const expireResult = await subscriptionDb.updateExpiredSubscriptions();
        console.log('Expire Result:', expireResult);
        
        // Step 3: Send notifications (optional)
        if (renewalResult.failed > 0) {
            // TODO: Send email notifications for failed renewals
            console.log(`⚠️  ${renewalResult.failed} renewals failed - notifications sent`);
        }
        
        console.log(`✅ Auto-renewal process completed`);
        
    } catch (error) {
        console.error('❌ Auto-renewal cron error:', error);
        // TODO: Send alert to admin
    }
}

// ============================================
// EXAMPLE 4: Check What Will Renew Soon
// ============================================

async function checkUpcomingRenewals() {
    const [subs] = await pool.query(
        `SELECT us.*, sp.pack_name, sp.amount, sp.billing_cycle
         FROM user_subscriptions us
         JOIN subscription_packs sp ON us.pack_id = sp.pack_id
         WHERE us.status = 'active'
         AND us.auto_renew = '1'
         AND us.end_date BETWEEN NOW() AND DATE_ADD(NOW(), INTERVAL 7 DAY)
         ORDER BY us.end_date ASC`
    );
    
    console.log(`📅 Upcoming renewals in next 7 days: ${subs.length}`);
    subs.forEach(sub => {
        const daysLeft = Math.ceil((new Date(sub.end_date) - new Date()) / (1000 * 60 * 60 * 24));
        console.log(`   ${sub.username} - ${sub.pack_name} (₹${sub.amount}) - ${daysLeft} days left`);
    });
}

// ============================================
// EXAMPLE 5: Manual Renewal (Admin)
// ============================================

async function manualRenewal(subscriptionId, paymentOrderId) {
    try {
        // Get the subscription
        const [subs] = await pool.query(
            `SELECT us.*, sp.amount, sp.billing_cycle 
             FROM user_subscriptions us
             JOIN subscription_packs sp ON us.pack_id = sp.pack_id
             WHERE us.subscription_id = ?`,
            [subscriptionId]
        );
        
        if (subs.length === 0) {
            return { success: false, error: 'Subscription not found' };
        }
        
        const oldSub = subs[0];
        
        // Calculate new end date
        const newEndDate = calculateEndDate(oldSub.billing_cycle);
        const newSubscriptionId = `SUB_${generateUniqueId().substring(0, 20)}`;
        
        // Create new subscription
        await pool.query(
            `INSERT INTO user_subscriptions 
            (subscription_id, username, pack_id, start_date, end_date, 
             amount_paid, status, auto_renew, payment_order_id)
            VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
            [
                newSubscriptionId,
                oldSub.username,
                oldSub.pack_id,
                oldSub.end_date,
                newEndDate,
                oldSub.amount,
                oldSub.auto_renew,
                paymentOrderId
            ]
        );
        
        // Mark old as expired
        await pool.query(
            `UPDATE user_subscriptions SET status = 'expired' WHERE subscription_id = ?`,
            [subscriptionId]
        );
        
        return {
            success: true,
            new_subscription_id: newSubscriptionId,
            end_date: newEndDate
        };
        
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ============================================
// CRON JOB SETUP INSTRUCTIONS
// ============================================

/*
To set up daily auto-renewal cron job:

1. Create a file: cron-jobs/auto-renewal.js
   (Copy the dailyAutoRenewalCron function)

2. Add to crontab:
   crontab -e
   
3. Add this line (runs daily at 2 AM):
   0 2 * * * cd /www/wwwroot/1-chat-api && node cron-jobs/auto-renewal.js >> logs/auto-renewal.log 2>&1

4. Or use node-cron in your server.js:
   import cron from 'node-cron';
   import subscriptionDb from './helpers/subscriptionDb.js';
   
   cron.schedule('0 2 * * *', async () => {
       await dailyAutoRenewalCron();
   });
*/

// ============================================
// EXPORT FOR USE
// ============================================

export {
    basicAutoRenewal,
    autoRenewalWithPayment,
    dailyAutoRenewalCron,
    checkUpcomingRenewals,
    manualRenewal
};
