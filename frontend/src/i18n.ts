import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import Backend from "i18next-http-backend";
import LanguageDetector from "i18next-browser-languagedetector";

void i18n
    .use(Backend)
    .use(LanguageDetector)
    .use(initReactI18next)
    .init({
        fallbackLng: "zh",
        debug: false,
        // 语言包目录只有 en / zh：浏览器上报 zh-CN、en-US 等带地区码的语言时，
        // 统一按主语言加载，避免请求 /locales/zh-CN/... 产生 404 并回退。
        load: "languageOnly",
        supportedLngs: ["en", "zh"],
        nonExplicitSupportedLngs: true,
        ns:
            [
                "common",
                "errors",
                "hosts",
                "keys",
                "portForwarding",
                "settings",
                "sftp",
                "terminal",
                "update"
            ],
        defaultNS: "common",
        interpolation: {
            escapeValue: false,
        },
        backend: {
            loadPath: "/locales/{{lng}}/{{ns}}.json",
        },
    });

export default i18n;