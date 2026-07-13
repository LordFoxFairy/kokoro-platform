// 共享 i18n 窄包引擎：无第三方库、无 DOM/React，纯 key→string 表 + {插值} + 语言协商。
// 各消费方（admin-web / 未来其它面）注入自己的 locale 集、源词典与增量覆盖，得到一个 translate 函数。
// 三层 fallback 恒不裸露 key：override[locale] → source（源语言全量）→ key 本身。
//
// 单文件 barrel：消费方既有以 TS 源码打包（Next transpilePackages，webpack 不改写 NodeNext 的
// .js 后缀），故不拆内部相对模块，避免跨工具解析差异。

export type InterpolationVars = Readonly<Record<string, string | number>>;

export interface I18nConfig<Locale extends string, Key extends string> {
  // 支持的 locale 全集；协商时的白名单。
  readonly locales: readonly Locale[];
  // 源语言：source 必须是该 locale 的完整词典（所有 key 必在）。
  readonly defaultLocale: Locale;
  // 源语言完整词典（key → 文案）。
  readonly source: Readonly<Record<Key, string>>;
  // 其它 locale 的增量覆盖（Partial）；未覆盖的 key 回退源语言。
  readonly overrides?: Readonly<Partial<Record<Locale, Readonly<Partial<Record<Key, string>>>>>>;
}

export type TranslateFn<Key extends string> = (key: Key, vars?: InterpolationVars) => string;

export interface I18n<Locale extends string, Key extends string> {
  readonly locales: readonly Locale[];
  readonly defaultLocale: Locale;
  // 协商生效 locale：显式偏好（存储值）优先，其次浏览器语言前缀匹配，最后源语言。非法值忽略。
  negotiate(stored: string | null | undefined, navigatorLanguages?: readonly string[]): Locale;
  // 取词：按 locale 解析 + {var} 插值。
  translate(locale: Locale, key: Key, vars?: InterpolationVars): string;
}

// {name} 占位插值；缺失的变量原样保留占位符（暴露漏传比静默吞掉更易发现）。
export function interpolate(template: string, vars?: InterpolationVars): string {
  if (vars === undefined) {
    return template;
  }
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
  );
}

export function createI18n<Locale extends string, Key extends string>(
  config: I18nConfig<Locale, Key>,
): I18n<Locale, Key> {
  const localeSet: ReadonlySet<string> = new Set(config.locales);

  function negotiate(stored: string | null | undefined, navigatorLanguages: readonly string[] = []): Locale {
    if (stored != null && localeSet.has(stored)) {
      return stored as Locale;
    }
    for (const lang of navigatorLanguages) {
      const prefix = lang.toLowerCase().split("-")[0];
      if (prefix !== undefined && localeSet.has(prefix)) {
        return prefix as Locale;
      }
    }
    return config.defaultLocale;
  }

  function translate(locale: Locale, key: Key, vars?: InterpolationVars): string {
    const override = locale === config.defaultLocale ? undefined : config.overrides?.[locale]?.[key];
    const raw = override ?? config.source[key] ?? key;
    return interpolate(raw, vars);
  }

  return { locales: config.locales, defaultLocale: config.defaultLocale, negotiate, translate };
}
