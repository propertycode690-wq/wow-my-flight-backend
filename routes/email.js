const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

// Singleton Nodemailer transporter
let transporter = null;

function getTransporter() {
  if (!transporter) {
    const host = process.env.SMTP_HOST || 'fusion.mxrouting.net';
    const port = parseInt(process.env.SMTP_PORT || '465', 10);
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;
    const user = process.env.SMTP_USER || 'bookings@wowmyflight.com';
    const pass = process.env.SMTP_PASS || 'Wowmyflight@#123';

    transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: { user, pass },
      tls: {
        rejectUnauthorized: false
      }
    });
  }
  return transporter;
}

// 1. Verify SMTP connection
router.get('/verify', async (req, res) => {
  try {
    const mailer = getTransporter();
    await mailer.verify();
    return res.json({
      success: true,
      message: 'SMTP connection verified successfully!',
      host: process.env.SMTP_HOST || 'fusion.mxrouting.net',
      sender: process.env.SMTP_USER || 'bookings@wowmyflight.com'
    });
  } catch (err) {
    console.error('❌ [SMTP] Verify error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Send email endpoint
router.post('/send', async (req, res) => {
  try {
    const { to, subject, text, html, leadId } = req.body;

    if (!to || !subject || (!text && !html)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, subject, and text/html are required.'
      });
    }

    const fromName = process.env.SMTP_FROM_NAME || 'Wow My Flight';
    const fromEmail = process.env.SMTP_FROM_EMAIL || 'bookings@wowmyflight.com';
    const fromAddress = `"${fromName}" <${fromEmail}>`;

    const mailer = getTransporter();

    const info = await mailer.sendMail({
      from: fromAddress,
      to,
      subject,
      text: text || undefined,
      html: html || undefined
    });

    console.log(`✅ [Email Sent] ID: ${info.messageId} to ${to}`);

    return res.json({
      success: true,
      message: 'Email dispatched successfully via MXroute SMTP',
      messageId: info.messageId,
      accepted: info.accepted
    });
  } catch (err) {
    console.error('❌ [SMTP Send Error]:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
