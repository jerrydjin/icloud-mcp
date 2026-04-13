import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import type { SendResult } from "../types.ts";

// SMTP sends are NEVER retried automatically. If the connection drops mid-send,
// the server may have already accepted the email. Retrying risks duplicate delivery.

export class SmtpProvider {
  private transporter: nodemailer.Transporter;
  private email: string;

  constructor(
    host: string,
    port: number,
    email: string,
    password: string
  ) {
    this.email = email;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: false, // STARTTLS on port 587
      auth: { user: email, pass: password },
    });
  }

  get defaultEmail(): string {
    return this.email;
  }

  async send(options: {
    to: string | string[];
    subject: string;
    body: string;
    from?: string;
    fromName?: string;
    cc?: string[];
    bcc?: string[];
    inReplyTo?: string;
    references?: string[];
  }): Promise<SendResult> {
    const to = Array.isArray(options.to) ? options.to.join(", ") : options.to;
    const address = options.from ?? this.email;
    const fromHeader = options.fromName
      ? `${options.fromName} <${address}>`
      : address;
    const info = await this.transporter.sendMail({
      from: fromHeader,
      to,
      cc: options.cc?.join(", "),
      bcc: options.bcc?.join(", "),
      subject: options.subject,
      text: options.body,
      inReplyTo: options.inReplyTo,
      references: options.references?.join(" "),
    });

    return {
      messageId: info.messageId,
      success: true,
    };
  }

  async buildRawMessage(options: {
    to: string | string[];
    subject: string;
    body: string;
    from?: string;
    fromName?: string;
    cc?: string[];
    bcc?: string[];
    inReplyTo?: string;
    references?: string[];
  }): Promise<Buffer> {
    const to = Array.isArray(options.to) ? options.to.join(", ") : options.to;
    const address = options.from ?? this.email;
    const fromHeader = options.fromName
      ? `${options.fromName} <${address}>`
      : address;

    const mail = new MailComposer({
      from: fromHeader,
      to,
      cc: options.cc?.join(", "),
      bcc: options.bcc?.join(", "),
      subject: options.subject,
      text: options.body,
      inReplyTo: options.inReplyTo,
      references: options.references?.join(" "),
    });

    return await mail.compile().build();
  }
}
