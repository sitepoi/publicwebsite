/**
 * Mail service abstraction (Section 15) — AWS SES + nodemailer (env creds
 * only). Template SELECTION and HTML composition happen server-side; this
 * interface only receives the finished message.
 */
export interface MailInput {
  from: string
  to: string
  subject: string
  html: string
  text?: string
}

export interface MailService {
  readonly name: string
  send(input: MailInput): Promise<void>
}
