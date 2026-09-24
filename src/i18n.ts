/**
 * A small runtime overlay, not a full translation layer.
 *
 * Honest about what ships: most chrome is still hardcoded English, and missing keys
 * fall back to English rather than rendering a key name. New chrome should go through
 * t() so the overlay can grow (HB-UIUX-001 s10).
 */

export const LOCALES = ['en', 'de', 'es', 'fr', 'hi', 'ja', 'pt-br', 'zh'] as const;
export type Locale = (typeof LOCALES)[number];

type Catalog = Record<string, string>;

const en: Catalog = {
  'app.newBot': 'New bot',
  'app.search': 'Search',
  'app.settings': 'Settings',
  'app.send': 'Send',
  'app.allow': 'Allow once',
  'app.deny': 'Deny',
  'app.alwaysAllow': 'Always allow',
  'app.connect': 'Connect',
  'app.openDesktop': 'Open desktop',
  'app.working': 'Working',
  'app.waiting': 'Waiting on you',
  'app.idle': 'Idle',
  'noEngines.title': 'No agent CLI found',
  'noEngines.body':
    'HarnessBot runs agent CLIs that are already on this computer. Install one, or point HarnessBot at an existing binary.',
  'noEngines.action': 'Open Settings -> Engines',
  'engines.title': 'Engines',
  'engines.unavailable': 'Unavailable',
  'sidebar.pinned': 'Pinned',
  'sidebar.channels': 'Channels',
  'sidebar.bots': 'Bots',
  'sidebar.workspace': 'Workspace',
  'composer.placeholder': 'Message {name}',
  'composer.changeModel': 'Change model',
  'composer.searchModels': 'Search Hermes, CLIs and added models',
};

const overlays: Partial<Record<Locale, Catalog>> = {
  de: {
    'app.newBot': 'Neuer Bot',
    'app.search': 'Suchen',
    'app.settings': 'Einstellungen',
    'app.send': 'Senden',
    'app.allow': 'Einmal erlauben',
    'app.deny': 'Ablehnen',
    'app.alwaysAllow': 'Immer erlauben',
    'app.working': 'Arbeitet',
    'app.waiting': 'Wartet auf dich',
    'noEngines.title': 'Keine Agent-CLI gefunden',
    'engines.title': 'Engines',
    'engines.unavailable': 'Nicht verfügbar',
    'sidebar.bots': 'Bots',
    'composer.placeholder': 'Nachricht an {name}',
  },
  es: {
    'app.newBot': 'Nuevo bot',
    'app.search': 'Buscar',
    'app.settings': 'Ajustes',
    'app.send': 'Enviar',
    'app.allow': 'Permitir una vez',
    'app.deny': 'Denegar',
    'app.alwaysAllow': 'Permitir siempre',
    'app.working': 'Trabajando',
    'app.waiting': 'Esperándote',
    'noEngines.title': 'No se encontró ninguna CLI de agente',
    'engines.unavailable': 'No disponible',
    'composer.placeholder': 'Mensaje para {name}',
  },
  fr: {
    'app.newBot': 'Nouveau bot',
    'app.search': 'Rechercher',
    'app.settings': 'Paramètres',
    'app.send': 'Envoyer',
    'app.allow': 'Autoriser une fois',
    'app.deny': 'Refuser',
    'app.alwaysAllow': 'Toujours autoriser',
    'app.working': 'En cours',
    'app.waiting': 'En attente de vous',
    'engines.unavailable': 'Indisponible',
    'composer.placeholder': 'Message à {name}',
  },
  hi: {
    'app.newBot': 'नया बॉट',
    'app.search': 'खोजें',
    'app.settings': 'सेटिंग्स',
    'app.send': 'भेजें',
    'app.allow': 'एक बार अनुमति दें',
    'app.deny': 'अस्वीकार करें',
    'app.working': 'काम कर रहा है',
    'engines.unavailable': 'अनुपलब्ध',
    'composer.placeholder': '{name} को संदेश',
  },
  ja: {
    'app.newBot': '新しいボット',
    'app.search': '検索',
    'app.settings': '設定',
    'app.send': '送信',
    'app.allow': '一度だけ許可',
    'app.deny': '拒否',
    'app.working': '作業中',
    'engines.unavailable': '利用不可',
    'composer.placeholder': '{name} にメッセージ',
  },
  'pt-br': {
    'app.newBot': 'Novo bot',
    'app.search': 'Buscar',
    'app.settings': 'Configurações',
    'app.send': 'Enviar',
    'app.allow': 'Permitir uma vez',
    'app.deny': 'Negar',
    'app.working': 'Trabalhando',
    'engines.unavailable': 'Indisponível',
    'composer.placeholder': 'Mensagem para {name}',
  },
  zh: {
    'app.newBot': '新建机器人',
    'app.search': '搜索',
    'app.settings': '设置',
    'app.send': '发送',
    'app.allow': '允许一次',
    'app.deny': '拒绝',
    'app.working': '工作中',
    'engines.unavailable': '不可用',
    'composer.placeholder': '发消息给 {name}',
  },
};

let active: Locale = 'en';

export function setLocale(language: string): void {
  // Empty config.language follows the OS. `pt` is an alias for pt-br.
  const raw = (language || navigator.language || 'en').toLowerCase();
  const normalized = raw === 'pt' ? 'pt-br' : raw;
  active =
    (LOCALES.find((l) => l === normalized) ?? LOCALES.find((l) => normalized.startsWith(l)) ?? 'en') as Locale;
}

export function t(key: string, vars?: Record<string, string>): string {
  const value = overlays[active]?.[key] ?? en[key] ?? key;
  return vars ? value.replace(/\{(\w+)\}/g, (_m, name: string) => vars[name] ?? '') : value;
}

/** Keys the overlay is expected to carry. `pnpm i18n:check` reads this. */
export const REQUIRED_KEYS = Object.keys(en);
export const CATALOGS = { en, ...overlays } as Record<string, Catalog>;
