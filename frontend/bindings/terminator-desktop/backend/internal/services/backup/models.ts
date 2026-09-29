export class BackupFileInfo {
    "fileName": string;
    "username": string;
    "appVersion": string;
    "exportedAt": string;
    "itemCount": number;

    /** Creates a new BackupFileInfo instance. */
    constructor($$source: Partial<BackupFileInfo> = {}) {
        if (!("fileName" in $$source)) {
            this["fileName"] = "";
        }
        if (!("username" in $$source)) {
            this["username"] = "";
        }
        if (!("appVersion" in $$source)) {
            this["appVersion"] = "";
        }
        if (!("exportedAt" in $$source)) {
            this["exportedAt"] = "";
        }
        if (!("itemCount" in $$source)) {
            this["itemCount"] = 0;
        }

        Object.assign(this, $$source);
    }

    static createFrom($$source: any = {}): BackupFileInfo {
        return new BackupFileInfo($$source);
    }
}
