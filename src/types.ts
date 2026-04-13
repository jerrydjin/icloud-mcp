export interface EmailAddress {
  name: string;
  address: string;
}

export interface FolderInfo {
  name: string;
  path: string;
  messageCount: number;
  unseenCount: number;
}

export interface MessageSummary {
  uid: number;
  subject: string;
  from: EmailAddress;
  date: string;
  flags: string[];
  hasAttachments: boolean;
}

export interface MessageFull {
  uid: number;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  cc: EmailAddress[];
  date: string;
  textBody: string;
  htmlBody?: string;
  truncated: boolean;
  attachments: AttachmentInfo[];
  messageId: string;
  inReplyTo?: string;
  references?: string[];
}

export interface AttachmentInfo {
  filename: string;
  size: number;
  contentType: string;
}

export interface SendResult {
  messageId: string;
  success: boolean;
}
