import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type { ServiceProvider, SendResult } from "../types.js";

// SMTP sends are NEVER retried automatically. If the connection drops mid-send,
// the server may have already accepted the email. Retrying risks duplicate delivery.

export class SmtpProvider implements ServiceProvider {
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

  // ServiceProvider lifecycle (no-ops: nodemailer manages connections internally)
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async ensureConnected(): Promise<void> {}

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
    // Build raw RFC822 message once, send it as-is, and return it for IMAP append.
    // This ensures the Sent Messages copy is byte-identical to what was delivered.
    const rawMessage = await this.buildRawMessage(options);
    const to = Array.isArray(options.to) ? options.to.join(", ") : options.to;
    const info = await this.transporter.sendMail({
      envelope: {
        from: options.from ?? this.email,
        to,
        cc: options.cc?.join(", "),
        bcc: options.bcc?.join(", "),
      },
      raw: rawMessage,
    });

    return {
      messageId: info.messageId,
      success: true,
      rawMessage,
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
    /**
     * Override the auto-generated Message-Id header with a deterministic value.
     * Used by triage_commit's draft leg (M4.2) to make APPEND idempotent: the
     * same idempotencyKey always derives the same Message-Id, so a SEARCH HEADER
     * before APPEND can dedupe at the IMAP level. Format: `<...@domain>`.
     */
    messageId?: string;
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
      messageId: options.messageId,
    });

    return await mail.compile().build();
  }
}
