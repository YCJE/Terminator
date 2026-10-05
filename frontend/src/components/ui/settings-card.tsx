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
    children: ReactNode;
}

/** 设置行：左侧标签块 + 右侧控件，相邻行以发丝线分隔 */
export function SettingsRow({ title, desc, danger, children }: SettingsRowProps) {
    return (
        <div className="settings-row">
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
}

export function SettingsSwitch({ checked, onChange, label }: SettingsSwitchProps) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            className={cn("settings-switch", checked && "is-on")}
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
                    onClick={() => onChange(opt.value)}
                    className={cn("settings-seg-btn", value === opt.value && "is-active")}
                >
                    {opt.label}
                </button>
            ))}
        </div>
    );
}