# 🐛 Payment Route — Bugs To Fix (Production Audit)

> **Audited:** `routes/payment.js` + `helpers/paymentGateway.js`  
> **Date:** 2026-08-09  
> **Status:** ⏳ Pending Fix  

---

## 🔴 CRITICAL — Fix Before Going Live

### BUG-1 · `var` Scope Crash in `/payment-status`
- **File:** `routes/payment.js` — Lines 349–376
- **Problem:**  
  `var data`, `var key`, and `var return_status` are declared inside `if` blocks using `var`.  
  - If `req.body` is empty → `data` and `key` are `undefined` → `Decrypt(undefined, undefined)` silently crashes or returns wrong result.  
  - If payment `status` is anything other than `'0'`, `'1'`, `'2'` → `return_status` is `undefined` in the response.
- **Fix:**
  ```js
  // Replace var with const/let
  const data = req.body?.data || '';
  const key  = req.body?.key  || '';

  // Add default for return_status
  let return_status = 'UNKNOWN';
  if (payment_data?.status == '0') return_status = 'PENDING';
  else if (payment_data?.status == '1') return_status = 'SUCCESS';
  else if (payment_data?.status == '2') return_status = 'FAILED';
  ```

---

### BUG-2 · No `try/catch` on `/payment-status` Route
- **File:** `routes/payment.js` — Lines 347–400
- **Problem:**  
  The entire `/payment-status` handler has **zero error handling**. Any DB error, network failure, or `USER_DATA()` rejection causes an **unhandled promise rejection**, crashes the request, and the client gets no response.
- **Fix:**  
  Wrap the full handler body in:
  ```js
  try {
      // ... all existing logic ...
  } catch (error) {
      console.error('[payment-status]', error);
      return res.status(200).json({ error: 'Failed to fetch payment status' });
  }
  ```

---

### BUG-3 · No Amount Validation in `/wallet-topup`
- **File:** `routes/payment.js` — Line 306
- **Problem:**  
  `amount` is taken from decrypted payload with **no validation**.  
  Could be `undefined` (DB NULL), `0` or negative (free top-up), or a string `"abc"` (data corruption).
- **Fix:**
  ```js
  const amount = Number(decrypt.amount);
  if (!amount || amount <= 0 || isNaN(amount)) {
      return res.status(200).json({ error: 'Invalid amount' });
  }
  ```

---

### BUG-4 · DB Row Inserted Before Gateway Call — Orphan Orders
- **File:** `routes/payment.js` — Lines 315–327
- **Problem:**  
  `INSERT INTO payment_orders` runs **before** `initiateWalletTopup()`.  
  If the gateway call fails (timeout, wrong credentials, network error), the DB row is created with `status='0'` and **never cleaned up** → piles up as ghost pending orders.
- **Fix:**  
  In the `catch` block, mark the order as failed or delete it:
  ```js
  } catch (error) {
      // cleanup orphan order
      await pool.query("UPDATE payment_orders SET status='2' WHERE order_id=?", [order_id]);
      // OR: await pool.query("DELETE FROM payment_orders WHERE order_id=?", [order_id]);
      return res.status(200).json({ error: '...' });
  }
  ```

---

### BUG-5 · Double-Credit Race Condition — Webhook Retries
- **File:** `helpers/paymentGateway.js` — Lines 44–56 (`completeWalletTopup`)
- **Problem:**  
  Cashfree and Razorpay **retry webhooks** on no-response. If the webhook fires twice before DB is updated, `completeWalletTopup` runs twice → wallet credited **twice** for the same payment.
- **Fix:**  
  Make the UPDATE atomic with a guard, then check `affectedRows`:
  ```js
  const [updateResult] = await pool.query(
      "UPDATE payment_orders SET status='1', utr=? WHERE order_id=? AND status='0'",
      [utr, order_id]
  );
  if (updateResult.affectedRows === 0) {
      // Already processed — skip transaction insert
      return;
  }
  // Now safe to insert transaction
  await pool.query("INSERT INTO transactions ...");
  ```

---

## 🟡 HIGH RISK — Fix Soon

### BUG-6 · Wildcard CORS in Production
- **File:** `server.js` — Line 41
- **Problem:** `origin: "*"` with `credentials: true` is rejected by all modern browsers in production. Must restrict to actual frontend domain.
- **Fix:** `origin: "https://yourdomain.com"`

---

### BUG-7 · Cashfree Secret Key Undefined → Crash
- **File:** `helpers/paymentGateway.js` — Line 230
- **Problem:** If `CASHFREE_SECRET_KEY` env var is missing, `crypto.createHmac("sha256", undefined)` **throws a runtime error** that crashes the webhook route entirely.
- **Fix:** Add a guard before using it:
  ```js
  if (!CASHFREE_SECRET_KEY) {
      console.error('[cashfree webhook] CASHFREE_SECRET_KEY is not set');
      return false;
  }
  ```

---

### BUG-8 · LIKE Injection on `transaction_type` Filter
- **File:** `routes/payment.js` — Lines 227–228
- **Problem:** User-supplied `transaction_type` is directly used in a `LIKE` pattern. Characters like `%` and `_` are SQL LIKE wildcards → sending `transaction_type: "%"` matches ALL rows (data leak / performance attack).
- **Fix:** Escape special chars before using in LIKE:
  ```js
  const safeTxType = transaction_type.replace(/[%_\\]/g, '\\$&');
  baseParams.push(`%${safeTxType}%`);
  ```

---

### BUG-9 · `rawBody` Only Captured for One Webhook URL
- **File:** `server.js` — Lines 48–51
- **Problem:** Cashfree signature verification requires `req.rawBody`. Currently only captured for `/webhook/wallet-topup`. Any new webhook route added in the future will fail signature verification silently.
- **Fix:** Use a pattern match instead of exact URL:
  ```js
  if (req.originalUrl.startsWith("/webhook/")) {
      req.rawBody = buf.toString("utf8");
  }
  ```

---

## 🟢 MINOR — Code Quality

| ID | File | Line | Issue |
|----|------|------|-------|
| BUG-10 | `payment.js` | All error responses | All errors return `status(200)` — should use `400`/`422` for client errors |
| BUG-11 | `payment.js` | L22 | `username` taken from raw header — ensure `auth` middleware validates it so it can't be spoofed |
| BUG-12 | `payment.js` | L312 | `RANDOM_STRING(10)` for `order_id` — may collide under high load. Use 16–20 chars or UUID |
| BUG-13 | `server.js` | L36 | `console.log` on every API request — high I/O in production. Gate behind `process.env.DEBUG` |
| BUG-14 | `paymentGateway.js` | L7 | `ACTIVE_GATEWAY` read at module load — changing `.env` requires server restart (expected, but should be documented) |

---

## 📊 Summary

| Priority | Count | Status |
|----------|-------|--------|
| 🔴 Critical | 5 (BUG-1 to BUG-5) | ⏳ Pending |
| 🟡 High Risk | 4 (BUG-6 to BUG-9) | ⏳ Pending |
| 🟢 Minor | 5 (BUG-10 to BUG-14) | ⏳ Pending |

---

> 💡 **Tip:** Fix BUG-5 (double credit) and BUG-3 (amount validation) first — these directly impact money.
