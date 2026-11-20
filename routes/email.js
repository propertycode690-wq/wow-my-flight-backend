const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');

// Cache transporters per sender email to reuse SSL connections efficiently
const transporterPool = new Map();

function getTransporterForSender(senderEmail) {
  const host = process.env.SMTP_HOST || 'fusion.mxrouting.net';
  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const secure = process.env.SMTP_SECURE === 'true' || port === 465;

  // Use senderEmail or fallback to default bookings mailbox
  const emailUser = (senderEmail && senderEmail.includes('@wowmyflight.com'))
    ? senderEmail.trim().toLowerCase()
    : (process.env.SMTP_USER || 'bookings@wowmyflight.com');

  const emailPass = process.env.SMTP_PASS || 'Wowmyflight@#123';

  if (!transporterPool.has(emailUser)) {
    const transporter = nodemailer.createTransport({
      host,
      port,
      secure,
      auth: {
        user: emailUser,
        pass: emailPass
      },
      tls: {
        rejectUnauthorized: false
      }
    });
    transporterPool.set(emailUser, transporter);
  }

  return {
    transporter: transporterPool.get(emailUser),
    fromEmail: emailUser
  };
}

// 1. Verify SMTP connection for default or specific mailbox
router.get('/verify', async (req, res) => {
  try {
    const targetEmail = req.query.email || process.env.SMTP_USER || 'bookings@wowmyflight.com';
    const { transporter, fromEmail } = getTransporterForSender(targetEmail);
    await transporter.verify();
    return res.json({
      success: true,
      message: `SMTP connection verified successfully for ${fromEmail}`,
      host: process.env.SMTP_HOST || 'fusion.mxrouting.net',
      sender: fromEmail
    });
  } catch (err) {
    console.error('❌ [SMTP] Verify error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Dynamic Send Email Endpoint — Sends from the currently logged-in Agent or selected Dept
router.post('/send', async (req, res) => {
  try {
    const { to, subject, text, html, senderEmail, senderName, leadId } = req.body;

    if (!to || !subject || (!text && !html)) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: to, subject, and text/html are required.'
      });
    }

    // Determine sender identity:
    // If agent is logged in (e.g. req.user.email), use agent's own mailbox (e.g. issac@wowmyflight.com)
    const effectiveSenderEmail = senderEmail || req.user?.email || 'bookings@wowmyflight.com';
    const effectiveSenderName = senderName || req.user?.name || 'Wow My Flight';

    const { transporter, fromEmail } = getTransporterForSender(effectiveSenderEmail);
    const fromHeader = `"${effectiveSenderName}" <${fromEmail}>`;

    const info = await transporter.sendMail({
      from: fromHeader,
      to,
      replyTo: fromHeader,
      subject,
      text: text || undefined,
      html: html || undefined
    });

    console.log(`✅ [Email Sent] From: ${fromHeader} | To: ${to} | Subject: ${subject} | ID: ${info.messageId}`);

    return res.json({
      success: true,
      message: `Email dispatched successfully from ${fromEmail}`,
      from: fromHeader,
      messageId: info.messageId,
      accepted: info.accepted
    });
  } catch (err) {
    console.error('❌ [SMTP Send Error]:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
