import { ReactNode } from "react";
import { cn } from "@/lib/utils";

interface SettingsCardProps {
    title: string;
    description?: string;
    children: ReactNode;
}

/** 设置分区：发丝线边框 + 表面分层，标题独立成栏 */
export function SettingsCard({ title, description, children }: SettingsCardProps) {
    return (
        <section className="settings-section">
            <div className="settings-section-head">
                <h3 className="settings-section-title">{title}</h3>
                {description && <p className="settings-section-desc">{description}</p>}
            </div>
            <div className="settings-section-body">
                {children}
            </div>
        </section>
    );
}

interface SettingsRowProps {
    title: string;
    desc?: string;
    /** 危险操作：标题使用警示色 */
    danger?: boolean;
    /** 命令面板定位用的稳定 id */
    id?: string;
    children: ReactNode;
}

/** 设置行：左侧标签块 + 右侧控件，相邻行以发丝线分隔 */
export function SettingsRow({ title, desc, danger, id, children }: SettingsRowProps) {
    return (
        <div id={id} className="settings-row">
            <div className="settings-row-label">
                <span className={cn("settings-row-title", danger && "is-danger")}>{title}</span>
                {desc && <span className="settings-row-desc">{desc}</span>}
            </div>
            <div className="settings-row-control">
                {children}
            </div>
        </div>
    );
}

interface SettingsSwitchProps {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label?: string;
    /** 操作进行中时禁用，避免连点产生并发请求 */
    disabled?: boolean;
}

export function SettingsSwitch({ checked, onChange, label, disabled }: SettingsSwitchProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            disabled={disabled}
            onClick={() => onChange(!checked)}
            className={cn("settings-switch", checked && "is-on", disabled && "opacity-60")}
        >
            <span className="settings-switch-knob"/>
        </button>
    );
}

interface SegmentedOption<T> {
    value: T;
    label: string;
}

interface SettingsSegmentedProps<T> {
    value: T;
    options: SegmentedOption<T>[];
    onChange: (value: T) => void;
}

/** 分段控件：用于少量互斥选项（皮肤、密度） */
export function SettingsSegmented<T extends string | number>({ value, options, onChange }: SettingsSegmentedProps<T>) {
    return (
        <div className="settings-seg">
            {options.map((opt) => (
                <button
                    key={String(opt.value)}
                    type="button"
                    aria-pressed={value === opt.value}
                    onClick={() => onChange(opt.value)}
                    className={cn("settings-seg-btn", value === opt.value && "is-active")}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    );
}

interface SettingsStepperProps {
    value: number;
    min: number;
    max: number;
    /** 步长，支持小数（行高用 0.1） */
    step?: number;
    /** 数值展示格式化，默认直接显示数字 */
    format?: (value: number) => string;
    onChange: (value: number) => void;
    label?: string;
}

/** 数值步进器：小范围连续调整（字号、行高） */
export function SettingsStepper({ value, min, max, step = 1, format, onChange, label }: SettingsStepperProps) {
    const move = (direction: 1 | -1) => {
        // 浮点步长（0.1）直接用加减会出现 1.4000000000000001，统一按两位小数收敛
        const next = Number((value + direction * step).toFixed(2));
        onChange(Math.min(max, Math.max(min, next)));
    };
    return (
        <div className="settings-stepper" role="group" aria-label={label}>
            <button
                type="button"
                className="settings-stepper-btn"
                onClick={() => move(-1)}
                disabled={value <= min}
                aria-label={label ? `${label} −` : "−"}
            >
                −
            </button>
            <span className="settings-stepper-value">{format ? format(value) : value}</span>
            <button
                type="button"
                className="settings-stepper-btn"
                onClick={() => move(1)}
                disabled={value >= max}
                aria-label={label ? `${label} +` : "+"}
            >
                +
            </button>
        </div>
    );
}