const { log } = require('./logger');

function createMailer(env = process.env) {
    if (env.NODE_ENV === 'production' || env.SMTP_HOST) {
        const nodemailer = require('nodemailer');
        const port = Number(env.SMTP_PORT || 587);
        const transport = nodemailer.createTransport({
            host: env.SMTP_HOST,
            port,
            secure: port === 465,
            ...(env.SMTP_USER && env.SMTP_PASSWORD ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } } : {})
        });
        return {
            async sendPasswordReset(email, url) {
                await transport.sendMail({
                    from: env.SMTP_FROM,
                    to: email,
                    subject: 'Reset your ORION password',
                    text: `Use this one-time link within 30 minutes to reset your ORION password:\n\n${url}\n`
                });
            }
        };
    }

    return {
        async sendPasswordReset(_email, _url) {
            // Keep reset tokens out of logs. Configure a local SMTP sink to receive test links.
            log('info', 'development_mailer_delivery', { detail: 'Password reset message delivered to development transport; link redacted.' });
        }
    };
}

module.exports = { createMailer };
