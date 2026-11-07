import nodemailer from 'nodemailer';

export interface SendActivationEmailParams {
  to: string;
  firstName: string;
  paperTitle: string;
  openDocumentUrl: string;
}

export interface EmailResult {
  success: boolean;
  status: 'EMAIL SENT' | 'EMAIL FAILED' | 'EMAIL NOT CONFIGURED';
  error?: string;
  messageId?: string;
  response?: string;
}

export interface SmtpConfigDetails {
  smtpUser?: string;
  smtpPassword?: string;
  host: string;
  port: number;
  secure: boolean;
  userConfigured: boolean;
  passwordConfigured: boolean;
  userDomain?: string;
  passwordLength: number;
}

export interface SmtpDiagnosticResult {
  configured: boolean;
  host: string;
  port: number;
  secure: boolean;
  userConfigured: boolean;
  passwordConfigured: boolean;
  userDomain?: string;
  passwordLength: number;
  verified: boolean;
  message?: string;
  error?: string;
  errorCode?: string;
  response?: string;
}

/**
 * Resolves normalized SMTP configuration from environment variables,
 * supporting standard aliases (e.g. SMTP_USER, EMAIL_USER, GMAIL_USER)
 * and safely trimming whitespace/quotes.
 */
export function getSmtpConfig(): SmtpConfigDetails {
  const rawUser = (process.env.SMTP_USER || process.env.EMAIL_USER || process.env.GMAIL_USER);
  const rawPassword = (process.env.SMTP_PASSWORD || process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.GMAIL_APP_PASSWORD);
  const rawHost = (process.env.SMTP_HOST || process.env.EMAIL_HOST || 'smtp.gmail.com');
  const rawPort = (process.env.SMTP_PORT || process.env.EMAIL_PORT || '587');
  const rawSecure = process.env.SMTP_SECURE;

  const smtpUser = rawUser ? rawUser.trim().replace(/^["']|["']$/g, '') : undefined;
  const smtpPassword = rawPassword ? rawPassword.trim().replace(/^["']|["']$/g, '') : undefined;
  const host = rawHost.trim().replace(/^["']|["']$/g, '') || 'smtp.gmail.com';
  const port = parseInt(rawPort.trim().replace(/^["']|["']$/g, ''), 10) || 587;

  // Port 465 requires direct SSL (secure: true).
  // Port 587 uses STARTTLS (secure: false).
  // If SMTP_SECURE is explicitly specified, respect it; otherwise derive from port.
  let secure = port === 465;
  if (rawSecure !== undefined) {
    const trimmedSecure = rawSecure.trim().replace(/^["']|["']$/g, '').toLowerCase();
    if (trimmedSecure === 'true') {
      secure = true;
    } else if (trimmedSecure === 'false') {
      secure = false;
    }
  }

  const userConfigured = Boolean(smtpUser && smtpUser.length > 0);
  const passwordConfigured = Boolean(smtpPassword && smtpPassword.length > 0);
  const userDomain = smtpUser && smtpUser.includes('@') ? smtpUser.split('@')[1] : undefined;
  const passwordLength = smtpPassword ? smtpPassword.length : 0;

  return {
    smtpUser,
    smtpPassword,
    host,
    port,
    secure,
    userConfigured,
    passwordConfigured,
    userDomain,
    passwordLength,
  };
}

/**
 * Creates a Nodemailer transport instance using the resolved configuration.
 */
let _transporter: any = null;

export function setSmtpTransporter(t: any) {
  _transporter = t;
}

export function createSmtpTransporter() {
  if (_transporter) return _transporter;

  const { smtpUser, smtpPassword, host, port, secure, userConfigured, passwordConfigured } = getSmtpConfig();

  if (!userConfigured || !passwordConfigured || !smtpUser || !smtpPassword) {
    return null;
  }

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: smtpUser,
      pass: smtpPassword,
    },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
  });
}

/**
 * Verifies SMTP server connectivity and credentials without sending an email.
 * Never logs or returns secret values.
 */
export async function verifySmtpConnection(): Promise<SmtpDiagnosticResult> {
  const config = getSmtpConfig();
  const { host, port, secure, userConfigured, passwordConfigured, userDomain, passwordLength } = config;

  if (!userConfigured || !passwordConfigured) {
    return {
      configured: false,
      host,
      port,
      secure,
      userConfigured,
      passwordConfigured,
      userDomain,
      passwordLength,
      verified: false,
      error: 'SMTP credentials (SMTP_USER / SMTP_PASSWORD) are not configured in environment.',
    };
  }

  const transporter = createSmtpTransporter();
  if (!transporter) {
    return {
      configured: false,
      host,
      port,
      secure,
      userConfigured,
      passwordConfigured,
      userDomain,
      passwordLength,
      verified: false,
      error: 'Failed to initialize SMTP transporter with provided configuration.',
    };
  }

  try {
    await transporter.verify();
    console.log('[SMTP DIAGNOSTIC SUCCESS]', {
      host,
      port,
      secure,
      user_configured: userConfigured,
      user_domain: userDomain,
      password_length: passwordLength,
    });
    return {
      configured: true,
      host,
      port,
      secure,
      userConfigured,
      passwordConfigured,
      userDomain,
      passwordLength,
      verified: true,
      message: 'SMTP transport connection and authentication verified successfully.',
    };
  } catch (err: any) {
    // SECURITY: Never log the password
    console.error('[SMTP DIAGNOSTIC ERROR]', {
      host,
      port,
      secure,
      errorCode: err.code,
      errorMessage: err.message,
      responseCode: err.responseCode,
      command: err.command,
    });
    return {
      configured: true,
      host,
      port,
      secure,
      userConfigured,
      passwordConfigured,
      userDomain,
      passwordLength,
      verified: false,
      error: err.message || 'SMTP verification failed.',
      errorCode: err.code,
      response: err.response,
    };
  }
}

export async function sendActivationEmail(params: SendActivationEmailParams): Promise<EmailResult> {
  const { to, firstName, paperTitle, openDocumentUrl } = params;

  if (!to || !to.includes('@')) {
    return {
      success: false,
      status: 'EMAIL FAILED',
      error: 'Invalid recipient email address.',
    };
  }

  const config = getSmtpConfig();
  const { smtpUser, host, port, secure, userConfigured, passwordConfigured, userDomain, passwordLength } = config;

  // If SMTP credentials are not configured
  if (!userConfigured || !passwordConfigured || !smtpUser) {
    console.warn('[EMAIL] SMTP credentials (SMTP_USER / SMTP_PASSWORD) not configured. Activation email skipped.', {
      user_configured: userConfigured,
      password_configured: passwordConfigured,
      host,
      port,
    });
    return {
      success: false,
      status: 'EMAIL NOT CONFIGURED',
      error: 'SMTP credentials (SMTP_USER / SMTP_PASSWORD) are not configured in environment.',
    };
  }

  const transporter = createSmtpTransporter();
  if (!transporter) {
    return {
      success: false,
      status: 'EMAIL FAILED',
      error: 'Failed to initialize SMTP transporter.',
    };
  }

  try {
    const displayName = firstName ? firstName.trim() : 'Valued Student';

    const textContent = `Hello ${displayName},

Your payment has been confirmed and your document has been activated.

Document:
${paperTitle}

Open your document here:
${openDocumentUrl}

Your document opens securely in your browser.
For security, access is limited to a maximum of 3 devices.

Please keep this email and your document link safe.

Godrery Publishers`;

    const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Godrery Publishers document is ready</title>
</head>
<body style="margin:0;padding:24px 12px;background-color:#0b1120;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:560px;background-color:#0f172a;border:1px solid #1e293b;border-radius:16px;overflow:hidden;">
          <!-- Header Banner -->
          <tr>
            <td style="background-color:#022c22;padding:28px 32px;border-bottom:3px solid #00D26A;">
              <h1 style="margin:0;font-size:22px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">GODRERY PUBLISHERS</h1>
              <p style="margin:6px 0 0 0;font-size:12px;color:#00D26A;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Official Document Delivery</p>
            </td>
          </tr>
          <!-- Body Content -->
          <tr>
            <td style="padding:32px;">
              <p style="margin:0 0 16px 0;font-size:16px;color:#f8fafc;">Hello <strong>${displayName}</strong>,</p>
              <p style="margin:0 0 20px 0;font-size:15px;color:#cbd5e1;line-height:1.6;">Your payment has been confirmed and your document has been activated.</p>
              
              <div style="background-color:#1e293b;border-left:4px solid #00D26A;border-radius:8px;padding:16px 20px;margin:24px 0;">
                <span style="display:block;font-size:11px;font-weight:700;text-transform:uppercase;color:#94a3b8;letter-spacing:0.5px;margin-bottom:4px;">Document:</span>
                <span style="font-size:16px;font-weight:700;color:#ffffff;">${paperTitle}</span>
              </div>

              <div style="text-align:center;margin:32px 0;">
                <a href="${openDocumentUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background-color:#00D26A;color:#022c22;text-decoration:none;padding:14px 32px;font-size:15px;font-weight:800;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;">
                  OPEN YOUR DOCUMENT
                </a>
              </div>

              <p style="margin:16px 0 8px 0;font-size:14px;color:#94a3b8;line-height:1.5;">Your document opens securely in your browser.</p>
              <p style="margin:0 0 24px 0;font-size:14px;color:#94a3b8;line-height:1.5;">For security, access is limited to a maximum of 3 devices.</p>

              <hr style="border:0;border-top:1px solid #1e293b;margin:24px 0;" />

              <p style="margin:0 0 8px 0;font-size:13px;color:#64748b;">Please keep this email and your document link safe.</p>
              <p style="margin:0;font-size:14px;font-weight:700;color:#ffffff;">Godrery Publishers</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    console.log(`[EMAIL DISPATCH] Dispatching document activation email to ${to} via ${host}:${port} (secure=${secure})`);

    const info = await transporter.sendMail({
      from: `"Godrery Publishers" <${smtpUser}>`,
      to,
      subject: 'Your Godrery Publishers document is ready',
      text: textContent,
      html: htmlContent,
    });

    console.log(`[EMAIL SUCCESS] SMTP relay accepted email for delivery to ${to}. MessageId: ${info.messageId}`);
    return {
      success: true,
      status: 'EMAIL SENT',
      messageId: info.messageId,
      response: info.response,
    };
  } catch (err: any) {
    // SECURITY: Never log process.env.SMTP_PASSWORD
    console.error(`[EMAIL ERROR] Failed to send email to ${to}:`, {
      code: err.code,
      message: err.message,
      command: err.command,
      responseCode: err.responseCode,
    });
    return {
      success: false,
      status: 'EMAIL FAILED',
      error: err.message || 'SMTP delivery failure',
    };
  }
}

export function getHostAdminEmail(): string {
  const host = process.env.ADMIN_EMAIL || process.env.HOST_EMAIL || process.env.SMTP_USER || process.env.EMAIL_USER;
  return host ? host.trim().replace(/^["']|["']$/g, '') : 'admin@godrerypublishers.com';
}

export interface SendAffiliateSubmissionNotificationParams {
  to?: string;
  affiliateName: string;
  affiliateEmail: string;
  affiliatePhone: string;
  referenceCode: string;
  paperTitle: string;
  unitCode?: string;
  category?: string;
  academicLevel?: string;
  description?: string;
  originalFileName?: string;
  fileSizeBytes?: number;
  submissionDate?: string;
  reviewUrl: string;
}

export async function sendAffiliateSubmissionNotificationEmail(
  params: SendAffiliateSubmissionNotificationParams
): Promise<EmailResult> {
  const to = params.to || getHostAdminEmail();

  if (!to || !to.includes('@')) {
    return {
      success: false,
      status: 'EMAIL FAILED',
      error: 'Invalid recipient host email address.',
    };
  }

  const config = getSmtpConfig();
  const { smtpUser, userConfigured, passwordConfigured } = config;

  if (!userConfigured || !passwordConfigured || !smtpUser) {
    console.warn('[EMAIL] SMTP credentials not configured. Affiliate submission notification skipped.');
    return {
      success: false,
      status: 'EMAIL NOT CONFIGURED',
      error: 'SMTP credentials are not configured in environment.',
    };
  }

  const transporter = createSmtpTransporter();
  if (!transporter) {
    return {
      success: false,
      status: 'EMAIL FAILED',
      error: 'Failed to initialize SMTP transporter.',
    };
  }

  const {
    affiliateName,
    affiliateEmail,
    affiliatePhone,
    referenceCode,
    paperTitle,
    unitCode = 'Unspecified',
    category = 'General Examination Paper',
    academicLevel = 'Higher Education',
    description = 'No extra description provided.',
    originalFileName = 'Document.pdf',
    fileSizeBytes = 0,
    submissionDate = new Date().toUTCString(),
    reviewUrl,
  } = params;

  const fileSizeMb = (fileSizeBytes / (1024 * 1024)).toFixed(2);

  const textContent = `GODRERY PUBLISHERS — NEW AFFILIATE DOCUMENT SUBMISSION
======================================================
Submission Reference: ${referenceCode}
Status: PENDING ADMIN REVIEW (Not yet published)

Affiliate Details:
- Name: ${affiliateName}
- Email: ${affiliateEmail}
- Phone: ${affiliatePhone}

Paper Details:
- Proposed Title: ${paperTitle}
- Unit Code: ${unitCode}
- Category: ${category}
- Academic Level: ${academicLevel}
- Original File: ${originalFileName} (${fileSizeMb} MB)
- Description: ${description}
- Submitted: ${submissionDate}

To review, edit metadata, and approve or reject this submission, click below:
${reviewUrl}

NOTE: This paper has NOT been added to the main Papers Database.
An authorized administrator must review and click "Push to Papers Database" before it becomes public.

Godrery Publishers Operations Desk`;

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>New Affiliate Document Submitted: ${referenceCode}</title>
</head>
<body style="margin:0;padding:24px 12px;background-color:#0b1120;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:620px;background-color:#0f172a;border:1px solid #1e293b;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="background-color:#022c22;padding:24px 30px;border-bottom:3px solid #00D26A;">
              <div style="font-size:11px;font-weight:800;color:#00D26A;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px;">
                Godrery Publishers • Operations Alert
              </div>
              <h1 style="margin:0;font-size:20px;font-weight:800;color:#ffffff;letter-spacing:-0.5px;">
                New Affiliate Document Submitted
              </h1>
            </td>
          </tr>
          <tr>
            <td style="padding:28px 30px;">
              <div style="display:inline-block;background-color:#f59e0b20;border:1px solid #f59e0b50;border-radius:8px;padding:6px 14px;color:#fbbf24;font-size:12px;font-weight:700;margin-bottom:20px;">
                STATUS: PENDING ADMIN REVIEW (Staged / Not in Public Database)
              </div>

              <div style="background-color:#1e293b;border-radius:12px;padding:18px 20px;margin-bottom:24px;">
                <div style="font-size:12px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">Paper Details</div>
                <div style="font-size:17px;font-weight:800;color:#ffffff;margin-bottom:6px;">${paperTitle}</div>
                <div style="font-size:13px;color:#cbd5e1;line-height:1.5;">
                  <strong>Unit Code:</strong> ${unitCode} &nbsp;|&nbsp;
                  <strong>Category:</strong> ${category} &nbsp;|&nbsp;
                  <strong>Level:</strong> ${academicLevel}
                </div>
                <div style="font-size:12px;color:#94a3b8;margin-top:6px;">
                  <strong>File:</strong> ${originalFileName} (${fileSizeMb} MB)
                </div>
              </div>

              <div style="background-color:#1e293b;border-radius:12px;padding:18px 20px;margin-bottom:24px;">
                <div style="font-size:12px;color:#94a3b8;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Affiliate / Contributor</div>
                <div style="font-size:14px;color:#ffffff;font-weight:700;">${affiliateName}</div>
                <div style="font-size:13px;color:#cbd5e1;margin-top:2px;">Email: <a href="mailto:${affiliateEmail}" style="color:#00D26A;text-decoration:none;">${affiliateEmail}</a></div>
                <div style="font-size:13px;color:#cbd5e1;margin-top:2px;">Phone / WhatsApp: <a href="tel:${affiliatePhone}" style="color:#00D26A;text-decoration:none;">${affiliatePhone}</a></div>
                <div style="font-size:12px;color:#94a3b8;margin-top:6px;"><strong>Reference:</strong> <code style="background-color:#0f172a;padding:2px 6px;border-radius:4px;color:#38bdf8;">${referenceCode}</code></div>
              </div>

              ${description ? `
              <div style="margin-bottom:24px;">
                <div style="font-size:12px;color:#94a3b8;font-weight:700;text-transform:uppercase;margin-bottom:4px;">Description / Notes:</div>
                <div style="font-size:13px;color:#cbd5e1;background-color:#0b1120;padding:12px 16px;border-radius:8px;border:1px solid #1e293b;line-height:1.5;">${description}</div>
              </div>` : ''}

              <!-- Prominent CTA Button -->
              <div style="text-align:center;margin:32px 0;">
                <a href="${reviewUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background-color:#00D26A;color:#022c22;text-decoration:none;padding:15px 34px;font-size:15px;font-weight:800;border-radius:10px;text-transform:uppercase;letter-spacing:0.5px;box-shadow:0 4px 14px rgba(0,210,106,0.3);">
                  VIEW SUBMITTED DOCUMENT
                </a>
              </div>

              <div style="background-color:#021b14;border:1px dashed #00D26A50;border-radius:8px;padding:12px 16px;font-size:12px;color:#6ee7b7;line-height:1.5;">
                <strong>Security Guard:</strong> This document is staged in the review queue. It will not be visible to students or appear in the search index until an administrator logs in, verifies the content, and clicks <strong>"Push to Papers Database"</strong>.
              </div>

              <hr style="border:0;border-top:1px solid #1e293b;margin:24px 0;" />
              <div style="font-size:12px;color:#64748b;">
                Sent automatically by Godrery Publishers platform to host inbox (${to}).
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const info = await transporter.sendMail({
      from: `"Godrery Operations" <${smtpUser}>`,
      to,
      subject: `[Affiliate Submission] ${paperTitle} (${referenceCode})`,
      text: textContent,
      html: htmlContent,
    });

    console.log(`[EMAIL SUCCESS] Affiliate submission notification sent to ${to}. MessageId: ${info.messageId}`);
    return {
      success: true,
      status: 'EMAIL SENT',
      messageId: info.messageId,
      response: info.response,
    };
  } catch (err: any) {
    console.error(`[EMAIL ERROR] Failed to send affiliate submission email to ${to}:`, err.message);
    return {
      success: false,
      status: 'EMAIL FAILED',
      error: err.message || 'SMTP delivery failure',
    };
  }
}

export interface SendContactMessageParams {
  to?: string;
  fullName: string;
  email: string;
  phone: string;
  subject: string;
  message: string;
  timestamp?: string;
}

export async function sendContactMessageEmail(
  params: SendContactMessageParams
): Promise<EmailResult> {
  const to = params.to || getHostAdminEmail();

  if (!to || !to.includes('@')) {
    return {
      success: false,
      status: 'EMAIL FAILED',
      error: 'Invalid recipient host email address.',
    };
  }

  const config = getSmtpConfig();
  const { smtpUser, userConfigured, passwordConfigured } = config;

  if (!userConfigured || !passwordConfigured || !smtpUser) {
    console.warn('[EMAIL] SMTP credentials not configured. Contact message email skipped.');
    return {
      success: false,
      status: 'EMAIL NOT CONFIGURED',
      error: 'SMTP credentials are not configured in environment.',
    };
  }

  const transporter = createSmtpTransporter();
  if (!transporter) {
    return {
      success: false,
      status: 'EMAIL FAILED',
      error: 'Failed to initialize SMTP transporter.',
    };
  }

  const {
    fullName,
    email,
    phone,
    subject,
    message,
    timestamp = new Date().toUTCString(),
  } = params;

  const textContent = `GODRERY PUBLISHERS — NEW CONTACT INQUIRY
===========================================
From: ${fullName}
Email: ${email}
Phone: ${phone}
Subject: ${subject}
Date: ${timestamp}

Message:
${message}

Reply directly to: ${email}`;

  const htmlContent = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Contact Message: ${subject}</title>
</head>
<body style="margin:0;padding:24px 12px;background-color:#0b1120;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#e2e8f0;">
  <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width:580px;background-color:#0f172a;border:1px solid #1e293b;border-radius:16px;overflow:hidden;">
          <tr>
            <td style="background-color:#022c22;padding:22px 28px;border-bottom:3px solid #00D26A;">
              <h1 style="margin:0;font-size:18px;font-weight:800;color:#ffffff;">New Contact Inquiry Received</h1>
              <p style="margin:4px 0 0 0;font-size:12px;color:#00D26A;font-weight:600;">Student / Customer Helpdesk</p>
            </td>
          </tr>
          <tr>
            <td style="padding:28px;">
              <div style="background-color:#1e293b;border-radius:10px;padding:16px 20px;margin-bottom:20px;">
                <div style="font-size:12px;color:#94a3b8;font-weight:700;">FROM:</div>
                <div style="font-size:15px;color:#ffffff;font-weight:700;margin-top:2px;">${fullName}</div>
                <div style="font-size:13px;color:#cbd5e1;margin-top:4px;">Email: <a href="mailto:${email}" style="color:#00D26A;">${email}</a></div>
                <div style="font-size:13px;color:#cbd5e1;margin-top:2px;">Phone: <a href="tel:${phone}" style="color:#00D26A;">${phone}</a></div>
                <div style="font-size:13px;color:#cbd5e1;margin-top:4px;"><strong>Subject:</strong> ${subject}</div>
              </div>

              <div style="font-size:12px;color:#94a3b8;font-weight:700;text-transform:uppercase;margin-bottom:6px;">Message:</div>
              <div style="background-color:#0b1120;border:1px solid #1e293b;border-radius:10px;padding:16px 20px;color:#f1f5f9;font-size:14px;line-height:1.6;white-space:pre-wrap;">
${message}
              </div>

              <div style="text-align:center;margin:28px 0 10px 0;">
                <a href="mailto:${email}?subject=Re:%20${encodeURIComponent(subject)}" style="display:inline-block;background-color:#00D26A;color:#022c22;text-decoration:none;padding:12px 28px;font-size:14px;font-weight:800;border-radius:8px;">
                  REPLY TO SENDER
                </a>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  try {
    const info = await transporter.sendMail({
      from: `"Godrery Contact Desk" <${smtpUser}>`,
      to,
      replyTo: email,
      subject: `[Contact Inquiry] ${subject} - ${fullName}`,
      text: textContent,
      html: htmlContent,
    });

    console.log(`[EMAIL SUCCESS] Contact message sent to ${to}. MessageId: ${info.messageId}`);
    return {
      success: true,
      status: 'EMAIL SENT',
      messageId: info.messageId,
      response: info.response,
    };
  } catch (err: any) {
    console.error(`[EMAIL ERROR] Failed to send contact email to ${to}:`, err.message);
    return {
      success: false,
      status: 'EMAIL FAILED',
      error: err.message || 'SMTP delivery failure',
    };
  }
}


