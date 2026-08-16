import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses'
import nodemailer from 'nodemailer'
import type { MailService, MailInput } from './types'

/**
 * SesMailService (Section 15) — nodemailer composes the RFC-2822 message
 * (stream transport), AWS SES v3 delivers the raw buffer. Credentials are
 * env-only (SES_ACCESS_KEY_ID / SES_SECRET_ACCESS_KEY / SES_REGION /
 * SES_FROM_ADDRESS — Section 22).
 */
export class SesMailService implements MailService {
  readonly name = 'ses'

  private readonly client: SESClient
  private readonly transporter: ReturnType<typeof nodemailer.createTransport>

  constructor(
    private readonly options: {
      region: string
      fromAddress: string
      accessKeyId: string
      secretAccessKey: string
    },
  ) {
    this.client = new SESClient({
      region: this.options.region,
      credentials: {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
      },
    })
    this.transporter = nodemailer.createTransport({ streamTransport: true, buffer: true })
  }

  async send(input: MailInput): Promise<void> {
    const info = await this.transporter.sendMail({
      from: this.options.fromAddress,
      to: input.to,
      subject: input.subject,
      html: input.html,
      ...(input.text !== undefined ? { text: input.text } : {}),
    })
    const raw = (info as unknown as { message?: string | Buffer }).message
    if (!raw) throw new Error('nodemailer produced no raw message')
    if (typeof raw === 'string') {
      await this.client.send(
        new SendRawEmailCommand({ RawMessage: { Data: Buffer.from(raw, 'utf-8') } }),
      )
      return
    }
    await this.client.send(new SendRawEmailCommand({ RawMessage: { Data: raw } }))
  }
}
