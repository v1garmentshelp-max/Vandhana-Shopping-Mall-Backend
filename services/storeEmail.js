const addressParser = require('nodemailer/lib/addressparser');
const STORE_NAME = 'V1 Garments';

function senderAddress(env = process.env) {
  const raw = String(env.FROM_EMAIL || env.SMTP_USER || '').trim();
  const addresses = addressParser(raw, { flatten: true });
  if (addresses.length !== 1 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(addresses[0].address || '') || /[\r\n]/.test(raw)) {
    throw new Error('Configure FROM_EMAIL with one verified sender email address');
  }
  return { name: STORE_NAME, address: addresses[0].address };
}

function mailTransportOptions(env = process.env) {
  const port = Number(env.SMTP_PORT || 465);
  return {
    host: env.SMTP_HOST || 'smtp.gmail.com',
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS }
  };
}

function passwordResetMail(to, otp, env = process.env) {
  if (!/^\d{6}$/.test(String(otp))) throw new Error('Invalid password reset OTP');
  return {
    from: senderAddress(env),
    to,
    subject: `${STORE_NAME} password reset OTP`,
    text: `Your ${STORE_NAME} password reset OTP is ${otp}. It is valid for 10 minutes.`,
    html: `<div style="font-family:Arial,sans-serif;color:#111;max-width:520px;margin:auto;padding:24px"><h2 style="margin:0 0 16px">Reset your ${STORE_NAME} password</h2><p>Use the OTP below to continue:</p><div style="font-size:32px;font-weight:700;letter-spacing:8px;margin:24px 0">${otp}</div><p>This OTP is valid for 10 minutes. Do not share it with anyone.</p></div>`
  };
}

module.exports = { STORE_NAME, senderAddress, mailTransportOptions, passwordResetMail };
