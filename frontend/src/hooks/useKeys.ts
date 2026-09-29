import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { KeyService, HostService } from "../../bindings/terminator-desktop/backend/internal/services/blob";
import { SavedKey } from "../../bindings/terminator-desktop/backend/internal/services/blob";
import { HOSTS_QUERY_KEY } from "@/hooks/useHosts";
import { handleAppError } from "@/lib/error";

export const KEYS_QUERY_KEY = ["keys"];

export function useKeys() {
    return useQuery<SavedKey[], Error>({
        queryKey: KEYS_QUERY_KEY,
        queryFn: async () => KeyService.GetAll()
    });
}

export function useSaveKey() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (key: SavedKey) => {
            await KeyService.Save(key)
        },
        onSuccess: () => queryClient.invalidateQueries({queryKey: KEYS_QUERY_KEY}),
        onError: (error) => {
            handleAppError(error);
        },
    });
}

export function useDeleteKey() {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (id: string) => {
            // 删除前先解除主机对该密钥的引用：残留的 keyId 会让主机连接时
            // 找不到私钥而静默降级为弹出密码框，用户难以判断原因
            const hosts = await HostService.GetAll();
            const dependents = hosts.filter((h) => h.keyId === id);
            for (const dep of dependents) {
                await HostService.Save({ ...dep, keyId: "" });
            }
            await KeyService.Delete(id)
        },
        onSuccess: () => {
            queryClient.invalidateQueries({queryKey: KEYS_QUERY_KEY});
            queryClient.invalidateQueries({queryKey: HOSTS_QUERY_KEY});
        },
        onError: (error) => {
            handleAppError(error);
        },
    });
}