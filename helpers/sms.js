import axios from 'axios';

import {
  FAST2SMS_API_KEY,
  FAST2SMS_SENDER_ID,
  FAST2SMS_URL,
  FAST2SMS_OTP_TEMPLATE,
} from './Config.js';
import { formatIndianMobileForSend } from './mobile.js';

export function isSmsConfigured() {
  return Boolean(FAST2SMS_API_KEY && FAST2SMS_URL && FAST2SMS_OTP_TEMPLATE);
}

/**
 * Send an OTP via Fast2SMS DLT route.
 * @param {string} mobile - 10-digit mobile number
 * @param {string} otp    - The OTP value to send
 */
export async function sendOtpSms(mobile, otp) {
  if (!isSmsConfigured()) {
    console.warn('Fast2SMS not configured — skipping OTP SMS');
    return;
  }

  const { data } = await axios.post(
    FAST2SMS_URL,
    {
      route: 'dlt',
      sender_id: FAST2SMS_SENDER_ID,
      message: FAST2SMS_OTP_TEMPLATE,
      variables_values: `${otp}|`,
      numbers: formatIndianMobileForSend(mobile),
    },
    {
      headers: {
        authorization: FAST2SMS_API_KEY,
        'Content-Type': 'application/json',
      },
    },
  );

  if (!data?.return) {
    throw new Error(data?.message?.[0] || 'Fast2SMS: failed to send OTP');
  }

  return data;
}
