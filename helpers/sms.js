import axios from 'axios';

import { getConfig } from './runtimeConfig.js';
import { formatIndianMobileForSend } from './mobile.js';

export function isSmsConfigured() {
  return Boolean(getConfig('fast2sms_api_key') && getConfig('fast2sms_url') && getConfig('fast2sms_otp_template'));
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
    getConfig('fast2sms_url'),
    {
      route: 'dlt',
      sender_id: getConfig('fast2sms_sender_id'),
      message: getConfig('fast2sms_otp_template'),
      variables_values: `${otp}|`,
      numbers: formatIndianMobileForSend(mobile),
    },
    {
      headers: {
        authorization: getConfig('fast2sms_api_key'),
        'Content-Type': 'application/json',
      },
    },
  );

  if (!data?.return) {
    throw new Error(data?.message?.[0] || 'Fast2SMS: failed to send OTP');
  }

  return data;
}
