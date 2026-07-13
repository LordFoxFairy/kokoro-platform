"use client";

// React 绑定：LocaleProvider（协商初值 + 持久化切换）+ useT/useLocale。
// 引擎（协商/解析/插值）来自共享窄包 @kokoro/i18n；此处只做 React/存储副作用。

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { createI18n, type TranslateFn } from "@kokoro/i18n";
import { DEFAULT_LOCALE, LOCALES, LOCALE_STORAGE_KEY, zh, type Locale, type MessageKey } from "./messages";
import { en } from "./en";

const i18n = createI18n<Locale, MessageKey>({
  locales: LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  source: zh,
  overrides: { en },
});

interface LocaleContextValue {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: TranslateFn<MessageKey>;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  // SSR 与水合首帧保持默认，挂载后按持久化偏好/浏览器语言协商，避免注水不一致。
  const [mounted, setMounted] = useState(false);
  const [override, setOverride] = useState<Locale | null>(null);
  useEffect(() => setMounted(true), []);

  const negotiated = mounted
    ? i18n.negotiate(window.localStorage.getItem(LOCALE_STORAGE_KEY), navigator.languages)
    : DEFAULT_LOCALE;
  const locale = override ?? negotiated;

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setOverride(next);
    if (typeof window !== "undefined") window.localStorage.setItem(LOCALE_STORAGE_KEY, next);
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: (key, vars) => i18n.translate(locale, key, vars) }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (ctx === null) throw new Error("useLocale must be used within LocaleProvider");
  return ctx;
}

export function useT(): TranslateFn<MessageKey> {
  return useLocale().t;
}
