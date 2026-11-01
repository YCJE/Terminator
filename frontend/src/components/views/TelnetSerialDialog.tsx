// Telnet / 串口会话对话框。
//
// 两类连接都是一次性的：参数不保存到主机列表，只在内存里对应一个终端会话。
// Telnet 用于交换机/路由器等网络设备，串口用于本地开发板与硬件调试。

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Cable, RefreshCw, Usb } from "lucide-react";
import { toast } from "sonner";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { TERMINAL_ENCODINGS } from "@/lib/terminalEncoding";
import { useSessionStore } from "@/store/sessionStore";
import {
    SerialConfig,
    Service as NetConnService,
} from "../../../bindings/terminator-desktop/backend/internal/services/netconn";

interface TelnetSerialDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

type Mode = "telnet" | "serial";

/** 常见波特率：允许手工输入，这里只作为快捷选择 */
const BAUD_RATES = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const DATA_BITS = [5, 6, 7, 8];
const STOP_BITS = [1, 2];
const PARITIES = ["none", "odd", "even"] as const;

export function TelnetSerialDialog({ isOpen, onClose }: TelnetSerialDialogProps) {
    const { t } = useTranslation("terminal");
    const addNetConnSession = useSessionStore((s) => s.addNetConnSession);

    const [mode, setMode] = useState<Mode>("telnet");
    const [title, setTitle] = useState("");
    // Telnet
    const [host, setHost] = useState("");
    const [port, setPort] = useState("23");
    // 串口
    const [ports, setPorts] = useState<string[]>([]);
    const [device, setDevice] = useState("");
    const [baudRate, setBaudRate] = useState("115200");
    const [dataBits, setDataBits] = useState("8");
    const [stopBits, setStopBits] = useState("1");
    const [parity, setParity] = useState<string>("none");
    const [encoding, setEncoding] = useState("utf-8");
    const [loadingPorts, setLoadingPorts] = useState(false);

    const loadPorts = async () => {
        setLoadingPorts(true);
        try {
            const list = (await NetConnService.ListSerialPorts()) ?? [];
            setPorts(list);
            // 只在用户尚未填写时自动选中第一个可用设备
            setDevice((current) => current || list[0] || "");
        } catch (err) {
            toast.error(t("netconn_ports_failed"), {
                description: String((err as Error)?.message ?? err),
            });
        } finally {
            setLoadingPorts(false);
        }
    };

    // 每次打开重置表单，并刷新串口列表（设备可能刚插入）
    useEffect(() => {
        if (!isOpen) return;
        setMode("telnet");
        setTitle("");
        setHost("");
        setPort("23");
        setBaudRate("115200");
        setDataBits("8");
        setStopBits("1");
        setParity("none");
        setEncoding("utf-8");
        void loadPorts();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isOpen]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (mode === "telnet") {
            const cleanHost = host.trim();
            const parsedPort = Number(port.trim());
            if (!cleanHost) {
                toast.error(t("netconn_invalid_host"));
                return;
            }
            if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
                toast.error(t("netconn_invalid_port"));
                return;
            }
            addNetConnSession({
                kind: "telnet",
                host: cleanHost,
                port: parsedPort,
                encoding,
                title: title.trim() || undefined,
            });
        } else {
            const cleanDevice = device.trim();
            if (!cleanDevice) {
                toast.error(t("netconn_invalid_serial"));
                return;
            }
            addNetConnSession({
                kind: "serial",
                serial: new SerialConfig({
                    device: cleanDevice,
                    baudRate: Number(baudRate) || 115200,
                    dataBits: Number(dataBits) || 8,
                    stopBits: Number(stopBits) || 1,
                    parity,
                }),
                encoding,
                title: title.trim() || undefined,
            });
        }
        onClose();
    };

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <div className="mb-2 flex size-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
                        {mode === "telnet" ? <Cable className="size-5"/> : <Usb className="size-5"/>}
                    </div>
                    <DialogTitle>{t("netconn_title")}</DialogTitle>
                    <DialogDescription>{t("netconn_desc")}</DialogDescription>
                </DialogHeader>

                {/* 模式切换：两个一次性连接共用同一套对话框 */}
                <div className="grid grid-cols-2 gap-1 rounded-[var(--radius-md)] bg-[var(--surface-2)] p-1">
                    {(["telnet", "serial"] as const).map((item) => (
                        <button
                            key={item}
                            type="button"
                            onClick={() => setMode(item)}
                            className={cn(
                                "rounded-[var(--radius-sm)] px-3 py-1.5 text-xs transition-colors",
                                mode === item
                                    ? "bg-[var(--surface-0)] text-[var(--fg-strong)] shadow-[var(--shadow-sm)]"
                                    : "text-[var(--fg-muted)] hover:text-[var(--fg-strong)]",
                            )}
                        >
                            {item === "telnet" ? t("netconn_tab_telnet") : t("netconn_tab_serial")}
                        </button>
                    ))}
                </div>

                <form onSubmit={handleSubmit} className="grid gap-3 py-1">
                    {mode === "telnet" ? (
                        <div className="grid grid-cols-[1fr_96px] gap-3">
                            <div className="grid gap-1.5">
                                <Label htmlFor="nc-host">{t("netconn_host_label")}</Label>
                                <Input
                                    id="nc-host"
                                    value={host}
                                    onChange={(e) => setHost(e.target.value)}
                                    placeholder={t("netconn_host_placeholder")}
                                    autoComplete="off"
                                    spellCheck={false}
                                    autoFocus
                                />
                            </div>
                            <div className="grid gap-1.5">
                                <Label htmlFor="nc-port">{t("netconn_port_label")}</Label>
                                <Input
                                    id="nc-port"
                                    value={port}
                                    onChange={(e) => setPort(e.target.value)}
                                    placeholder="23"
                                    inputMode="numeric"
                                    autoComplete="off"
                                />
                            </div>
                        </div>
                    ) : (
                        <>
                            <div className="grid gap-1.5">
                                <Label htmlFor="nc-device">{t("netconn_serial_port_label")}</Label>
                                <div className="flex gap-2">
                                    <Input
                                        id="nc-device"
                                        list="netconn-serial-ports"
                                        value={device}
                                        onChange={(e) => setDevice(e.target.value)}
                                        placeholder={ports.length > 0 ? ports[0] : "COM3"}
                                        autoComplete="off"
                                        spellCheck={false}
                                        autoFocus
                                    />
                                    <datalist id="netconn-serial-ports">
                                        {ports.map((item) => <option key={item} value={item}/>)}
                                    </datalist>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={() => void loadPorts()}
                                        disabled={loadingPorts}
                                        title={t("netconn_serial_refresh")}
                                    >
                                        <RefreshCw className={cn("size-3.5", loadingPorts && "animate-spin")}/>
                                    </Button>
                                </div>
                                {ports.length === 0 && !loadingPorts && (
                                    <p className="text-[11px] text-[var(--fg-subtle)]">
                                        {t("netconn_no_serial_ports")}
                                    </p>
                                )}
                            </div>

                            <div className="grid grid-cols-2 gap-3">
                                <div className="grid gap-1.5">
                                    <Label htmlFor="nc-baud">{t("netconn_baud_label")}</Label>
                                    <Input
                                        id="nc-baud"
                                        list="netconn-baud-rates"
                                        value={baudRate}
                                        onChange={(e) => setBaudRate(e.target.value)}
                                        inputMode="numeric"
                                        autoComplete="off"
                                    />
                                    <datalist id="netconn-baud-rates">
                                        {BAUD_RATES.map((rate) => (
                                            <option key={rate} value={rate}/>
                                        ))}
                                    </datalist>
                                </div>
                                <div className="grid gap-1.5">
                                    <Label htmlFor="nc-parity">{t("netconn_parity_label")}</Label>
                                    <select
                                        id="nc-parity"
                                        value={parity}
                                        onChange={(e) => setParity(e.target.value)}
                                        className="h-9 rounded-[var(--radius-md)] border border-[var(--hairline)]
                                                   bg-[var(--surface-2)] px-3 text-sm text-[var(--fg-strong)]
                                                   outline-none focus-visible:border-[var(--focus-ring)]"
                                    >
                                        {PARITIES.map((item) => (
                                            <option key={item} value={item}>
                                                {t(`netconn_parity_${item}`)}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                                <div className="grid gap-1.5">
                                    <Label htmlFor="nc-data">{t("netconn_databits_label")}</Label>
                                    <select
                                        id="nc-data"
                                        value={dataBits}
                                        onChange={(e) => setDataBits(e.target.value)}
                                        className="h-9 rounded-[var(--radius-md)] border border-[var(--hairline)]
                                                   bg-[var(--surface-2)] px-3 text-sm text-[var(--fg-strong)]
                                                   outline-none focus-visible:border-[var(--focus-ring)]"
                                    >
                                        {DATA_BITS.map((item) => (
                                            <option key={item} value={item}>{item}</option>
                                        ))}
                                    </select>
                                </div>
                                <div className="grid gap-1.5">
                                    <Label htmlFor="nc-stop">{t("netconn_stopbits_label")}</Label>
                                    <select
                                        id="nc-stop"
                                        value={stopBits}
                                        onChange={(e) => setStopBits(e.target.value)}
                                        className="h-9 rounded-[var(--radius-md)] border border-[var(--hairline)]
                                                   bg-[var(--surface-2)] px-3 text-sm text-[var(--fg-strong)]
                                                   outline-none focus-visible:border-[var(--focus-ring)]"
                                    >
                                        {STOP_BITS.map((item) => (
                                            <option key={item} value={item}>{item}</option>
                                        ))}
                                    </select>
                                </div>
                            </div>
                        </>
                    )}

                    <div className="grid grid-cols-2 gap-3">
                        <div className="grid gap-1.5">
                            <Label htmlFor="nc-title">{t("netconn_title_label")}</Label>
                            <Input
                                id="nc-title"
                                value={title}
                                onChange={(e) => setTitle(e.target.value)}
                                placeholder={t("netconn_title_placeholder")}
                                autoComplete="off"
                            />
                        </div>
                        <div className="grid gap-1.5">
                            <Label htmlFor="nc-encoding">{t("encoding_label", {ns: "hosts"})}</Label>
                            <select
                                id="nc-encoding"
                                value={encoding}
                                onChange={(e) => setEncoding(e.target.value)}
                                className="h-9 rounded-[var(--radius-md)] border border-[var(--hairline)]
                                           bg-[var(--surface-2)] px-3 text-sm text-[var(--fg-strong)]
                                           outline-none focus-visible:border-[var(--focus-ring)]"
                            >
                                {TERMINAL_ENCODINGS.map((item) => (
                                    <option key={item.value} value={item.value}>
                                        {item.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                    <p className="-mt-1 text-[11px] text-[var(--fg-subtle)]">
                        {t("encoding_desc", {ns: "hosts"})}
                    </p>

                    <div className="mt-1 flex justify-end gap-2">
                        <Button type="button" variant="outline" onClick={onClose}>
                            {t("cancel", {ns: "common"})}
                        </Button>
                        <Button type="submit">
                            {t("connect", {ns: "common"})}
                        </Button>
                    </div>
                </form>
            </DialogContent>
        </Dialog>
    );
}
