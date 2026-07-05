// SFTP 传输相关事件常量与数据结构

/** 传输进度事件：后端在文件传输过程中周期性发出 */
export const SFTP_PROGRESS_EVENT = "sftp:progress";

/** 传输完成事件：后端在文件传输结束（成功或失败）时发出 */
export const SFTP_COMPLETE_EVENT = "sftp:complete";

/** 进度事件携带的数据 */
export interface SftpProgressData {
    transferId: string;
    transferred: number;
    total: number;
}

/** 完成事件携带的数据 */
export interface SftpCompleteData {
    transferId: string;
    success: boolean;
    error?: string;
}
