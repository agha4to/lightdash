import {
    CreateProjectMember,
    InviteLink,
    PasswordResetLink,
    ProjectMemberRole,
    SessionUser,
    SmptError,
} from '@lightdash/common';
import { marked } from 'marked';
import * as nodemailer from 'nodemailer';
import hbs from 'nodemailer-express-handlebars';
import Mail from 'nodemailer/lib/mailer';
import { AuthenticationType } from 'nodemailer/lib/smtp-connection';
import SMTPPool from 'nodemailer/lib/smtp-pool';
import path from 'path';
import { LightdashConfig } from '../../config/parseConfig';
import Logger from '../../logging/logger';

export type AttachmentUrl = {
    path: string;
    filename: string;
    localPath: string;
    truncated: boolean;
};
type EmailClientArguments = {
    lightdashConfig: Pick<LightdashConfig, 'smtp' | 'siteUrl' | 'query'>;
};

type EmailTemplate = {
    template: string;
    context: Record<
        string,
        string | boolean | number | AttachmentUrl[] | undefined
    >;
    attachments?: (Mail.Attachment | AttachmentUrl)[] | undefined;
};

export default class EmailClient {
    lightdashConfig: Pick<LightdashConfig, 'smtp' | 'siteUrl' | 'query'>;

    transporter: nodemailer.Transporter | undefined;

    constructor({ lightdashConfig }: EmailClientArguments) {
        this.lightdashConfig = lightdashConfig;

        if (this.lightdashConfig.smtp) {
            Logger.debug(`Create email transporter`);

            let auth: AuthenticationType | undefined;

            if (this.lightdashConfig.smtp.useAuth) {
                if (this.lightdashConfig.smtp.auth.accessToken) {
                    auth = {
                        type: 'OAuth2',
                        user: this.lightdashConfig.smtp.auth.user,
                        accessToken: this.lightdashConfig.smtp.auth.accessToken,
                    };
                } else {
                    auth = {
                        user: this.lightdashConfig.smtp.auth.user,
                        pass: this.lightdashConfig.smtp.auth.pass,
                    };
                }
            }

            const options: SMTPPool.Options = {
                host: this.lightdashConfig.smtp.host,
                port: this.lightdashConfig.smtp.port,
                secure: this.lightdashConfig.smtp.port === 465, // false for any port beside 465, other ports use STARTTLS instead.
                ...(auth ? { auth } : {}),
                requireTLS: this.lightdashConfig.smtp.secure, // Forces STARTTTLS. Recommended when port is not 465.
                tls: this.lightdashConfig.smtp.allowInvalidCertificate
                    ? { rejectUnauthorized: false }
                    : undefined,
                pool: true, // Enable pooled connections
                maxConnections: 5, // Maximum number of connections (default is 5)
                maxMessages: 100, // Maximum number of messages per connection (default is 100)
            };

            this.transporter = nodemailer.createTransport(options, {
                from: `"${this.lightdashConfig.smtp.sender.name}" <${this.lightdashConfig.smtp.sender.email}>`,
            });
            this.transporter.verify((error) => {
                if (error) {
                    throw new SmptError(
                        `Failed to verify email transporter. ${error}`,
                        {
                            error,
                        },
                    );
                } else {
                    Logger.debug(`Email transporter verified with success`);
                }
            });

            this.transporter.use(
                'compile',
                hbs({
                    viewEngine: {
                        partialsDir: path.join(__dirname, './templates/'),
                        defaultLayout: undefined,
                        extname: '.html',
                    },
                    viewPath: path.join(__dirname, './templates/'),
                    extName: '.html',
                }),
            );
        }
    }

    private async sendEmail(
        options: Mail.Options & EmailTemplate,
    ): Promise<void> {
        if (this.transporter) {
            try {
                const info = await this.transporter.sendMail(options);
                Logger.debug(`Email sent: ${info.messageId}`);
            } catch (error) {
                throw new SmptError(`Failed to send email. ${error}`, {
                    error,
                });
            }
        }
    }

    public canSendEmail() {
        return !!this.transporter;
    }

    public async sendPasswordRecoveryEmail(link: PasswordResetLink) {
        return this.sendEmail({
            to: link.email,
            subject: 'Reset your password',
            template: 'recoverPassword',
            context: {
                url: link.url,
                host: this.lightdashConfig.siteUrl,
            },
            text: `Forgotten your password? No worries! Just click on the link below within the next 24 hours to create a new one: ${link.url}`,
        });
    }

    public async sendGoogleSheetsErrorNotificationEmail(
        recipient: string,
        schedulerName: string,
        schedulerUrl: string,
    ) {
        return this.sendEmail({
            to: recipient,
            subject: `Google Sheets sync: "${schedulerName}" disabled due to error`,
            template: 'googleSheetsSyncDisabledNotification',
            context: {
                host: this.lightdashConfig.siteUrl,
                subject: 'Google Sheets Sync disabled',
                description: `There's an error with your Google Sheets "${schedulerName}" sync. We've disabled it to prevent further errors.`,
                schedulerUrl,
            },
            text: `Your Google Sheets ${schedulerName} sync has been disabled due to an error`,
        });
    }

    public async sendInviteEmail(
        userThatInvited: Pick<
            SessionUser,
            'firstName' | 'lastName' | 'organizationName'
        >,
        invite: InviteLink,
    ) {
        return this.sendEmail({
            to: invite.email,
            subject: `You've been invited to join Lightdash`,
            template: 'invitation',
            context: {
                orgName: userThatInvited.organizationName,
                inviteUrl: `${invite.inviteUrl}?from=email`,
                host: this.lightdashConfig.siteUrl,
            },
            text: `Your teammates at ${userThatInvited.organizationName} are using Lightdash to discover and share data insights. Click on the link below within the next 72 hours to join your team and start exploring your data! ${invite.inviteUrl}?from=email`,
        });
    }

    public async sendProjectAccessEmail(
        userThatInvited: Pick<SessionUser, 'firstName' | 'lastName'>,
        projectMember: CreateProjectMember,
        projectName: string,
        projectUrl: string,
    ) {
        let roleAction = 'view';
        switch (projectMember.role) {
            case ProjectMemberRole.VIEWER:
                roleAction = 'view';
                break;
            case ProjectMemberRole.INTERACTIVE_VIEWER:
                roleAction = 'explore';
                break;
            case ProjectMemberRole.EDITOR:
            case ProjectMemberRole.DEVELOPER:
                roleAction = 'edit';
                break;
            case ProjectMemberRole.ADMIN:
                roleAction = 'manage';
                break;
            default:
                const nope: never = projectMember.role;
        }
        return this.sendEmail({
            to: projectMember.email,
            subject: `${userThatInvited.firstName} ${userThatInvited.lastName} invited you to ${projectName}`,
            template: 'projectAccess',
            context: {
                inviterName: `${userThatInvited.firstName} ${userThatInvited.lastName}`,
                projectUrl,
                host: this.lightdashConfig.siteUrl,
                projectName,
                roleAction,
            },
            text: `${userThatInvited.firstName} ${userThatInvited.lastName} has invited you to ${roleAction} this project: ${projectUrl}`,
        });
    }

    public async sendImageNotificationEmail(
        recipient: string,
        subject: string,
        title: string,
        description: string,
        message: string | undefined,
        date: string,
        frequency: string,
        imageUrl: string,
        url: string,
        schedulerUrl: string,
        includeLinks: boolean,
        pdfFile?: string,
        expirationDays?: number,
        deliveryType: string = 'Scheduled delivery',
    ) {
        return this.sendEmail({
            to: recipient,
            subject,
            template: 'imageNotification',
            context: {
                title,
                hasMessage: !!message,
                message: message && marked(message),
                imageUrl,
                description,
                date,
                frequency,
                url,
                host: this.lightdashConfig.siteUrl,
                schedulerUrl,
                expirationDays,
                deliveryType,
                includeLinks,
            },
            text: title,
            attachments: pdfFile
                ? [
                      {
                          filename: `${title}.pdf`,
                          path: pdfFile,
                          contentType: 'application/pdf',
                      },
                  ]
                : undefined,
        });
    }

    public async sendChartCsvNotificationEmail(
        recipient: string,
        subject: string,
        title: string,
        description: string,
        message: string | undefined,
        date: string,
        frequency: string,
        attachment: AttachmentUrl,
        url: string,
        schedulerUrl: string,
        includeLinks: boolean,
        expirationDays?: number,
    ) {
        const csvUrl = attachment.path;
        return this.sendEmail({
            to: recipient,
            subject,
            template: 'chartCsvNotification',
            context: {
                title,
                description,
                hasMessage: !!message,
                message: message && marked(message),
                date,
                frequency,
                url,
                csvUrl,
                truncated: attachment.truncated,
                noResults: attachment.path === '#no-results',
                maxCells: this.lightdashConfig.query.csvCellsLimit,
                host: this.lightdashConfig.siteUrl,
                schedulerUrl,
                expirationDays,
                includeLinks,
            },
            text: title,
        });
    }

    public async sendDashboardCsvNotificationEmail(
        recipient: string,
        subject: string,
        title: string,
        description: string,
        message: string | undefined,
        date: string,
        frequency: string,
        attachments: AttachmentUrl[],
        url: string,
        schedulerUrl: string,
        includeLinks: boolean,
        expirationDays?: number,
    ) {
        const csvUrls = attachments.filter(
            (attachment) => !attachment.truncated,
        );

        const truncatedCsvUrls = attachments.filter(
            (attachment) => attachment.truncated,
        );

        return this.sendEmail({
            to: recipient,
            subject,
            template: 'dashboardCsvNotification',
            context: {
                title,
                description,
                hasMessage: !!message,
                message: message && marked(message),
                date,
                frequency,
                csvUrls,
                truncatedCsvUrls,
                truncated: truncatedCsvUrls.length > 0,
                maxCells: this.lightdashConfig.query.csvCellsLimit,
                url,
                host: this.lightdashConfig.siteUrl,
                schedulerUrl,
                expirationDays,
                includeLinks,
            },
            text: title,
        });
    }

    async sendOneTimePasscodeEmail({
        recipient,
        passcode,
    }: {
        recipient: string;
        passcode: string;
    }): Promise<void> {
        const subject = 'Verify your email address';
        const text = `
        Verify your email address by entering the following passcode in Lightdash: ${passcode}
            `;
        return this.sendEmail({
            to: recipient,
            subject,
            template: 'oneTimePasscode',
            context: {
                passcode,
                title: subject,
                host: this.lightdashConfig.siteUrl,
            },
            text,
        });
    }

    public async sendGenericNotificationEmail(
        to: string[],
        subject: string,
        title: string,
        message: string,
        attachments?: Mail.Attachment[],
    ) {
        return this.sendEmail({
            to,
            subject,
            template: 'genericNotification',
            context: {
                title,
                message: marked(message),
                host: this.lightdashConfig.siteUrl,
            },
            text: `${title}\n\n${message}`,
            attachments,
        });
    }
}
