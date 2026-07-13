import { create } from "zustand";
import { Snippet, SnippetService } from "../../bindings/terminator-desktop/backend/internal/services/blob";

interface SnippetState {
    /** 所有代码片段 */
    snippets: Snippet[];
    /** 是否正在加载 */
    isLoading: boolean;
    /** 从后端加载所有代码片段 */
    loadSnippets: () => Promise<void>;
    /** 保存（新增或更新）一条代码片段，返回保存后的 ID */
    saveSnippet: (snippet: Partial<Snippet>) => Promise<string>;
    /** 删除一条代码片段 */
    deleteSnippet: (id: string) => Promise<void>;
}

export const useSnippetStore = create<SnippetState>((set, get) => ({
    snippets: [],
    isLoading: false,

    // 从后端加载全部代码片段
    loadSnippets: async () => {
        set({ isLoading: true });
        try {
            const snippets = await SnippetService.GetAll();
            set({ snippets: snippets || [], isLoading: false });
        } catch (error) {
            console.error("加载代码片段失败:", error);
            set({ isLoading: false });
        }
    },

    // 保存代码片段（新增或编辑）
    saveSnippet: async (snippet: Partial<Snippet>) => {
        const id = await SnippetService.Save(snippet as Snippet);
        // 保存成功后重新加载列表
        await get().loadSnippets();
        return id;
    },

    // 删除代码片段
    deleteSnippet: async (id: string) => {
        await SnippetService.Delete(id);
        // 后端删除成功后才更新本地列表，避免 UI 与后端不一致
        set((state) => ({
            snippets: state.snippets.filter((s) => s.id !== id),
        }));
    },
}));
