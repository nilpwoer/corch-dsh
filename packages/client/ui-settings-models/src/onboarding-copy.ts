/** Durable settings namespace for product-wide GUI onboarding facts. */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'

/** Field storing the last welcome notice version the user acknowledged. */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
export const WELCOME_NOTICE_VERSION = '2026-08-13.1'

/** The complete editable internal-testing notice in both supported GUI locales. */
export const WELCOME_NOTICE_COPY = {
  zh: {
    title: '欢迎使用 Corch DSH',
    body: '准备专家信息，生成并校阅问题包，再发布给专家完成访谈。\n\n首次发布前，请在访谈设置中填写 Worker 地址和发布 API Key。生成问题包还需单独配置模型。',
    continueLabel: '继续',
  },
  en: {
    title: 'Welcome to Corch DSH',
    body: 'Prepare expert information, review the generated questions, and publish an interview for the expert.\n\nBefore publishing, configure the Worker address and publishing API Key in interview settings. Question generation requires a separately configured model.',
    continueLabel: 'Continue',
  },
} as const
