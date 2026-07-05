export class GitHubReleaseInfo {
    "hasUpdate": boolean;
    "latestVersion": string;
    "currentVersion": string;
    "publishedAt": string;
    "releaseNotes": string;
    "htmlUrl": string;

    /** Creates a new GitHubReleaseInfo instance. */
    constructor($$source: Partial<GitHubReleaseInfo> = {}) {
        if (!("hasUpdate" in $$source)) {
            this["hasUpdate"] = false;
        }
        if (!("latestVersion" in $$source)) {
            this["latestVersion"] = "";
        }
        if (!("currentVersion" in $$source)) {
            this["currentVersion"] = "";
        }
        if (!("publishedAt" in $$source)) {
            this["publishedAt"] = "";
        }
        if (!("releaseNotes" in $$source)) {
            this["releaseNotes"] = "";
        }
        if (!("htmlUrl" in $$source)) {
            this["htmlUrl"] = "";
        }

        Object.assign(this, $$source);
    }

    static createFrom($$source: any = {}): GitHubReleaseInfo {
        return new GitHubReleaseInfo($$source);
    }
}

export class UpdateInfo {
    "isAvailable": boolean;
    "version": string;

    /** Creates a new UpdateInfo instance. */
    constructor($$source: Partial<UpdateInfo> = {}) {
        if (!("isAvailable" in $$source)) {
            this["isAvailable"] = false;
        }
        if (!("version" in $$source)) {
            this["version"] = "";
        }

        Object.assign(this, $$source);
    }

    static createFrom($$source: any = {}): UpdateInfo {
        return new UpdateInfo($$source);
    }
}
