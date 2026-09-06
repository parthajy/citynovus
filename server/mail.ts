// Email for verification and password resets. With SMTP_URL set it really sends;
// without it, the message is logged and kept so a developer can click the link.
export interface Mail { to: string; subject: string; text: string }
export const lastMails: Mail[] = [];

export async function sendMail(mail: Mail): Promise<void> {
  lastMails.unshift(mail);
  lastMails.length = Math.min(lastMails.length, 20);
  const url = process.env.SMTP_URL;
  if (!url) { console.log(`[mail → ${mail.to}] ${mail.subject}\n${mail.text}`); return; }
  const nodemailer = await import('nodemailer');
  const transport = nodemailer.createTransport(url);
  await transport.sendMail({ from: process.env.MAIL_FROM ?? 'CityNovus <no-reply@citynovus.com>', to: mail.to, subject: mail.subject, text: mail.text });
}
