/** `sidebar` namespace dictionaries: shell controls and App Rail labels. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'session.new': '新会话',
  'session.new.label': '新建会话',
  'toggle.open': '打开侧边栏',
  'toggle.collapse': '收起侧边栏',
  'appRail.label': '应用导航',
  'appRail.sessions': '原生会话',
  'appRail.creator': '内容创作（已移除）',
  'appRail.projects': '项目（已移除）',
  'appRail.curriculum': '课程建设',
  'appRail.interviews': '专家访谈',
  'appRail.jdSearch': 'JD 搜索',
  'appRail.settings': '设置',
} satisfies Record<string, string>

/** The sidebar namespace key union. */
export type SidebarKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'session.new': 'New Session',
  'session.new.label': 'New session',
  'toggle.open': 'Open sidebar',
  'toggle.collapse': 'Collapse sidebar',
  'appRail.label': 'App navigation',
  'appRail.sessions': 'Native sessions',
  'appRail.creator': 'Content creator (removed)',
  'appRail.projects': 'Projects (removed)',
  'appRail.curriculum': 'Curriculum builder',
  'appRail.interviews': 'Expert interviews',
  'appRail.jdSearch': 'JD search',
  'appRail.settings': 'Settings',
} satisfies Record<SidebarKey, string>
